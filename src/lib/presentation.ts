export type PresentationMode = "face-only" | "demo";

/** Times use the original screen recording clock, before removal trims. */
export interface PresentationRegion {
	id: string;
	startMs: number;
	endMs: number;
	mode: PresentationMode;
	reason?: string;
}

const MAX_REGIONS = 2_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const AUDIO_WINDOW_MS = 100;
const MIN_AUDIO_RMS = 0.004;
const MIN_AUDIO_PEAK = 0.012;
const MAX_AUDIO_PAUSE_MS = 600;
const MIN_ACTIVE_SHARE = 0.4;
const POINTER_MOVE_THRESHOLD = 0.015;
const DEMO_BEFORE_ACTION_MS = 1_000;
const DEMO_AFTER_ACTION_MS = 5_000;
const MIN_FACE_REGION_MS = 3_000;
const MAX_TELEMETRY_GAP_MS = 2_000;
const TELEMETRY_EDGE_TOLERANCE_MS = 1_000;

function validDuration(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= MAX_DURATION_MS;
}

/** Reject malformed saved/IPC data instead of silently changing the requested edit. */
export function validatePresentationRegions(
	value: unknown,
	durationMs?: number,
): PresentationRegion[] {
	if (value === undefined) return [];
	if (durationMs !== undefined && !validDuration(durationMs))
		throw new Error("Invalid presentation duration.");
	if (!Array.isArray(value) || value.length > MAX_REGIONS)
		throw new Error("Invalid presentation regions.");
	const ids = new Set<string>();
	let previousEnd = 0;
	return value.map((candidate): PresentationRegion => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			throw new Error("Invalid presentation region.");
		const raw = candidate as Record<string, unknown>;
		if (
			typeof raw.id !== "string" ||
			!raw.id.trim() ||
			raw.id.length > 200 ||
			ids.has(raw.id) ||
			typeof raw.startMs !== "number" ||
			typeof raw.endMs !== "number" ||
			!Number.isFinite(raw.startMs) ||
			!Number.isFinite(raw.endMs) ||
			raw.startMs < previousEnd ||
			raw.endMs <= raw.startMs ||
			raw.endMs > (durationMs ?? MAX_DURATION_MS) ||
			(raw.mode !== "face-only" && raw.mode !== "demo") ||
			(raw.reason !== undefined && (typeof raw.reason !== "string" || raw.reason.length > 1_000))
		)
			throw new Error("Presentation regions must have valid, ordered, non-overlapping times.");
		ids.add(raw.id);
		previousEnd = raw.endMs;
		return {
			id: raw.id,
			startMs: raw.startMs,
			endMs: raw.endMs,
			mode: raw.mode,
			...(raw.reason === undefined ? {} : { reason: raw.reason as string }),
		};
	});
}

/** Regions are half-open; an uncovered time keeps the project's ordinary layout. */
export function getPresentationModeAt(
	regions: PresentationRegion[],
	timeMs: number,
): PresentationMode | undefined {
	if (!Number.isFinite(timeMs)) return undefined;
	let low = 0;
	let high = regions.length - 1;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const region = regions[middle];
		if (timeMs < region.startMs) high = middle - 1;
		else if (timeMs >= region.endMs) low = middle + 1;
		else return region.mode;
	}
	return undefined;
}

interface CursorActivitySample {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType?: string;
	visible?: boolean;
}

interface Range {
	startMs: number;
	endMs: number;
}

function appendRange(ranges: Range[], startMs: number, endMs: number): void {
	if (endMs <= startMs) return;
	const previous = ranges[ranges.length - 1];
	if (previous && startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, endMs);
	else ranges.push({ startMs, endMs });
}

function demoActivityRanges(samples: CursorActivitySample[], durationMs: number): Range[] {
	if (samples.length < 2)
		throw new Error("Cursor recording is missing. Mark the presentation switch times manually.");
	const protectedRanges: Range[] = [];
	let previousTime = -Infinity;
	let firstTime: number | undefined;
	let lastTime = 0;
	let anchor: CursorActivitySample | undefined;
	for (const sample of samples) {
		if (
			!Number.isFinite(sample.timeMs) ||
			!Number.isFinite(sample.cx) ||
			!Number.isFinite(sample.cy) ||
			sample.cx < 0 ||
			sample.cx > 1 ||
			sample.cy < 0 ||
			sample.cy > 1 ||
			sample.timeMs < previousTime
		)
			throw new Error("Cursor recording is invalid. Mark the presentation switch times manually.");
		previousTime = sample.timeMs;
		const timeMs = Math.max(0, Math.min(durationMs, sample.timeMs));
		if (firstTime === undefined) firstTime = timeMs;
		else if (timeMs - lastTime > MAX_TELEMETRY_GAP_MS)
			throw new Error("Cursor recording has gaps. Mark the presentation switch times manually.");
		lastTime = timeMs;
		const isAction = sample.interactionType !== undefined && sample.interactionType !== "move";
		const moved =
			sample.visible !== false &&
			anchor !== undefined &&
			Math.hypot(sample.cx - anchor.cx, sample.cy - anchor.cy) >= POINTER_MOVE_THRESHOLD;
		if (isAction || moved) {
			appendRange(
				protectedRanges,
				Math.max(0, timeMs - DEMO_BEFORE_ACTION_MS),
				Math.min(durationMs, timeMs + DEMO_AFTER_ACTION_MS),
			);
		}
		if (sample.visible !== false && (!anchor || isAction || moved)) anchor = sample;
	}
	if (
		(firstTime ?? durationMs) > TELEMETRY_EDGE_TOLERANCE_MS ||
		durationMs - lastTime > TELEMETRY_EDGE_TOLERANCE_MS
	)
		throw new Error("Cursor recording does not cover this demo. Mark the switch times manually.");
	return protectedRanges;
}

/** Energy is a candidate signal only: this does not recognize words or screen meaning. */
function activeAudioRanges(samples: Float32Array, sampleRate: number, durationMs: number): Range[] {
	const windowSamples = Math.max(1, Math.round((AUDIO_WINDOW_MS / 1_000) * sampleRate));
	const sampleLimit = Math.min(samples.length, Math.ceil((durationMs / 1_000) * sampleRate));
	const ranges: Range[] = [];
	let block: (Range & { activeMs: number }) | undefined;
	const finish = () => {
		if (block && block.activeMs / (block.endMs - block.startMs) >= MIN_ACTIVE_SHARE)
			ranges.push({ startMs: block.startMs, endMs: block.endMs });
		block = undefined;
	};
	for (let start = 0; start < sampleLimit; start += windowSamples) {
		const end = Math.min(sampleLimit, start + windowSamples);
		let squareSum = 0;
		let peak = 0;
		for (let index = start; index < end; index++) {
			const sample = samples[index];
			if (!Number.isFinite(sample))
				throw new Error("The narration contains invalid audio samples.");
			squareSum += sample * sample;
			peak = Math.max(peak, Math.abs(sample));
		}
		const startMs = (start / sampleRate) * 1_000;
		const endMs = Math.min(durationMs, (end / sampleRate) * 1_000);
		const active = peak >= MIN_AUDIO_PEAK && Math.sqrt(squareSum / (end - start)) >= MIN_AUDIO_RMS;
		if (!active) continue;
		if (block && startMs - block.endMs > MAX_AUDIO_PAUSE_MS) finish();
		if (block) {
			block.endMs = endMs;
			block.activeMs += endMs - startMs;
		} else block = { startMs, endMs, activeMs: endMs - startMs };
	}
	finish();
	return ranges;
}

export interface PresentationSuggestionOptions {
	samples: Float32Array;
	sampleRate?: number;
	cursorTelemetry: CursorActivitySample[];
	durationMs: number;
	webcamOffsetMs?: number;
}

/**
 * Conservative, deterministic layout candidates, not an automatic final edit.
 * Cursor actions protect screen content; only sustained idle audio can suggest face-only.
 * No input PCM or telemetry is changed. Work is linear in PCM + telemetry + output regions.
 */
export function suggestPresentationRegions(
	options: PresentationSuggestionOptions,
): PresentationRegion[] {
	const { samples, cursorTelemetry, durationMs, webcamOffsetMs = 0 } = options;
	const sampleRate = options.sampleRate ?? 16_000;
	if (!validDuration(durationMs)) throw new Error("Invalid presentation duration.");
	if (!Number.isInteger(sampleRate) || sampleRate < 100 || sampleRate > 192_000)
		throw new Error("Invalid narration sample rate.");
	if (!Number.isFinite(webcamOffsetMs)) throw new Error("Invalid camera start offset.");
	const protectedRanges = demoActivityRanges(cursorTelemetry, durationMs);
	const audioRanges = activeAudioRanges(samples, sampleRate, durationMs);
	const faceRanges: Range[] = [];
	let protectedIndex = 0;
	const addFace = (startMs: number, endMs: number) => {
		if (endMs - startMs >= MIN_FACE_REGION_MS) appendRange(faceRanges, startMs, endMs);
	};
	for (const audio of audioRanges) {
		let startMs = Math.max(audio.startMs, webcamOffsetMs, 0);
		const endMs = audio.endMs;
		while (
			protectedIndex < protectedRanges.length &&
			protectedRanges[protectedIndex].endMs <= startMs
		)
			protectedIndex++;
		let index = protectedIndex;
		while (index < protectedRanges.length && protectedRanges[index].startMs < endMs) {
			const action = protectedRanges[index];
			addFace(startMs, Math.min(endMs, action.startMs));
			startMs = Math.max(startMs, action.endMs);
			if (startMs >= endMs) break;
			index++;
		}
		addFace(startMs, endMs);
	}
	const regions: PresentationRegion[] = [];
	const append = (startMs: number, endMs: number, mode: PresentationMode) => {
		if (endMs <= startMs) return;
		const previous = regions[regions.length - 1];
		if (previous?.mode === mode && previous.endMs === startMs) {
			previous.endMs = endMs;
			return;
		}
		if (regions.length >= MAX_REGIONS)
			throw new Error("Too many presentation switches. Mark longer sections manually.");
		regions.push({
			id: `presentation-${regions.length + 1}`,
			startMs,
			endMs,
			mode,
			reason:
				mode === "face-only"
					? "Face-only candidate: sustained audio activity without meaningful pointer action. Review for loading or other on-screen actions."
					: "Screen-demo candidate: pointer activity, quiet audio, or too little sustained idle narration.",
		});
	};
	let cursor = 0;
	for (const face of faceRanges) {
		append(cursor, face.startMs, "demo");
		append(face.startMs, face.endMs, "face-only");
		cursor = face.endMs;
	}
	append(cursor, durationMs, "demo");
	return validatePresentationRegions(regions, durationMs);
}
