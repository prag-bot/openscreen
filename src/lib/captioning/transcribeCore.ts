import type { TrimRegion } from "@/components/video-editor/types";
import type { CaptionSegment, TranscribeMono16kResult } from "./transcribe";

/**
 * Pure transcription algorithm for the captioning Web Worker: takes a built Whisper
 * `transcriber` and turns mono 16 kHz audio into timed caption segments. No DOM or
 * Transformers.js imports so it runs in a worker and unit-tests in isolation.
 */

/** A Transformers.js automatic-speech-recognition pipeline call. */
export type TranscriberFn = (
	audio: Float32Array,
	opts: Record<string, unknown>,
) => Promise<unknown>;

function segmentOverlapsTrim(startMs: number, endMs: number, trims: TrimRegion[]): boolean {
	return trims.some((t) => startMs < t.endMs && endMs > t.startMs);
}

/** Same trim-out rule as {@link segmentsFromTranscriberChunks}; for retry passes that used empty trims. */
function dropSegmentsOverlappingTrimRegions(
	segments: CaptionSegment[],
	trimRegions: TrimRegion[],
): CaptionSegment[] {
	if (trimRegions.length === 0) return segments;
	return segments.filter((s) => {
		const startMs = Math.round(s.startSec * 1000);
		const endMs = Math.round(s.endSec * 1000);
		return !segmentOverlapsTrim(startMs, endMs, trimRegions);
	});
}

/** Whisper runs with internal 30s chunks; keep each forward pass bounded for WASM memory. */
const TRANSCRIBE_SLICE_SAMPLES = 12 * 60 * 16_000;

/** Very short slices are skipped in the multi-slice loop unless padded (see `padTailSliceForTranscribe`). */
const MIN_TRANSCRIBE_SLICE_SAMPLES = 800;
/** Permit bounded decoder-grid tail rounding, never a grossly out-of-range model span. */
const MAX_FINITE_END_OVERRUN_SEC = 0.1;

class InvalidTranscriptionTimingError extends Error {
	constructor() {
		super(
			"Speech was recognized, but the local model returned invalid timestamps. No edit was made. Retry transcription.",
		);
		this.name = "InvalidTranscriptionTimingError";
	}
}

/**
 * Pad a short tail slice so Whisper still runs; timestamps are clamped with `realDurationSec` so
 * padding does not extend perceived audio on the timeline.
 */
function padTailSliceForTranscribe(samples: Float32Array): {
	slice: Float32Array;
	realDurationSec: number;
} {
	const realDurationSec = samples.length / 16_000;
	if (samples.length >= MIN_TRANSCRIBE_SLICE_SAMPLES) {
		return { slice: samples, realDurationSec };
	}
	const padded = new Float32Array(MIN_TRANSCRIBE_SLICE_SAMPLES);
	padded.set(samples);
	return { slice: padded, realDurationSec };
}

/** Reject a malformed pass as a whole so retries can recover every recognized word. */
function segmentsFromTranscriberChunks(
	chunks: Array<{ timestamp?: [number | null, number | null]; text?: unknown }>,
	timeOffsetSec: number,
	trims: TrimRegion[],
	audioDurationSec: number,
): CaptionSegment[] {
	const recognized = chunks.flatMap((chunk) => {
		const text = String(chunk?.text ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) return [];
		const timestamp = chunk.timestamp;
		if (!Array.isArray(timestamp) || timestamp.length !== 2)
			throw new InvalidTranscriptionTimingError();
		const start = timestamp[0] === null ? 0 : timestamp[0];
		const end = timestamp[1];
		if (
			typeof start !== "number" ||
			!Number.isFinite(start) ||
			start < 0 ||
			start > audioDurationSec ||
			(start === audioDurationSec && end !== null && end !== start) ||
			(end !== null &&
				(typeof end !== "number" ||
					!Number.isFinite(end) ||
					end < start ||
					end > audioDurationSec + MAX_FINITE_END_OVERRUN_SEC))
		)
			throw new InvalidTranscriptionTimingError();
		return [{ start, end, text }];
	});
	for (let index = 1; index < recognized.length; index++)
		if (recognized[index].start < recognized[index - 1].start)
			throw new InvalidTranscriptionTimingError();
	const resolved = recognized.map((chunk, index) => ({
		...chunk,
		end: Math.min(chunk.end ?? recognized[index + 1]?.start ?? audioDurationSec, audioDurationSec),
	}));
	const timed: Array<{ start: number; end: number; text: string }> = [];
	for (let index = 0; index < resolved.length; index++) {
		const chunk = resolved[index];
		if (chunk.end < chunk.start) throw new InvalidTranscriptionTimingError();
		if (chunk.end > chunk.start) {
			timed.push({ ...chunk });
			continue;
		}
		let groupEnd = index + 1;
		while (groupEnd < resolved.length && resolved[groupEnd].start === resolved[groupEnd].end)
			groupEnd += 1;
		const points = resolved.slice(index, groupEnd);
		const next = resolved[groupEnd];
		const previous = timed[timed.length - 1];
		const text = points.map((point) => point.text).join(" ");
		// DTW may assign several tokens to one encoder frame. Keep their text in
		// order inside an adjacent existing positive span, never invent a word cut.
		if (next && next.end > next.start && points.every((point) => point.start === next.start))
			next.text = `${text} ${next.text}`;
		else if (
			previous &&
			points.every((point) => point.start >= previous.start && point.start <= previous.end)
		)
			previous.text = `${previous.text} ${text}`;
		else throw new InvalidTranscriptionTimingError();
		index = groupEnd - 1;
	}

	const segments: CaptionSegment[] = [];

	for (const { start: a, end: b, text } of timed) {
		const startSec = a + timeOffsetSec;
		const sliceEnd = timeOffsetSec + audioDurationSec;
		const endSec = Math.min(Math.max(startSec + 0.08, b + timeOffsetSec), sliceEnd);
		const startMs = Math.round(startSec * 1000);
		const endMs = Math.round(endSec * 1000);
		if (segmentOverlapsTrim(startMs, endMs, trims)) continue;

		segments.push({ startSec, endSec, text });
	}

	// Starts were checked in recognition order. Equal-start spans and repeated
	// fillers must keep that order and text; downstream overlap unions retain it.
	return segments;
}

/** Runs the transcriber on one audio slice, chunking only long clips. */
async function runTranscriberOnSlice(
	transcriber: TranscriberFn,
	samples: Float32Array,
	opts: { forceFullSequences: boolean; timestampMode: "word" | "phrase" },
): Promise<unknown> {
	const durationSec = samples.length / 16_000;
	// Only chunk long clips; short-audio chunking regressed some Whisper.js runs (empty chunks).
	const chunking = durationSec > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {};
	return transcriber(samples, {
		return_timestamps: opts.timestampMode === "word" ? "word" : true,
		force_full_sequences: opts.forceFullSequences,
		...chunking,
	});
}

/** Flattens the various shapes a Transformers.js ASR result can take into a chunk list. */
function getChunksFromTranscriberResult(result: unknown): Array<{
	timestamp?: [number | null, number | null];
	text?: unknown;
}> {
	if (result == null) return [];
	if (Array.isArray(result)) {
		const out: Array<{ timestamp?: [number | null, number | null]; text?: unknown }> = [];
		for (const item of result) {
			const chunks = (item as { chunks?: unknown })?.chunks;
			if (Array.isArray(chunks)) out.push(...chunks);
		}
		return out;
	}
	const chunks = (result as { chunks?: unknown })?.chunks;
	return Array.isArray(chunks) ? chunks : [];
}

/** Prefer `chunks`; if the model only returned top-level `text`, synthesize one span for timing. */
function extractChunksFromAsrResult(result: unknown): Array<{
	timestamp?: [number | null, number | null];
	text?: unknown;
}> {
	const fromChunks = getChunksFromTranscriberResult(result);
	if (fromChunks.length > 0) return fromChunks;
	const single = Array.isArray(result) ? result[0] : result;
	const text =
		typeof (single as { text?: unknown })?.text === "string"
			? String((single as { text: string }).text).trim()
			: "";
	if (text) {
		return [{ timestamp: [0, null], text }];
	}
	return [];
}

function recognizedWords(text: string): string {
	return (
		text
			.normalize("NFKC")
			.toLowerCase()
			.replace(/['’]/g, "")
			.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
	).join(" ");
}

/** Refine only independently bounded phrases; uncertain wording/timing keeps its coarse span. */
async function refinePhraseTiming(
	transcriber: TranscriberFn,
	samples: Float32Array,
	phrases: CaptionSegment[],
): Promise<TranscribeMono16kResult> {
	const segments: CaptionSegment[] = [];
	let attempted = 0;
	let refined = 0;
	for (const phrase of phrases) {
		const first = Math.ceil(phrase.startSec * 16_000);
		const last = Math.min(samples.length, Math.floor(phrase.endSec * 16_000));
		let words: CaptionSegment[] | undefined;
		if (
			phrase.endSec - phrase.startSec <= 30 &&
			last - first >= MIN_TRANSCRIBE_SLICE_SAMPLES &&
			attempted < 200
		) {
			attempted += 1;
			for (const forceFullSequences of [false]) {
				try {
					const result = await runTranscriberOnSlice(transcriber, samples.subarray(first, last), {
						forceFullSequences,
						timestampMode: "word",
					});
					const chunks = getChunksFromTranscriberResult(result);
					if (!chunks.length) break; // Text alone cannot justify finer boundaries.
					const local = segmentsFromTranscriberChunks(
						chunks,
						first / 16_000,
						[],
						(last - first) / 16_000,
					);
					if (
						!local.length ||
						recognizedWords(local.map((segment) => segment.text).join(" ")) !==
							recognizedWords(phrase.text)
					)
						break;
					if (
						local.some(
							(segment) => segment.startSec < phrase.startSec || segment.endSec > phrase.endSec,
						)
					)
						break;
					words = local;
					break;
				} catch {
					// This phrase retains complete recognized text and its real coarse bounds.
				}
			}
		}
		if (words) {
			segments.push(...words);
			refined += 1;
		} else segments.push({ ...phrase });
	}
	return {
		segments,
		granularity: refined === 0 ? "phrase" : refined === phrases.length ? "word" : "mixed",
	};
}

/**
 * Drives Whisper over (possibly sliced) mono 16 kHz audio and returns timed segments.
 * Long audio is split so one pass doesn't exhaust WASM memory; timestamps are shifted
 * back onto the full timeline. Tries word- then phrase-level timestamps, with a
 * trim-ignoring retry, before giving up.
 */
export async function runTranscription(
	transcriber: TranscriberFn,
	samples: Float32Array,
	trims: TrimRegion[],
): Promise<TranscribeMono16kResult> {
	let invalidTiming: InvalidTranscriptionTimingError | undefined;
	let invalidWordTiming = false;
	let sawValidTimedSpeech = false;
	let resultGranularity: "word" | "phrase" = "phrase";
	const transcribeOne = async (
		ignoreTrims: boolean,
		forceFullSequences: boolean,
		timestampMode: "word" | "phrase",
	): Promise<CaptionSegment[]> => {
		try {
			const activeTrims = ignoreTrims ? [] : trims;
			let passHasSpeech = false;
			let passHasCoarseTiming = false;
			const mapResult = (result: unknown, offset: number, duration: number) => {
				const chunks = extractChunksFromAsrResult(result);
				const mapped = segmentsFromTranscriberChunks(chunks, offset, activeTrims, duration);
				if (chunks.some((chunk) => String(chunk?.text ?? "").trim())) {
					passHasSpeech = true;
					passHasCoarseTiming ||= getChunksFromTranscriberResult(result).length === 0;
				}
				return mapped;
			};
			const completePass = (segments: CaptionSegment[]) => {
				sawValidTimedSpeech ||= passHasSpeech;
				resultGranularity = passHasCoarseTiming ? "phrase" : timestampMode;
				return segments;
			};
			if (samples.length <= TRANSCRIBE_SLICE_SAMPLES) {
				const { slice, realDurationSec } = padTailSliceForTranscribe(samples);
				const result = await runTranscriberOnSlice(transcriber, slice, {
					forceFullSequences,
					timestampMode,
				});
				return completePass(mapResult(result, 0, realDurationSec));
			}

			const all: CaptionSegment[] = [];
			for (let offset = 0; offset < samples.length; offset += TRANSCRIBE_SLICE_SAMPLES) {
				const end = Math.min(offset + TRANSCRIBE_SLICE_SAMPLES, samples.length);
				const sliceRaw = samples.subarray(offset, end);
				const isFinalSlice = end >= samples.length;
				if (sliceRaw.length === 0) continue;
				if (sliceRaw.length < MIN_TRANSCRIBE_SLICE_SAMPLES && !isFinalSlice) continue;

				const { slice, realDurationSec } =
					sliceRaw.length < MIN_TRANSCRIBE_SLICE_SAMPLES && isFinalSlice
						? padTailSliceForTranscribe(sliceRaw)
						: { slice: sliceRaw, realDurationSec: sliceRaw.length / 16_000 };

				const result = await runTranscriberOnSlice(transcriber, slice, {
					forceFullSequences,
					timestampMode,
				});
				const tOff = offset / 16_000;
				all.push(...mapResult(result, tOff, realDurationSec));
			}
			return completePass(all);
		} catch (e) {
			if (e instanceof InvalidTranscriptionTimingError) {
				invalidTiming = e;
				if (timestampMode === "word") invalidWordTiming = true;
			} else console.warn("[captioning] Whisper pass failed:", e);
			return [];
		}
	};

	const attemptModes: Array<"word" | "phrase"> = ["word", "phrase"];
	for (const timestampMode of attemptModes) {
		let segments = await transcribeOne(false, true, timestampMode);
		if (segments.length === 0 && !(timestampMode === "word" && invalidWordTiming)) {
			segments = await transcribeOne(false, false, timestampMode);
		}
		if (
			segments.length === 0 &&
			trims.length > 0 &&
			!(timestampMode === "word" && invalidWordTiming)
		) {
			segments = dropSegmentsOverlappingTrimRegions(
				await transcribeOne(true, true, timestampMode),
				trims,
			);
			if (segments.length === 0) {
				segments = dropSegmentsOverlappingTrimRegions(
					await transcribeOne(true, false, timestampMode),
					trims,
				);
			}
		}
		if (segments.length > 0) {
			return resultGranularity === "phrase"
				? refinePhraseTiming(transcriber, samples, segments)
				: { segments, granularity: resultGranularity };
		}
	}

	if (invalidTiming && !sawValidTimedSpeech) throw invalidTiming;
	return { segments: [], granularity: "phrase" };
}
