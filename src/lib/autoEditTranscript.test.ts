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
});
