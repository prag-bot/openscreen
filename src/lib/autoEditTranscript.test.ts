import { describe, expect, it, vi } from "vitest";
import { validateAutoEditRequest } from "../../electron/auto-edit/codexPlanner";
import { normalizeLocalAutoEditTranscript } from "./autoEditTranscript";
import { runTranscription } from "./captioning/transcribeCore";

describe("local auto-edit transcript normalization", () => {
	it("passes real ASR minimum-word-duration output into the strict IPC validator", async () => {
		const samples = new Float32Array(16000);
		const transcriber = vi.fn().mockResolvedValue({
			chunks: [
				{ timestamp: [0, 0.04], text: "a" },
				{ timestamp: [0.04, 0.4], text: "test" },
				{ timestamp: [0.4, 1], text: "sentence" },
			],
		});
		const transcription = await runTranscription(transcriber, samples, []);
		expect(transcription.segments[0]).toEqual({ startSec: 0, endSec: 0.08, text: "a" });
		const rawRequest = {
			jobId: "test-job",
			durationSeconds: 1,
			instructions: "Clean up",
			tightenPauses: false,
			segments: transcription.segments,
		};
		// Untrusted overlapping IPC is still rejected. Only the local boundary merges.
		expect(() => validateAutoEditRequest(rawRequest)).toThrow();
		const segments = normalizeLocalAutoEditTranscript(transcription.segments);
		expect(segments).toEqual([
			{ startSec: 0, endSec: 0.4, text: "a test" },
			{ startSec: 0.4, endSec: 1, text: "sentence" },
		]);
		expect(() => validateAutoEditRequest({ ...rawRequest, segments })).not.toThrow();
		expect(transcription.segments).toHaveLength(3);
	});

	it("merges chained/nested overlaps while preserving repeated text, order and gaps", () => {
		expect(
			normalizeLocalAutoEditTranscript([
				{ startSec: 1, endSec: 2, text: "one" },
				{ startSec: 1.1, endSec: 1.2, text: "one" },
				{ startSec: 1.9, endSec: 3, text: "two" },
				{ startSec: 4, endSec: 5, text: "three" },
			]),
		).toEqual([
			{ startSec: 1, endSec: 3, text: "one one two" },
			{ startSec: 4, endSec: 5, text: "three" },
		]);
	});

	it("clips only bounded recording edges and preserves interior words and gaps", () => {
		const source = [
			{ startSec: -0.02, endSec: 0.3, text: "first" },
			{ startSec: 1.24, endSec: 2.36, text: "middle" },
			{ startSec: 9.7, endSec: 10.04, text: "last" },
		];
		expect(normalizeLocalAutoEditTranscript(source, { durationSeconds: 10 })).toEqual([
			{ ...source[0], startSec: 0 },
			source[1],
			{ ...source[2], endSec: 10 },
		]);
		expect(source[0].startSec).toBe(-0.02);
		expect(source[2].endSec).toBe(10.04);
	});

	it("handles a restored leading-trim ULP overshoot without relaxing the IPC validator", () => {
		const durationSeconds = 799_001 / 16_000;
		const trimSec = 14_080 / 16_000;
		const restoredEnd = (799_001 - 14_080) / 16_000 + trimSec;
		expect(restoredEnd).toBeGreaterThan(durationSeconds);
		const request = {
			jobId: "floating-tail",
			durationSeconds,
			instructions: "Clean up",
			tightenPauses: false,
			segments: [{ startSec: 48, endSec: restoredEnd, text: "last words" }],
		};
		expect(() => validateAutoEditRequest(request)).toThrow(/out-of-range/);
		const segments = normalizeLocalAutoEditTranscript(request.segments, { durationSeconds });
		expect(segments[0].endSec).toBe(durationSeconds);
		expect(() => validateAutoEditRequest({ ...request, segments })).not.toThrow();
	});

	it("preserves the strict millisecond source boundary for fractional-duration recordings", () => {
		const durationSeconds = 1.001;
		const segments = normalizeLocalAutoEditTranscript(
			[{ startSec: 0.98, endSec: 1.0010000000000001, text: "tail" }],
			{ durationSeconds },
		);
		expect(segments[0].endSec).toBe(durationSeconds);
		expect(() =>
			validateAutoEditRequest({
				jobId: "millisecond-tail",
				durationSeconds,
				instructions: "Clean up",
				tightenPauses: false,
				segments,
			}),
		).not.toThrow();
	});

	it.each([
		[{ startSec: 80.89, endSec: 70.77331249999999, text: "model tail" }],
		[{ startSec: NaN, endSec: 2, text: "invalid" }],
		[{ startSec: 1, endSec: Infinity, text: "invalid" }],
		[{ startSec: 1, endSec: 1, text: "invalid" }],
		[{ startSec: -0.2, endSec: 1, text: "invalid" }],
		[{ startSec: 9, endSec: 10.2, text: "invalid" }],
		[{ startSec: 10.01, endSec: 10.05, text: "outside" }],
		[
			{ startSec: 1, endSec: 2, text: "later" },
			{ startSec: 0.5, endSec: 0.8, text: "earlier" },
		],
		[{ startSec: 1, endSec: 2, text: " " }],
		[{ startSec: 1, endSec: 2, text: "bad\0text" }],
		[{ startSec: 1, endSec: 1.0001, text: "unplaceable" }],
	])("rejects malformed or unplaceable local output without discarding its text (%j)", (...segments) => {
		expect(() => normalizeLocalAutoEditTranscript(segments, { durationSeconds: 10 })).toThrow(
			/local speech transcript/,
		);
	});
});
