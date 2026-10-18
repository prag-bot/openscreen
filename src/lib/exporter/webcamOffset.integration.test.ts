import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeedRegion, TrimRegion } from "../../components/video-editor/types";
import { GifExporter } from "./gifExporter";
import { buildKeptClipSegments, mapKeptClipsToMedia } from "./hyperframesExporter";
import { VideoExporter } from "./videoExporter";

const synthetic = vi.hoisted(() => ({
	cameraDuration: 12,
	decodeCalls: [] as { url: string; trims: TrimRegion[]; speeds: SpeedRegion[] }[],
	renders: [] as { screenMs: number; cameraMs: number | null }[],
}));
vi.mock("@/utils/platformUtils", () => ({ getPlatform: async () => "darwin" }));
vi.mock("./streamingDecoder", () => ({
	StreamingVideoDecoder: class {
		url = "";
		cancelled = false;
		async loadMetadata(url: string) {
			this.url = url;
			return {
				width: 320,
				height: 180,
				duration: url === "camera" ? synthetic.cameraDuration : 10,
				hasAudio: false,
			};
		}
		getDemuxer() {
			return null;
		}
		getExportMetrics() {
			return { totalFrames: 8, effectiveDuration: 8 };
		}
		async decodeAll(
			_fps: number,
			trims: TrimRegion[] = [],
			speeds: SpeedRegion[] = [],
			onFrame: (frame: VideoFrame, exportedUs: number, sourceMs: number) => Promise<void>,
		) {
			synthetic.decodeCalls.push({ url: this.url, trims, speeds });
			const duration = this.url === "camera" ? synthetic.cameraDuration : 10;
			for (let sourceMs = 0; sourceMs < duration * 1000 && !this.cancelled; sourceMs += 1000) {
				if (trims.some((trim) => sourceMs >= trim.startMs && sourceMs < trim.endMs)) continue;
				await onFrame(
					new VideoFrame({} as CanvasImageSource, { timestamp: sourceMs * 1000 }),
					sourceMs * 1000,
					sourceMs,
				);
			}
		}
		cancel() {
			this.cancelled = true;
		}
		destroy() {
			this.cancel();
		}
	},
}));
vi.mock("./frameRenderer", () => ({
	FrameRenderer: class {
		async initialize() {
			/* Synthetic renderer has no GPU resources to initialize. */
		}
		async renderFrame(_screen: VideoFrame, screenUs: number, camera: VideoFrame | null) {
			synthetic.renders.push({
				screenMs: screenUs / 1000,
				cameraMs: camera ? camera.timestamp / 1000 : null,
			});
		}
		getCanvas() {
			return {};
		}
		destroy() {
			/* Synthetic renderer owns no native resources. */
		}
	},
}));
vi.mock("./muxer", () => ({
	VideoMuxer: class {
		async initialize() {
			/* Synthetic muxer has no output container to initialize. */
		}
		async addVideoChunk() {
			/* Frame selection is asserted before synthetic muxing. */
		}
		async finalize() {
			return new Blob(["synthetic-mp4"]);
		}
	},
}));
vi.mock("gif.js", () => ({
	default: class {
		finished: ((blob: Blob) => void) | null = null;
		addFrame() {
			/* GIF frame selection is recorded by the fake renderer. */
		}
		on(event: string, callback: (blob: Blob) => void) {
			if (event === "finished") this.finished = callback;
		}
		render() {
			this.finished?.(new Blob(["synthetic-gif"]));
		}
	},
}));

beforeEach(() => {
	synthetic.decodeCalls.length = 0;
	synthetic.renders.length = 0;
	vi.stubGlobal(
		"VideoFrame",
		class {
			timestamp: number;
			constructor(source: { timestamp?: number }, init: { timestamp?: number } = {}) {
				this.timestamp = init.timestamp ?? source.timestamp ?? 0;
			}
			close() {
				/* Synthetic frames own no platform handles. */
			}
		},
	);
	vi.stubGlobal(
		"VideoEncoder",
		class {
			state = "unconfigured";
			encodeQueueSize = 0;
			constructor(private callbacks: { output: (chunk: unknown) => void }) {}
			static async isConfigSupported() {
				return { supported: true };
			}
			configure() {
				this.state = "configured";
			}
			encode() {
				this.callbacks.output({});
			}
			async flush() {
				/* Synthetic encoding is synchronous. */
			}
			close() {
				this.state = "closed";
			}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("MP4/GIF camera clock integration (synthetic frames only)", () => {
	it.each([
		["mp4", 20],
		["gif", 20],
		["mp4", -20],
		["gif", -20],
	] as const)("%s skips camera decoding entirely for disjoint offset %s (no blocked producer)", async (format, offset) => {
		synthetic.cameraDuration = 5;
		const common = {
			videoUrl: "screen",
			webcamVideoUrl: "camera",
			webcamOffsetSeconds: offset,
			width: 320,
			height: 180,
			frameRate: 15 as const,
			wallpaper: "#000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		};
		const exporter =
			format === "mp4"
				? new VideoExporter({ ...common, bitrate: 1000000 })
				: new GifExporter({ ...common, loop: true, sizePreset: "medium" });
		const result = await exporter.export();
		expect(result.success, result.error).toBe(true);
		expect(synthetic.decodeCalls.map(({ url }) => url)).toEqual(["screen"]);
		expect(synthetic.renders).toHaveLength(10);
		expect(synthetic.renders.every(({ cameraMs }) => cameraMs === null)).toBe(true);
	});

	it.each([
		["mp4", -2, 12],
		["gif", -2, 12],
		["mp4", 2, 5],
		["gif", 2, 5],
		["mp4", undefined, 10],
		["gif", undefined, 10],
	] as const)("%s matches HF cuts/bounds for offset %s", async (format, offset, cameraDuration) => {
		synthetic.cameraDuration = cameraDuration;
		const trimRegions = [{ id: "remove", startMs: 2000, endMs: 4000 }];
		const speedRegions = [{ id: "speed", startMs: 6000, endMs: 8000, speed: 2 as const }];
		const common = {
			videoUrl: "screen",
			webcamVideoUrl: "camera",
			webcamOffsetSeconds: offset,
			width: 320,
			height: 180,
			frameRate: 15 as const,
			wallpaper: "#000",
			zoomRegions: [],
			trimRegions,
			speedRegions,
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		};
		const exporter =
			format === "mp4"
				? new VideoExporter({ ...common, bitrate: 1000000 })
				: new GifExporter({ ...common, loop: true, sizePreset: "medium" });
		const result = await exporter.export();
		expect(result.success, result.error).toBe(true);
		const cameraCall = synthetic.decodeCalls.find((call) => call.url === "camera")!;
		const hfClips = mapKeptClipsToMedia(
			buildKeptClipSegments(10, trimRegions),
			offset ?? 0,
			cameraDuration,
		);
		expect(
			buildKeptClipSegments(cameraDuration, cameraCall.trims).map(({ sourceStart, duration }) => ({
				sourceStart,
				duration,
			})),
		).toEqual(hfClips.map(({ sourceStart, duration }) => ({ sourceStart, duration })));
		expect(cameraCall.speeds).toEqual([
			{
				id: "speed",
				startMs: (6 - (offset ?? 0)) * 1000,
				endMs: Math.min(cameraDuration, 8 - (offset ?? 0)) * 1000,
				speed: 2,
			},
		]);
		expect(synthetic.renders).toEqual(
			[0, 1, 4, 5, 6, 7, 8, 9].map((screenSec) => {
				const source = screenSec - (offset ?? 0);
				return {
					screenMs: screenSec * 1000,
					cameraMs: source >= 0 && source < cameraDuration ? source * 1000 : null,
				};
			}),
		);
		if (offset === -2) expect(synthetic.renders.at(-1)?.cameraMs).toBe(11000);
	});
});
