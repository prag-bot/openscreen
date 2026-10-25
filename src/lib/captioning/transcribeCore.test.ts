import { describe, expect, it, vi } from "vitest";
import { runTranscription } from "./transcribeCore";

const oneSecond = new Float32Array(16_000);

describe("local ASR timestamp boundaries", () => {
	it("refines matching short phrases while retaining unanchored coarse tails and original wording", async () => {
		let refinement = 0;
		const transcriber = vi.fn(async (audio, options) => {
			if (options.return_timestamps !== "word")
				return {
					chunks: [
						{ timestamp: [0, 1], text: "Uh, hello." },
						{ timestamp: [1, 2], text: "Original tail" },
					],
				};
			if (audio.length === 32000)
				return { chunks: [{ timestamp: [3, null], text: "bad alignment" }] };
			refinement += 1;
			return {
				chunks:
					refinement === 1
						? [
								{ timestamp: [0, 0.2], text: "Uh," },
								{ timestamp: [0.2, 1], text: "hello!" },
							]
						: [{ timestamp: [0.8, 0.8], text: "Original tail" }],
			};
		});
		const result = await runTranscription(transcriber, new Float32Array(32000), []);
		expect(result).toEqual({
			segments: [
				{ startSec: 0, endSec: 0.2, text: "Uh," },
				{ startSec: 0.2, endSec: 1, text: "hello!" },
				{ startSec: 1, endSec: 2, text: "Original tail" },
			],
			granularity: "mixed",
		});
		expect(transcriber).toHaveBeenCalledTimes(4);
		expect(
			transcriber.mock.calls
				.slice(2)
				.every(
					([audio, options]) => audio.length === 16000 && options.force_full_sequences === false,
				),
		).toBe(true);
	});

	it("keeps coarse words when a bounded refinement changes recognized content", async () => {
		const transcriber = vi.fn(async (audio, options) =>
			options.return_timestamps !== "word"
				? { chunks: [{ timestamp: [0, 1], text: "Original speech" }] }
				: audio.length === 32000
					? { chunks: [{ timestamp: [3, null], text: "bad" }] }
					: {
							chunks: [
								{ timestamp: [0, 0.4], text: "Different" },
								{ timestamp: [0.4, 1], text: "speech" },
							],
						},
		);
		expect(await runTranscription(transcriber, new Float32Array(32000), [])).toEqual({
			segments: [{ startSec: 0, endSec: 1, text: "Original speech" }],
			granularity: "phrase",
		});
	});

	it("skips phrases longer than 30 seconds and limits refinement to 200 phrases", async () => {
		const long = vi.fn(async (_audio, options) =>
			options.return_timestamps === "word"
				? { chunks: [{ timestamp: [32, null], text: "bad" }] }
				: { chunks: [{ timestamp: [0, 31], text: "complete speech" }] },
		);
		expect((await runTranscription(long, new Float32Array(31 * 16000), [])).granularity).toBe(
			"phrase",
		);
		expect(long).toHaveBeenCalledTimes(2);
		const budget = vi.fn(async (audio, options) =>
			options.return_timestamps !== "word"
				? {
						chunks: Array.from({ length: 201 }, (_, index) => ({
							timestamp: [index, index + 1],
							text: "hello",
						})),
					}
				: audio.length > 16000
					? { chunks: [{ timestamp: [300, null], text: "bad" }] }
					: { chunks: [{ timestamp: [0, 1], text: "hello" }] },
		);
		const result = await runTranscription(budget, new Float32Array(201 * 16000), []);
		expect(result.granularity).toBe("mixed");
		expect(result.segments).toHaveLength(201);
		expect(budget).toHaveBeenCalledTimes(202);
		expect(result.segments.at(-1)).toEqual({ startSec: 200, endSec: 201, text: "hello" });
	});
	it("keeps same-start speech order and repeated adjacent filler text", async () => {
		const transcriber = vi.fn().mockResolvedValue({
			chunks: [
				{ timestamp: [0.2, 0.8], text: "first" },
				{ timestamp: [0.2, 0.2], text: "zero" },
				{ timestamp: [0.2, 0.5], text: "last" },
				{ timestamp: [0.8, 0.9], text: "um" },
				{ timestamp: [0.9, 1], text: "um" },
			],
		});
		expect(
			(await runTranscription(transcriber, oneSecond, [])).segments.map((segment) => segment.text),
		).toEqual(["first", "zero last", "um", "um"]);
	});
	it("retains useful filler-word timing and all text when 15 of 111 DTW words share anchored zero-duration boundaries", async () => {
		const chunks: Array<{ timestamp: [number, number]; text: string }> = [
			{ timestamp: [0.1, 0.46], text: "Uh," },
			{ timestamp: [0.46, 1.24], text: "hello." },
			{ timestamp: [1.24, 1.66], text: "Um," },
		];
		for (let index = 0; index < 91; index++) {
			const start = 2 + index * 0.7,
				end = start + 0.3;
			chunks.push({ timestamp: [start, end], text: `word-${index}` });
			if (index < 2) chunks.push({ timestamp: [end, end], text: `internal-${index}` });
		}
		chunks.push(
			{ timestamp: [69.5, 69.98], text: "closing" },
			{ timestamp: [69.98, 70.08], text: "sentence" },
		);
		for (let index = 0; index < 13; index++)
			chunks.push({ timestamp: [70.08, 70.08], text: `tail-${index}` });
		expect(chunks).toHaveLength(111);
		const transcriber = vi.fn().mockResolvedValue({ chunks });
		const result = await runTranscription(transcriber, new Float32Array(1_121_648), []);
		expect(result.granularity).toBe("word");
		expect(result.segments).toHaveLength(96);
		expect(result.segments.slice(0, 3)).toEqual([
			{ startSec: 0.1, endSec: 0.46, text: "Uh," },
			{ startSec: 0.46, endSec: 1.24, text: "hello." },
			{ startSec: 1.24, endSec: 1.66, text: "Um," },
		]);
		expect(result.segments.map((segment) => segment.text).join(" ")).toBe(
			chunks.map((chunk) => chunk.text).join(" "),
		);
		expect(
			result.segments.every(
				(segment) => segment.endSec > segment.startSec && segment.endSec <= 70.103,
			),
		).toBe(true);
		expect(transcriber).toHaveBeenCalledTimes(1);
	});

	it("anchors a zero group to the next real span without giving it an independent cut boundary", async () => {
		const transcriber = vi.fn().mockResolvedValue({
			chunks: [
				{ timestamp: [0.2, 0.2], text: "first" },
				{ timestamp: [0.2, 0.2], text: "second" },
				{ timestamp: [0.2, 0.6], text: "third" },
				{ timestamp: [0.6, 1], text: "last" },
				{ timestamp: [1, null], text: "ending" },
			],
		});
		expect((await runTranscription(transcriber, oneSecond, [])).segments).toEqual([
			{ startSec: 0.2, endSec: 0.6, text: "first second third" },
			{ startSec: 0.6, endSec: 1, text: "last ending" },
		]);
	});
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
			"word",
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
