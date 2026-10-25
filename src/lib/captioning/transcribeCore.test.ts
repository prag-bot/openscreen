import { describe, expect, it, vi } from "vitest";
import { runTranscription } from "./transcribeCore";

const oneSecond = new Float32Array(16_000);

describe("local ASR timestamp boundaries", () => {
	it.each([
		[1, null],
		[1.2, null],
		[Number.NaN, 0.8],
		[0, Number.POSITIVE_INFINITY],
		[Number.NEGATIVE_INFINITY, 0.8],
		[-0.1, 0.8],
		[0.5, 0.5],
		[0.5, 0.4],
		[0.5, 200],
		[0.5, 1.101],
	] as Array<
		[number, number | null]
	>)("retries phrase timing for malformed nonempty word span %s–%s", async (start, end) => {
		const transcriber = vi.fn(async (_audio, options) =>
			options.return_timestamps === "word"
				? {
						chunks: [
							{ timestamp: [0, 0.2], text: "first" },
							{ timestamp: [start, end], text: "last" },
						],
					}
				: { chunks: [{ timestamp: [0, 1], text: "first last" }] },
		);
		const result = await runTranscription(transcriber, oneSecond, []);
		expect(result).toEqual({
			segments: [{ startSec: 0, endSec: 1, text: "first last" }],
			granularity: "phrase",
		});
		expect(transcriber.mock.calls.map(([, options]) => options.return_timestamps)).toEqual([
			"word",
			true,
		]);
	});

	it("recovers the whole transcript when padded chunk word times jump past the actual audio", async () => {
		const samples = new Float32Array(1_122_293); // 70.1433125s of actual PCM after a leading trim.
		const transcriber = vi.fn(async (_audio, options) =>
			options.return_timestamps === "word"
				? {
						chunks: [
							{ timestamp: [0.2, 0.5], text: "Opening" },
							{ timestamp: [80.26, 80.8], text: "Closing" },
							{ timestamp: [80.8, null], text: "words" },
						],
					}
				: { chunks: [{ timestamp: [0.2, null], text: "Opening Closing words" }] },
		);
		const result = await runTranscription(transcriber, samples, []);
		expect(result.granularity).toBe("phrase");
		expect(result.segments).toEqual([
			{ startSec: 0.2, endSec: samples.length / 16_000, text: "Opening Closing words" },
		]);
		expect(transcriber).toHaveBeenCalledTimes(2);
	});

	it("rejects unordered or missing nonempty chunk timing without silently dropping speech", async () => {
		for (const chunks of [
			[
				{ timestamp: [0.5, 0.8], text: "first" },
				{ timestamp: [0.1, 0.4], text: "last" },
			],
			[{ timestamp: [0, 0.5], text: "first" }, { text: "last" }],
		]) {
			const transcriber = vi.fn().mockResolvedValue({ chunks });
			await expect(runTranscription(transcriber, oneSecond, [])).rejects.toThrow(
				/Speech was recognized.*invalid timestamps/,
			);
			expect(transcriber.mock.calls.some(([, options]) => options.return_timestamps === true)).toBe(
				true,
			);
		}
	});

	it("fails clearly if every timing attempt is malformed, while actual empty output stays empty", async () => {
		await expect(
			runTranscription(
				vi.fn().mockResolvedValue({ chunks: [{ timestamp: [1, null], text: "speech" }] }),
				oneSecond,
				[],
			),
		).rejects.toThrow(/invalid timestamps/);
		await expect(
			runTranscription(vi.fn().mockResolvedValue({ text: "", chunks: [] }), oneSecond, []),
		).resolves.toEqual({ segments: [], granularity: "phrase" });
	});

	it("keeps null-end resolution, bounded finite tail rounding, and minimum caption display timing", async () => {
		const transcriber = vi.fn().mockResolvedValue({
			chunks: [
				{ timestamp: [null, 0.04], text: "a" },
				{ timestamp: [0.04, null], text: "test" },
				{ timestamp: [0.4, 1.02], text: "sentence" },
			],
		});
		expect(await runTranscription(transcriber, oneSecond, [])).toEqual({
			segments: [
				{ startSec: 0, endSec: 0.08, text: "a" },
				{ startSec: 0.04, endSec: 0.4, text: "test" },
				{ startSec: 0.4, endSec: 1, text: "sentence" },
			],
			granularity: "word",
		});
	});

	it("retains a whole-audio fallback for text without chunks rather than fabricating word boundaries", async () => {
		const transcriber = vi.fn().mockResolvedValue({ text: "A complete recognized phrase" });
		expect(await runTranscription(transcriber, oneSecond, [])).toEqual({
			segments: [{ startSec: 0, endSec: 1, text: "A complete recognized phrase" }],
			granularity: "phrase",
		});
	});

	it("keeps an empty result when valid recovered speech is entirely inside existing removal trims", async () => {
		const transcriber = vi.fn(async (_audio, options) =>
			options.return_timestamps === "word"
				? { chunks: [{ timestamp: [1, null], text: "recognized speech" }] }
				: { chunks: [{ timestamp: [0, 1], text: "recognized speech" }] },
		);
		await expect(
			runTranscription(transcriber, oneSecond, [{ id: "all", startMs: 0, endMs: 1000 }]),
		).resolves.toEqual({ segments: [], granularity: "phrase" });
	});

	it("preserves trim filtering and clamps short padded tails to their real samples", async () => {
		const transcriber = vi.fn().mockResolvedValue({
			chunks: [
				{ timestamp: [0, 0.5], text: "before" },
				{ timestamp: [0.5, 1], text: "removed" },
				{ timestamp: [1, null], text: "after" },
			],
		});
		expect(
			(
				await runTranscription(transcriber, new Float32Array(32_000), [
					{ id: "trim", startMs: 600, endMs: 800 },
				])
			).segments,
		).toEqual([
			{ startSec: 0, endSec: 0.5, text: "before" },
			{ startSec: 1, endSec: 2, text: "after" },
		]);
		const short = vi.fn().mockResolvedValue({ text: "short phrase" });
		expect((await runTranscription(short, new Float32Array(400), [])).segments).toEqual([
			{ startSec: 0, endSec: 0.025, text: "short phrase" },
		]);
		expect(short.mock.calls[0][0]).toHaveLength(800);
	});
});
