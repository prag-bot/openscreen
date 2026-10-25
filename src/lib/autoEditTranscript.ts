import type { CaptionSegment } from "./captioning/transcribe";

/** Whisper's 20ms timestamps and caption display holds can cross a recording edge. */
const MAX_RECORDING_EDGE_OVERSHOOT_SEC = 0.1;

function hasInvalidControlCharacter(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
	}
	return false;
}

/**
 * Canonicalize trusted local ASR output before IPC/stable segment IDs. Captioning
 * gives short words an 80ms minimum display duration, which can overlap the next
 * word. Keep their timing union and every word in ASR order. With source duration,
 * clip at most 100ms outside either recording edge, after restoring leading-silence
 * offsets; never move internal boundaries, sort words, or discard text. Malformed
 * or wholly out-of-recording spans fail locally instead of becoming proposed cuts.
 */
export function normalizeLocalAutoEditTranscript(
	segments: readonly CaptionSegment[],
	options?: { durationSeconds: number },
): CaptionSegment[] {
	const duration = options?.durationSeconds;
	if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 14_400))
		throw new Error(
			"The recording duration is invalid. Reload the recording before using Auto edit.",
		);
	const invalid = (detail: string): never => {
		throw new Error(
			`The local speech transcript ${detail}. No edit was sent; regenerate the transcript.`,
		);
	};
	const normalized: CaptionSegment[] = [];
	let lastStart = -Infinity;
	for (const segment of segments) {
		if (!Number.isFinite(segment.startSec) || !Number.isFinite(segment.endSec))
			invalid("contains non-finite speech timing");
		if (segment.endSec <= segment.startSec) invalid("contains reversed or empty speech timing");
		if (segment.startSec < lastStart) invalid("has speech timing out of order");
		lastStart = segment.startSec;
		if (
			typeof segment.text !== "string" ||
			!segment.text.trim() ||
			hasInvalidControlCharacter(segment.text)
		)
			invalid("contains invalid speech text");
		let { startSec, endSec } = segment;
		if (startSec < 0) {
			if (duration === undefined || startSec < -MAX_RECORDING_EDGE_OVERSHOOT_SEC)
				invalid("starts outside this recording");
			startSec = 0;
		}
		if (duration !== undefined && endSec > duration) {
			if (endSec - duration > MAX_RECORDING_EDGE_OVERSHOOT_SEC)
				invalid("extends beyond this recording");
			endSec = duration;
		}
		if (endSec <= startSec || (duration !== undefined && startSec >= duration))
			invalid("contains speech wholly outside this recording");
		const previous = normalized[normalized.length - 1];
		if (previous && startSec < previous.endSec && endSec > previous.startSec) {
			previous.startSec = Math.min(previous.startSec, startSec);
			previous.endSec = Math.max(previous.endSec, endSec);
			previous.text = `${previous.text} ${segment.text}`;
		} else {
			normalized.push({ startSec, endSec, text: segment.text });
		}
	}
	for (const segment of normalized) {
		if (Math.floor(segment.endSec * 1000) <= Math.ceil(segment.startSec * 1000))
			invalid("contains speech too short to place safely on the millisecond timeline");
		if (segment.text.length > 20_000) invalid("contains an excessively long speech span");
	}
	return normalized;
}
