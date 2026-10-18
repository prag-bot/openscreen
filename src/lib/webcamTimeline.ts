import type { SpeedRegion, TrimRegion } from "../components/video-editor/types";
import { normalizeWebcamOffsetSeconds } from "./recordingSession";
import { canonicalRemovalRanges } from "./removalRanges";

/** Signed offset convention shared by preview, MP4/GIF and editable HF clips. */
export function webcamSourceTimeSeconds(
	screenSourceTimeSeconds: number,
	webcamOffsetSeconds = 0,
	webcamDurationSeconds = Number.POSITIVE_INFINITY,
): number | null {
	const time = screenSourceTimeSeconds - normalizeWebcamOffsetSeconds(webcamOffsetSeconds);
	return Number.isFinite(time) && time >= 0 && time < webcamDurationSeconds ? time : null;
}

/**
 * Decoder trims/speeds must be on the camera clock too: shifting only frame lookup
 * loses the end of a leading camera recording and applies cuts to the wrong words.
 * Trim the parts outside the screen intersection, without touching either asset.
 */
export function buildWebcamDecodeTimeline(
	screenDurationSeconds: number,
	webcamDurationSeconds: number,
	webcamOffsetSeconds = 0,
	trimRegions: readonly TrimRegion[] = [],
	speedRegions: readonly SpeedRegion[] = [],
): { trimRegions: TrimRegion[]; speedRegions: SpeedRegion[]; hasFrames: boolean } {
	const offsetMs = normalizeWebcamOffsetSeconds(webcamOffsetSeconds) * 1000;
	const durationMs = webcamDurationSeconds * 1000;
	const startMs = Math.max(0, -offsetMs);
	const endMs = Math.min(durationMs, screenDurationSeconds * 1000 - offsetMs);
	const hasFrames = endMs > startMs;
	const removed = hasFrames
		? [
				{ startMs: 0, endMs: startMs },
				...trimRegions.map((region) => ({
					startMs: region.startMs - offsetMs,
					endMs: region.endMs - offsetMs,
				})),
				{ startMs: endMs, endMs: durationMs },
			]
		: [{ startMs: 0, endMs: durationMs }];
	const merged = canonicalRemovalRanges(durationMs, removed).map((range, index) => ({
		...range,
		id: `webcam-clock-${index}`,
	}));
	return {
		hasFrames,
		trimRegions: merged,
		speedRegions: hasFrames
			? speedRegions.flatMap((region) => {
					const start = Math.max(startMs, region.startMs - offsetMs);
					const end = Math.min(endMs, region.endMs - offsetMs);
					return end > start ? [{ ...region, startMs: start, endMs: end }] : [];
				})
			: [],
	};
}
