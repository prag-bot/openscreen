import type {
	TrimRegion,
	WebcamLayoutPreset,
	WebcamMaskShape,
	WebcamPosition,
} from "../../components/video-editor/types";
import type { CursorRecordingSample } from "../../native/contracts";
import { computeCompositeLayout, type RenderRect } from "../compositeLayout";
import {
	getPresentationModeAt,
	type PresentationMode,
	type PresentationRegion,
	validatePresentationRegions,
} from "../presentation";
import type { CursorCaptureMode } from "../recordingSession";
import { keptSourceRanges } from "../removalRanges";

export interface HyperframesExportRequest {
	screenVideoPath: string;
	/** Immutable multitrack recording, when screenVideoPath is a single-mix playback derivative. */
	originalScreenVideoPath?: string;
	webcamVideoPath?: string;
	/** Positive means the camera recording starts later than the screen recording. */
	webcamOffsetSeconds?: number;
	durationSeconds: number;
	width: number;
	height: number;
	trimRegions: TrimRegion[];
	/** Reviewed presentation choices on the original screen source clock, in milliseconds. */
	presentationRegions?: PresentationRegion[];
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamSizePreset: number;
	webcamPosition: WebcamPosition | null;
	webcamMaskShape: WebcamMaskShape;
	webcamMirrored: boolean;
	cursorCaptureMode?: CursorCaptureMode;
	showCursor?: boolean;
	cursorSize?: number;
	cursorClipToBounds?: boolean;
}

export type HyperframesExportResult =
	| { success: true; path: string; warnings: string[] }
	| { success: false; canceled?: boolean; error: string };

export type HyperframesVideoResult =
	| { success: true; path: string; videoPath: string; projectPath: string; warnings: string[] }
	| { success: false; canceled?: boolean; error: string; projectPath?: string };

export interface HyperframesCursorAsset {
	id: string;
	src: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	scaleFactor?: number;
}
export interface HyperframesCursorData {
	samples: CursorRecordingSample[];
	assets: HyperframesCursorAsset[];
}

export interface KeptClipSegment {
	sourceStart: number;
	timelineStart: number;
	duration: number;
}

export interface HyperframesVisualSegment extends KeptClipSegment {
	mode: PresentationMode | "legacy";
	requestedMode?: PresentationMode;
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
	"Editable raw footage: removal trims, reviewed face-only/demo presentation switches, camera layout, native cursor positions/visibility and all original audio streams are retained. Zooms, speed changes, crops, wallpapers, annotations, blur, reactive camera zoom and styled cursor effects are not exported. Audio already mixed during recording cannot be unmixed.";

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
	if (
		raw.cursorCaptureMode !== undefined &&
		raw.cursorCaptureMode !== "editable-overlay" &&
		raw.cursorCaptureMode !== "system"
	)
		throw new Error("Invalid cursor capture mode");
	if (raw.showCursor !== undefined && typeof raw.showCursor !== "boolean")
		throw new Error("Invalid cursor visibility");
	if (raw.cursorClipToBounds !== undefined && typeof raw.cursorClipToBounds !== "boolean")
		throw new Error("Invalid cursor clipping");
	const cursorSize = raw.cursorSize === undefined ? 1 : finiteNumber(raw.cursorSize, "cursor size");
	if (cursorSize < 0.1 || cursorSize > 10) throw new Error("Invalid cursor size");
	return {
		screenVideoPath: mediaPath(raw.screenVideoPath),
		...(raw.originalScreenVideoPath === undefined
			? {}
			: { originalScreenVideoPath: mediaPath(raw.originalScreenVideoPath) }),
		...(raw.webcamVideoPath === undefined
			? {}
			: { webcamVideoPath: mediaPath(raw.webcamVideoPath) }),
		webcamOffsetSeconds: offset,
		durationSeconds: validateHyperframesDuration(raw.durationSeconds),
		width: dimension(raw.width),
		height: dimension(raw.height),
		trimRegions,
		presentationRegions: validatePresentationRegions(
			raw.presentationRegions,
			validateHyperframesDuration(raw.durationSeconds) * 1000,
		),
		webcamLayoutPreset: raw.webcamLayoutPreset as WebcamLayoutPreset,
		webcamMaskShape: raw.webcamMaskShape as WebcamMaskShape,
		webcamSizePreset: size,
		webcamPosition: position,
		webcamMirrored: raw.webcamMirrored,
		cursorCaptureMode: raw.cursorCaptureMode as CursorCaptureMode | undefined,
		showCursor: raw.showCursor === true,
		cursorSize,
		cursorClipToBounds: raw.cursorClipToBounds !== false,
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

/** Split only visuals; presentation choices never change the soundtrack or kept source clock. */
function buildVisualSegments(
	segments: KeptClipSegment[],
	regions: PresentationRegion[],
	webcamOffset: number,
	webcamDuration?: number,
): HyperframesVisualSegment[] {
	if (!regions.length) return segments.map((segment) => ({ ...segment, mode: "legacy" }));
	if (regions.some((region) => region.mode === "face-only") && webcamDuration === undefined)
		throw new Error("Face-only presentation requires recorded webcam footage.");
	const boundaries = Array.from(
		new Set([
			...regions.flatMap((region) => [region.startMs / 1000, region.endMs / 1000]),
			...(webcamDuration === undefined ? [] : [webcamOffset, webcamOffset + webcamDuration]),
		]),
	).sort((a, b) => a - b);
	return segments.flatMap((segment) => {
		const end = segment.sourceStart + segment.duration;
		let low = 0;
		let high = boundaries.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (boundaries[middle] <= segment.sourceStart) low = middle + 1;
			else high = middle;
		}
		const points = [segment.sourceStart];
		for (let index = low; index < boundaries.length && boundaries[index] < end; index++)
			points.push(boundaries[index]);
		points.push(end);
		return points.slice(0, -1).flatMap((start, index) => {
			const finish = points[index + 1];
			// Metadata seconds and integer-millisecond boundaries can differ by a few
			// floating-point units. Do not turn that arithmetic dust into a legacy clip.
			const arithmeticTolerance =
				Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(finish)) * 8;
			if (finish - start <= arithmeticTolerance) return [];
			const midpoint = (start + finish) / 2;
			const requestedMode = getPresentationModeAt(regions, midpoint * 1000);
			const cameraAvailable =
				webcamDuration !== undefined &&
				midpoint >= webcamOffset &&
				midpoint < webcamOffset + webcamDuration;
			return [
				{
					sourceStart: start,
					timelineStart: segment.timelineStart + start - segment.sourceStart,
					duration: finish - start,
					mode:
						requestedMode === "face-only" && !cameraAvailable
							? "demo"
							: (requestedMode ?? "legacy"),
					...(requestedMode ? { requestedMode } : {}),
				} satisfies HyperframesVisualSegment,
			];
		});
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

export interface HyperframesCursorKeyframe {
	timeSeconds: number;
	sample: CursorRecordingSample;
	/** A source-clock discontinuity: never interpolate across a removed range. */
	cut: boolean;
}

/** Same source-clock interpolation and visibility rules as the native editor cursor adapter. */
export function buildHyperframesCursorKeyframes(
	samples: CursorRecordingSample[],
	segments: KeptClipSegment[],
): HyperframesCursorKeyframe[] {
	const at = (timeMs: number): CursorRecordingSample => {
		let low = 0,
			high = samples.length - 1,
			found = -1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			if (samples[middle].timeMs <= timeMs) {
				found = middle;
				low = middle + 1;
			} else high = middle - 1;
		}
		if (found < 0) return { timeMs, cx: 0, cy: 0, visible: false };
		const active = samples[found],
			next = samples[found + 1];
		if (
			!next ||
			active.visible === false ||
			next.visible === false ||
			next.assetId !== active.assetId ||
			next.timeMs <= active.timeMs
		)
			return { ...active, timeMs };
		const progress = (timeMs - active.timeMs) / (next.timeMs - active.timeMs);
		return {
			...active,
			timeMs,
			cx: active.cx + (next.cx - active.cx) * progress,
			cy: active.cy + (next.cy - active.cy) * progress,
		};
	};
	return segments.flatMap((segment) => {
		const start = segment.sourceStart * 1000,
			end = (segment.sourceStart + segment.duration) * 1000;
		const frames: HyperframesCursorKeyframe[] = [
			{ timeSeconds: segment.timelineStart, sample: at(start), cut: true },
		];
		// Binary search keeps long-recording exports O(samples + cuts log samples), not cuts × samples.
		let low = 0,
			high = samples.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (samples[middle].timeMs <= start) low = middle + 1;
			else high = middle;
		}
		for (let index = low; index < samples.length && samples[index].timeMs < end; index++)
			frames.push({
				timeSeconds: segment.timelineStart + (samples[index].timeMs - start) / 1000,
				sample: samples[index],
				cut: false,
			});
		frames.push({
			timeSeconds: segment.timelineStart + segment.duration,
			sample: at(end),
			cut: false,
		});
		return frames;
	});
}

export function createHyperframesComposition(
	request: HyperframesExportRequest,
	media: {
		screen: HyperframesMedia;
		webcam?: HyperframesMedia;
		audio: HyperframesAudioTrack[];
		cursor?: HyperframesCursorData;
	},
): {
	html: string;
	durationSeconds: number;
	segments: KeptClipSegment[];
	visualSegments: HyperframesVisualSegment[];
	warnings: string[];
	/** Source audio tracks with at least one rendered clip, not all preserved source tracks. */
	audioTrackCount: number;
} {
	const segments = buildKeptClipSegments(request.durationSeconds, request.trimRegions);
	const durationSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
	const presentationRegions = validatePresentationRegions(
		request.presentationRegions,
		request.durationSeconds * 1000,
	);
	const visualSegments = buildVisualSegments(
		segments,
		presentationRegions,
		request.webcamOffsetSeconds ?? 0,
		media.webcam?.durationSeconds,
	);
	const unavailableFaceDuration = visualSegments
		.filter((segment) => segment.requestedMode === "face-only" && segment.mode !== "face-only")
		.reduce((sum, segment) => sum + segment.duration, 0);
	const warnings =
		unavailableFaceDuration > 0
			? [
					`Webcam footage is unavailable for ${number(unavailableFaceDuration)} seconds of the reviewed face-only presentation. Those intervals use demo layout instead.`,
				]
			: [];
	let layout = computeCompositeLayout({
		canvasSize: { width: request.width, height: request.height },
		screenSize: media.screen,
		webcamSize: media.webcam,
		layoutPreset: request.webcamLayoutPreset,
		webcamSizePreset: request.webcamSizePreset,
		webcamPosition: request.webcamPosition,
		webcamMaskShape: request.webcamMaskShape,
	});
	const demoLayout = computeCompositeLayout({
		canvasSize: { width: request.width, height: request.height },
		screenSize: media.screen,
		webcamSize: media.webcam,
		layoutPreset: "picture-in-picture",
		webcamSizePreset: request.webcamSizePreset,
		webcamPosition: null,
		webcamMaskShape: request.webcamMaskShape,
	})!;
	if (!layout || layout.screenRect.width <= 0 || layout.screenRect.height <= 0) {
		if (visualSegments.some((segment) => segment.mode === "legacy"))
			throw new Error("The selected layout leaves no room for screen footage");
		layout = demoLayout;
	}
	const timing = (segment: KeptClipSegment, track: number) =>
		`data-start="${number(segment.timelineStart)}" data-duration="${number(segment.duration)}" data-track-index="${track}" data-media-start="${number(segment.sourceStart)}"`;
	const clips: string[] = visualSegments
		.filter((segment) => segment.mode !== "face-only")
		.map(
			(segment, index) =>
				`<video id="screen-${index + 1}" class="clip screen${segment.mode === "demo" ? " screen-demo" : ""}" src="${escapeHyperframesHtml(media.screen.src)}" ${timing(segment, 0)} muted playsinline preload="metadata"></video>`,
		);
	if (media.webcam) {
		let cameraIndex = 0;
		for (const visual of visualSegments) {
			if (visual.mode === "legacy" && request.webcamLayoutPreset === "no-webcam") continue;
			for (const segment of mapKeptClipsToMedia(
				[visual],
				request.webcamOffsetSeconds ?? 0,
				media.webcam.durationSeconds,
			)) {
				cameraIndex += 1;
				const cameraClass = visual.mode === "legacy" ? "" : ` webcam-${visual.mode}`;
				clips.push(
					`<video id="webcam-${cameraIndex}" class="clip webcam${cameraClass}" src="${escapeHyperframesHtml(media.webcam.src)}" ${timing(segment, 1)} muted playsinline preload="metadata"></video>`,
				);
			}
		}
	}
	let audioTrackCount = 0;
	for (const [track, audio] of media.audio.entries()) {
		const audioSegments = mapKeptClipsToMedia(segments, audio.offsetSeconds, audio.durationSeconds);
		if (audioSegments.length) audioTrackCount += 1;
		for (const [index, segment] of audioSegments.entries()) {
			clips.push(
				`<audio id="audio-${track + 1}-${index + 1}" src="${escapeHyperframesHtml(audio.src)}" ${timing(segment, 10 + track)} data-volume="1" preload="metadata"></audio>`,
			);
		}
	}
	const camera = layout.webcamRect;
	const cameraMask = camera?.maskShape === "circle" ? "clip-path:circle(50% at 50% 50%);" : "";
	const cursorScript: string[] = [];
	const cursorWanted =
		request.cursorCaptureMode === "editable-overlay" &&
		visualSegments.some(
			(segment) => segment.mode === "demo" || (segment.mode === "legacy" && request.showCursor),
		);
	const cursor = cursorWanted ? media.cursor : undefined;
	if (cursorWanted && !cursor) throw new Error("Requested editable cursor telemetry is missing");
	if (cursor) {
		for (const mode of ["legacy", "demo"] as const) {
			if (mode === "legacy" && !request.showCursor) continue;
			if (!visualSegments.some((segment) => segment.mode === mode)) continue;
			const cursorLayout = mode === "demo" ? demoLayout : layout;
			const rect = cursorLayout.screenRect;
			const layerId = mode === "legacy" ? "cursor-layer" : "cursor-demo-layer";
			const imageId = mode === "legacy" ? "cursor" : "cursor-demo";
			const scale = (cursorLayout.screenCover ? Math.max : Math.min)(
				rect.width / media.screen.width,
				rect.height / media.screen.height,
			);
			const offsetX = (rect.width - media.screen.width * scale) / 2,
				offsetY = (rect.height - media.screen.height * scale) / 2;
			const frames = buildHyperframesCursorKeyframes(cursor.samples, segments);
			const images = cursor.assets.map((asset, index) => {
				const size = ((request.cursorSize ?? 1) * scale) / (asset.scaleFactor ?? 1);
				const id = `#${imageId}-${index + 1}`;
				const position = (sample: CursorRecordingSample) =>
					`x:${number(offsetX + sample.cx * media.screen.width * scale - asset.hotspotX * size)},y:${number(offsetY + sample.cy * media.screen.height * scale - asset.hotspotY * size)}`;
				for (const [frameIndex, frame] of frames.entries()) {
					const next = frames[frameIndex + 1];
					// An outgoing endpoint supplies the interpolation target, but only the
					// incoming cut snapshot may write state at the shared timeline instant.
					if (next && next.timeSeconds === frame.timeSeconds) continue;
					const visible = frame.sample.visible !== false && frame.sample.assetId === asset.id;
					cursorScript.push(
						`tl.set("${id}", {opacity:${visible ? 1 : 0}}, ${number(frame.timeSeconds)});`,
					);
					if (!visible) continue;
					cursorScript.push(
						`tl.set("${id}", {${position(frame.sample)}}, ${number(frame.timeSeconds)});`,
					);
					if (
						next &&
						!next.cut &&
						next.timeSeconds > frame.timeSeconds &&
						next.sample.visible !== false &&
						next.sample.assetId === asset.id
					)
						cursorScript.push(
							`tl.fromTo("${id}", {${position(frame.sample)}}, {${position(next.sample)},duration:${number(next.timeSeconds - frame.timeSeconds)},ease:"none",immediateRender:false}, ${number(frame.timeSeconds)});`,
						);
				}
				return `<img id="${imageId}-${index + 1}" src="${escapeHyperframesHtml(asset.src)}" alt="" style="position:absolute;left:0;top:0;display:block;opacity:0;width:${number(asset.width * size)}px;height:${number(asset.height * size)}px">`;
			});
			if (presentationRegions.length) {
				for (const segment of visualSegments)
					cursorScript.push(
						`tl.set("#${layerId}", {opacity:${segment.mode === mode ? 1 : 0}}, ${number(segment.timelineStart)});`,
					);
				cursorScript.push(`tl.set("#${layerId}", {opacity:0}, ${number(durationSeconds)});`);
			}
			clips.push(
				`<div id="${layerId}" class="cursor-layer" style="position:absolute;${presentationRegions.length ? "opacity:0;" : ""}${box(rect)};overflow:${request.cursorClipToBounds === false ? "visible" : "hidden"};border-radius:${cursorLayout.screenBorderRadius ?? 0}px;pointer-events:none;z-index:2">${images.join("")}</div>`,
			);
		}
	}
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
    .screen-demo { ${box(demoLayout.screenRect)}; object-fit:contain; border-radius:0; }
    .webcam { ${camera ? box(camera) : "left:0;top:0;width:1px;height:1px;opacity:0"}; object-fit:cover; z-index:3; border-radius:${camera?.borderRadius ?? 0}px; ${cameraMask} transform:scaleX(${request.webcamMirrored ? -1 : 1}); }
    .webcam-demo { ${demoLayout.webcamRect ? box(demoLayout.webcamRect) : "left:0;top:0;width:1px;height:1px;opacity:0"}; opacity:1; border-radius:${demoLayout.webcamRect?.borderRadius ?? 0}px; clip-path:${demoLayout.webcamRect?.maskShape === "circle" ? "circle(50% at 50% 50%)" : "none"}; }
    .webcam-face-only { left:0;top:0;width:${request.width}px;height:${request.height}px;opacity:1;border-radius:0;clip-path:none; }
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
    const tl = window.__timelines["openscreen"];
    ${cursorScript.join("\n    ")}
  </script>
</body>
</html>
`;
	return { html, durationSeconds, segments, visualSegments, warnings, audioTrackCount };
}
