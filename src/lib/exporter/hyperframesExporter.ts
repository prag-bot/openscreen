import type {
	TrimRegion,
	WebcamLayoutPreset,
	WebcamMaskShape,
	WebcamPosition,
} from "../../components/video-editor/types";
import { computeCompositeLayout, type RenderRect } from "../compositeLayout";
import { keptSourceRanges } from "../removalRanges";

export interface HyperframesExportRequest {
	screenVideoPath: string;
	webcamVideoPath?: string;
	/** Positive means the camera recording starts later than the screen recording. */
	webcamOffsetSeconds?: number;
	durationSeconds: number;
	width: number;
	height: number;
	trimRegions: TrimRegion[];
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamSizePreset: number;
	webcamPosition: WebcamPosition | null;
	webcamMaskShape: WebcamMaskShape;
	webcamMirrored: boolean;
}

export type HyperframesExportResult =
	| { success: true; path: string; warnings: string[] }
	| { success: false; canceled?: boolean; error: string };

export interface KeptClipSegment {
	sourceStart: number;
	timelineStart: number;
	duration: number;
}

export interface HyperframesMedia {
	src: string;
	durationSeconds: number;
	width: number;
	height: number;
}

export interface HyperframesAudioTrack {
	src: string;
	/** Time of this asset's first audio sample on the screen source clock. */
	offsetSeconds: number;
	durationSeconds: number;
}

export const HYPERFRAMES_RAW_FOOTAGE_NOTE =
	"Editable raw footage: removal trims and camera layout are retained. Zooms, speed changes, crops, wallpapers, annotations, blur, reactive camera zoom and editable cursor effects are not exported. Audio already mixed during recording cannot be unmixed.";

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

export function validateHyperframesDuration(value: unknown): number {
	const duration = finiteNumber(value, "duration");
	if (duration <= 0 || duration > 24 * 60 * 60) {
		throw new Error("Duration must be positive and no longer than 24 hours");
	}
	return duration;
}

function dimension(value: unknown): number {
	const size = finiteNumber(value, "frame dimensions");
	if (!Number.isInteger(size) || size < 2 || size > 8192) {
		throw new Error("Frame dimensions must be integers between 2 and 8192");
	}
	return size;
}

function mediaPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) {
		throw new Error("Invalid media path");
	}
	return value;
}

/** Validate the untrusted IPC shape; paths still require main-process approval. */
export function validateHyperframesExportRequest(value: unknown): HyperframesExportRequest {
	if (!value || typeof value !== "object") throw new Error("Invalid export request");
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.trimRegions) || raw.trimRegions.length > 10000) {
		throw new Error("Invalid removal trims");
	}
	const trimRegions = raw.trimRegions.map((candidate) => {
		if (!candidate || typeof candidate !== "object") throw new Error("Invalid removal trim");
		const region = candidate as Record<string, unknown>;
		const startMs = finiteNumber(region.startMs, "trim start (milliseconds)");
		const endMs = finiteNumber(region.endMs, "trim end (milliseconds)");
		if (endMs < startMs) throw new Error("Trim end must not precede its start");
		return { id: "", startMs, endMs };
	});
	const layouts: WebcamLayoutPreset[] = [
		"picture-in-picture",
		"vertical-stack",
		"dual-frame",
		"no-webcam",
	];
	const masks: WebcamMaskShape[] = ["rectangle", "circle", "square", "rounded"];
	if (!layouts.includes(raw.webcamLayoutPreset as WebcamLayoutPreset)) {
		throw new Error("Invalid webcam layout");
	}
	if (!masks.includes(raw.webcamMaskShape as WebcamMaskShape)) {
		throw new Error("Invalid webcam mask");
	}
	const size = finiteNumber(raw.webcamSizePreset, "webcam size");
	if (size < 10 || size > 50) throw new Error("Webcam size must be between 10 and 50");
	let position: WebcamPosition | null = null;
	if (raw.webcamPosition !== null) {
		if (!raw.webcamPosition || typeof raw.webcamPosition !== "object") {
			throw new Error("Invalid webcam position");
		}
		const p = raw.webcamPosition as Record<string, unknown>;
		const cx = finiteNumber(p.cx, "webcam x");
		const cy = finiteNumber(p.cy, "webcam y");
		if (cx < 0 || cx > 1 || cy < 0 || cy > 1) throw new Error("Invalid webcam position");
		position = { cx, cy };
	}
	if (typeof raw.webcamMirrored !== "boolean") throw new Error("Invalid webcam mirroring");
	const offset =
		raw.webcamOffsetSeconds === undefined
			? 0
			: finiteNumber(raw.webcamOffsetSeconds, "webcam offset");
	if (Math.abs(offset) > 24 * 60 * 60) throw new Error("Invalid webcam offset");
	return {
		screenVideoPath: mediaPath(raw.screenVideoPath),
		...(raw.webcamVideoPath === undefined
			? {}
			: { webcamVideoPath: mediaPath(raw.webcamVideoPath) }),
		webcamOffsetSeconds: offset,
		durationSeconds: validateHyperframesDuration(raw.durationSeconds),
		width: dimension(raw.width),
		height: dimension(raw.height),
		trimRegions,
		webcamLayoutPreset: raw.webcamLayoutPreset as WebcamLayoutPreset,
		webcamMaskShape: raw.webcamMaskShape as WebcamMaskShape,
		webcamSizePreset: size,
		webcamPosition: position,
		webcamMirrored: raw.webcamMirrored,
	};
}

/** TrimRegion describes REMOVED source ranges, in milliseconds. Merge their union. */
export function buildKeptClipSegments(
	durationSeconds: number,
	trims: TrimRegion[],
): KeptClipSegment[] {
	validateHyperframesDuration(durationSeconds);
	let cursor = 0;
	const kept = keptSourceRanges(durationSeconds * 1000, trims).map(({ startMs, endMs }) => {
		const duration = (endMs - startMs) / 1000;
		const segment = { sourceStart: startMs / 1000, timelineStart: cursor, duration };
		cursor += duration;
		return segment;
	});
	if (!kept.length) throw new Error("All footage has been removed by trims");
	return kept;
}

/** Intersect kept screen ranges with an offset source, retaining timeline gaps. */
export function mapKeptClipsToMedia(
	segments: KeptClipSegment[],
	offsetSeconds: number,
	mediaDurationSeconds: number,
): KeptClipSegment[] {
	finiteNumber(offsetSeconds, "media offset");
	validateHyperframesDuration(mediaDurationSeconds);
	return segments.flatMap((segment) => {
		const start = Math.max(segment.sourceStart, offsetSeconds);
		const end = Math.min(
			segment.sourceStart + segment.duration,
			offsetSeconds + mediaDurationSeconds,
		);
		if (end <= start) return [];
		return [
			{
				sourceStart: start - offsetSeconds,
				timelineStart: segment.timelineStart + start - segment.sourceStart,
				duration: end - start,
			},
		];
	});
}

export function escapeHyperframesHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
}

function number(value: number): string {
	return String(Number(value.toFixed(9)));
}

function box(rect: RenderRect): string {
	return `left:${number(rect.x)}px;top:${number(rect.y)}px;width:${number(rect.width)}px;height:${number(rect.height)}px`;
}

export function createHyperframesComposition(
	request: HyperframesExportRequest,
	media: { screen: HyperframesMedia; webcam?: HyperframesMedia; audio: HyperframesAudioTrack[] },
): { html: string; durationSeconds: number; segments: KeptClipSegment[] } {
	const segments = buildKeptClipSegments(request.durationSeconds, request.trimRegions);
	const durationSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
	const layout = computeCompositeLayout({
		canvasSize: { width: request.width, height: request.height },
		screenSize: media.screen,
		webcamSize: media.webcam,
		layoutPreset: request.webcamLayoutPreset,
		webcamSizePreset: request.webcamSizePreset,
		webcamPosition: request.webcamPosition,
		webcamMaskShape: request.webcamMaskShape,
	});
	if (!layout || layout.screenRect.width <= 0 || layout.screenRect.height <= 0) {
		throw new Error("The selected layout leaves no room for screen footage");
	}
	const timing = (segment: KeptClipSegment, track: number) =>
		`data-start="${number(segment.timelineStart)}" data-duration="${number(segment.duration)}" data-track-index="${track}" data-media-start="${number(segment.sourceStart)}"`;
	const clips: string[] = segments.map(
		(segment, index) =>
			`<video id="screen-${index + 1}" class="clip screen" src="${escapeHyperframesHtml(media.screen.src)}" ${timing(segment, 0)} muted playsinline preload="metadata"></video>`,
	);
	if (media.webcam && request.webcamLayoutPreset !== "no-webcam") {
		for (const [index, segment] of mapKeptClipsToMedia(
			segments,
			request.webcamOffsetSeconds ?? 0,
			media.webcam.durationSeconds,
		).entries()) {
			clips.push(
				`<video id="webcam-${index + 1}" class="clip webcam" src="${escapeHyperframesHtml(media.webcam.src)}" ${timing(segment, 1)} muted playsinline preload="metadata"></video>`,
			);
		}
	}
	for (const [track, audio] of media.audio.entries()) {
		for (const [index, segment] of mapKeptClipsToMedia(
			segments,
			audio.offsetSeconds,
			audio.durationSeconds,
		).entries()) {
			clips.push(
				`<audio id="audio-${track + 1}-${index + 1}" src="${escapeHyperframesHtml(audio.src)}" ${timing(segment, 10 + track)} data-volume="1" preload="metadata"></audio>`,
			);
		}
	}
	const camera = layout.webcamRect;
	const cameraMask = camera?.maskShape === "circle" ? "clip-path:circle(50% at 50% 50%);" : "";
	const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>OpenScreen · editable raw footage</title>
  <style>
    body { margin:0; background:#09090b; }
    #openscreen { position:relative; width:${request.width}px; height:${request.height}px; overflow:hidden; background:radial-gradient(ellipse at top right,rgba(52,178,123,.2),transparent 65%),#09090b; }
    video { position:absolute; display:block; }
    .screen { ${box(layout.screenRect)}; object-fit:${layout.screenCover ? "cover" : "contain"}; z-index:1; border-radius:${layout.screenBorderRadius ?? 0}px; }
    .webcam { ${camera ? box(camera) : "left:0;top:0;width:1px;height:1px;opacity:0"}; object-fit:cover; z-index:2; border-radius:${camera?.borderRadius ?? 0}px; ${cameraMask} transform:scaleX(${request.webcamMirrored ? -1 : 1}); }
  </style>
</head>
<body>
  <!-- Media must remain DIRECT children of the composition root. HyperFrames owns playback. -->
  <!-- ${HYPERFRAMES_RAW_FOOTAGE_NOTE} -->
  <div id="openscreen" data-composition-id="openscreen" data-start="0" data-duration="${number(durationSeconds)}" data-width="${request.width}" data-height="${request.height}">
    ${clips.join("\n    ")}
  </div>
  <script src="vendor/gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {};
    window.__timelines["openscreen"] = gsap.timeline({ paused: true });
  </script>
</body>
</html>
`;
	return { html, durationSeconds, segments };
}
