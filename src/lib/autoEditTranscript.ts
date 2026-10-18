import type { CaptionSegment } from "./captioning/transcribe";

/**
 * Canonicalize trusted local ASR output before IPC/stable segment IDs. Captioning
 * gives short words an 80ms minimum display duration, which can overlap the next
 * word. Keep their timing union and every word in ASR order; never move a boundary
 * or discard text to make it pass the stricter, untrusted main-process validator.
 */
export function normalizeLocalAutoEditTranscript(
	segments: readonly CaptionSegment[],
): CaptionSegment[] {
	const normalized: CaptionSegment[] = [];
	for (const segment of segments) {
		const previous = normalized[normalized.length - 1];
		if (previous && segment.startSec < previous.endSec && segment.endSec > previous.startSec) {
			previous.startSec = Math.min(previous.startSec, segment.startSec);
			previous.endSec = Math.max(previous.endSec, segment.endSec);
			previous.text = `${previous.text} ${segment.text}`;
		} else {
			normalized.push({ ...segment });
		}
	}
	return normalized;
}
