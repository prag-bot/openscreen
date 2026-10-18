import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrimRegion } from "@/components/video-editor/types";
import { AudioProcessor, downmixPlanarChannelsForExport } from "./audioEncoder";

describe("real audio removal offset/pipeline", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("also gives the pitch-preserving branch canonical bounded removals", async () => {
		const processor = new AudioProcessor();
		const branch = processor as unknown as {
			renderPitchPreservedTimelineAudio: (
				url: string,
				trims: TrimRegion[],
				speeds: unknown[],
				duration: number,
			) => Promise<Blob>;
		};
		const render = vi
			.spyOn(branch, "renderPitchPreservedTimelineAudio")
			.mockResolvedValue(new Blob());
		await processor.process(
			{} as Parameters<AudioProcessor["process"]>[0],
			{} as Parameters<AudioProcessor["process"]>[1],
			"synthetic-only",
			[
				{ id: "manual", startMs: 2000, endMs: 8000 },
				{ id: "auto", startMs: 4000, endMs: 5000 },
			],
			[{ id: "speed", startMs: 0, endMs: 2000, speed: 2 }],
			10,
			{
				encoderCodec: "mp4a.40.2",
				muxerCodec: "aac",
				label: "AAC",
				sampleRate: 48000,
				numberOfChannels: 1,
			},
		);
		expect(render).toHaveBeenCalledWith(
			"synthetic-only",
			[{ id: "audio-removal-0", startMs: 2000, endMs: 8000 }],
			expect.any(Array),
			10,
		);
	});
	it.each([
		[
			[2000, 8000],
			[4000, 5000],
		],
		[
			[2000, 5000],
			[4000, 8000],
		],
		[
			[2000, 4000],
			[4000, 8000],
		],
	] as const)("counts overlapping/touching elapsed removals once for %j", (...ranges) => {
		const processor = new AudioProcessor() as unknown as {
			computeTrimOffset: (timestampMs: number, trims: TrimRegion[]) => number;
		};
		const trims = ranges.map(([startMs, endMs], index) => ({ id: String(index), startMs, endMs }));
		expect(processor.computeTrimOffset(8000, trims)).toBe(6000);
		expect(processor.computeTrimOffset(9000, trims)).toBe(6000);
	});

	it.each([
		{
			ranges: [
				[2000, 8000],
				[4000, 5000],
			],
			timestamps: [0, 1000, 2000, 3000],
		},
		{
			ranges: [
				[2000, 5000],
				[4000, 8000],
			],
			timestamps: [0, 1000, 2000, 3000],
		},
		{
			ranges: [
				[2000, 4000],
				[4000, 8000],
			],
			timestamps: [0, 1000, 2000, 3000],
		},
		{
			ranges: [
				[-2000, 2000],
				[8000, 12000],
				[5000, 5000],
				[20000, 21000],
			],
			timestamps: [0, 1000, 2000, 3000, 4000, 5000],
		},
	])("remaps real trim-only audio output with union/bounds %j", async ({ ranges, timestamps }) => {
		class SyntheticAudioData {
			format = "f32-planar";
			sampleRate = 48000;
			numberOfFrames = 1;
			numberOfChannels = 1;
			timestamp: number;
			constructor(init: { timestamp: number }) {
				this.timestamp = init.timestamp;
			}
			allocationSize() {
				return 4;
			}
			copyTo() {
				/* This packet-timestamp fixture does not inspect PCM samples. */
			}
			close() {
				/* Synthetic audio data owns no native resources. */
			}
		}
		vi.stubGlobal("AudioData", SyntheticAudioData);
		vi.stubGlobal(
			"AudioDecoder",
			class {
				state = "unconfigured";
				decodeQueueSize = 0;
				constructor(private callbacks: { output: (data: SyntheticAudioData) => void }) {}
				static async isConfigSupported() {
					return { supported: true };
				}
				configure() {
					this.state = "configured";
				}
				decode(chunk: { timestamp: number }) {
					this.callbacks.output(new SyntheticAudioData(chunk));
				}
				async flush() {
					/* Synthetic decoding emits synchronously. */
				}
				close() {
					this.state = "closed";
				}
			},
		);
		vi.stubGlobal(
			"AudioEncoder",
			class {
				state = "unconfigured";
				constructor(private callbacks: { output: (chunk: { timestamp: number }) => void }) {}
				static async isConfigSupported() {
					return { supported: true };
				}
				configure() {
					this.state = "configured";
				}
				encode(data: SyntheticAudioData) {
					this.callbacks.output({ timestamp: data.timestamp });
				}
				async flush() {
					/* Synthetic encoding emits synchronously. */
				}
				close() {
					this.state = "closed";
				}
			},
		);
		let sourceIndex = 0;
		const demuxer = {
			getDecoderConfig: async () => ({
				codec: "test-audio",
				sampleRate: 48000,
				numberOfChannels: 1,
			}),
			read: () => ({
				getReader: () => ({
					read: async () =>
						sourceIndex < 10
							? { done: false, value: { timestamp: sourceIndex++ * 1000000 } }
							: { done: true },
					cancel: async () => {
						/* No external stream is opened by the fixture. */
					},
				}),
			}),
		} as unknown as Parameters<AudioProcessor["process"]>[0];
		const addAudioChunk = vi.fn();
		const muxer = { addAudioChunk } as unknown as Parameters<AudioProcessor["process"]>[1];
		const trims = ranges.map(([startMs, endMs], index) => ({ id: `raw-${index}`, startMs, endMs }));
		const snapshot = structuredClone(trims);
		await new AudioProcessor().process(demuxer, muxer, "synthetic-only", trims, undefined, 10, {
			encoderCodec: "mp4a.40.2",
			muxerCodec: "aac",
			label: "AAC",
			sampleRate: 48000,
			numberOfChannels: 1,
		});
		expect(addAudioChunk.mock.calls.map(([chunk]) => chunk.timestamp / 1000)).toEqual(timestamps);
		expect(trims).toEqual(snapshot);
	});
});

describe("AudioProcessor.selectSupportedExportCodec", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to stereo when the source channel count cannot be encoded", async () => {
		const isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({
			config,
			supported:
				config.codec === "mp4a.40.2" &&
				config.sampleRate === 44100 &&
				config.numberOfChannels === 2,
		}));
		vi.stubGlobal("AudioEncoder", { isConfigSupported });

		const codec = await AudioProcessor.selectSupportedExportCodec(44100, 8);

		expect(codec).toMatchObject({
			encoderCodec: "mp4a.40.2",
			muxerCodec: "aac",
			sampleRate: 44100,
			numberOfChannels: 2,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 8,
			bitrate: 128000,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 2,
			bitrate: 128000,
		});
	});
});

describe("downmixPlanarChannelsForExport", () => {
	it("preserves non-front Windows system audio channels when exporting stereo", () => {
		const sourcePlanes = Array.from({ length: 8 }, (_, channel) => {
			const plane = new Float32Array(2);
			if (channel === 2) {
				plane[0] = 0.8;
				plane[1] = 0.4;
			}
			if (channel === 6) {
				plane[0] = 0.2;
				plane[1] = 0.1;
			}
			return plane;
		});

		const stereo = downmixPlanarChannelsForExport(sourcePlanes, 2);

		expect(stereo[0]).toBeGreaterThan(0);
		expect(stereo[1]).toBeGreaterThan(0);
		expect(stereo[2]).toBeGreaterThan(0);
		expect(stereo[3]).toBeGreaterThan(0);
	});

	it("duplicates mono microphone audio when exporting stereo", () => {
		const mono = new Float32Array([0.25, -0.5]);

		const stereo = downmixPlanarChannelsForExport([mono], 2);

		expect(Array.from(stereo)).toEqual([0.25, -0.5, 0.25, -0.5]);
	});
});
