import { describe, expect, it } from "vitest";
import {
	getPresentationModeAt,
	type PresentationRegion,
	suggestPresentationRegions,
	validatePresentationRegions,
} from "./presentation";

const sampleRate = 1_000;

function narration(durationMs: number, ranges: Array<[number, number]> = [[0, durationMs]]) {
	const samples = new Float32Array(durationMs);
	for (const [start, end] of ranges)
		for (let index = start; index < end; index++) samples[index] = index % 2 ? 0.025 : -0.025;
	return samples;
}

function telemetry(durationMs: number) {
	return Array.from({ length: Math.floor(durationMs / 250) + 1 }, (_, index) => ({
		timeMs: index * 250,
		cx: 0.5,
		cy: 0.5,
		interactionType: "move",
	}));
}

function summarize(regions: PresentationRegion[]) {
	return regions.map(({ startMs, endMs, mode }) => ({ startMs, endMs, mode }));
}

function suggest(durationMs = 20_000) {
	return {
		durationMs,
		sampleRate,
		samples: narration(durationMs),
		cursorTelemetry: telemetry(durationMs),
	};
}

describe("presentation region validation and lookup", () => {
	const regions: PresentationRegion[] = [
		{ id: "a", startMs: 0, endMs: 5_000, mode: "demo" },
		{ id: "b", startMs: 5_000, endMs: 9_000, mode: "face-only", reason: "Review this candidate" },
	];

	it("accepts absent legacy settings and preserves valid gaps without sorting", () => {
		expect(validatePresentationRegions(undefined)).toEqual([]);
		expect(validatePresentationRegions(regions, 9_000)).toEqual(regions);
		expect(validatePresentationRegions([{ ...regions[1], startMs: 6_000 }], 10_000)).toEqual([
			{ ...regions[1], startMs: 6_000 },
		]);
	});

	it.each([
		[null],
		[[{ ...regions[0], startMs: -1 }]],
		[[{ ...regions[0], endMs: 0 }]],
		[[{ ...regions[0], endMs: Infinity }]],
		[[{ ...regions[0], startMs: NaN }]],
		[[{ ...regions[0], mode: "screen-only" }]],
		[[{ ...regions[0], id: " " }]],
		[[{ ...regions[0], reason: 42 }]],
		[[regions[0], { ...regions[1], startMs: 4_999 }]],
		[[regions[1], regions[0]]],
		[[regions[0], { ...regions[1], id: "a" }]],
	])("rejects malformed, unordered or overlapping source intervals (%j)", (value) => {
		expect(() => validatePresentationRegions(value)).toThrow();
	});

	it("rejects an out-of-source edit, invalid duration, and unbounded region count", () => {
		expect(() => validatePresentationRegions(regions, 8_999)).toThrow();
		expect(() => validatePresentationRegions([], 0)).toThrow();
		expect(() => validatePresentationRegions(new Array(2_001).fill(regions[0]))).toThrow();
	});

	it("uses half-open source times, with the incoming region winning a boundary", () => {
		expect(getPresentationModeAt(regions, -1)).toBeUndefined();
		expect(getPresentationModeAt(regions, 4_999.99)).toBe("demo");
		expect(getPresentationModeAt(regions, 5_000)).toBe("face-only");
		expect(getPresentationModeAt(regions, 9_000)).toBeUndefined();
		expect(getPresentationModeAt(regions, NaN)).toBeUndefined();
		expect(getPresentationModeAt([regions[1]], 4_999)).toBeUndefined();
	});
});

describe("reviewable presentation suggestions", () => {
	it("suggests a spoken camera-only intro without forcing its first five seconds to show the screen", () => {
		const options = suggest();
		const result = suggestPresentationRegions(options);
		expect(summarize(result)).toEqual([{ startMs: 0, endMs: 20_000, mode: "face-only" }]);
		expect(result).toEqual(suggestPresentationRegions(options));
		expect(result[0].reason).toMatch(/candidate.*Review/);
	});

	it("protects a stationary click with a one-second lead and five-second hold", () => {
		const options = suggest();
		options.cursorTelemetry[12_000 / 250].interactionType = "click";
		expect(summarize(suggestPresentationRegions(options))).toEqual([
			{ startMs: 0, endMs: 11_000, mode: "face-only" },
			{ startMs: 11_000, endMs: 17_000, mode: "demo" },
			{ startMs: 17_000, endMs: 20_000, mode: "face-only" },
		]);
	});

	it("keeps active pointer demos visible even while audio is present", () => {
		const options = suggest();
		options.cursorTelemetry.forEach((sample, index) => {
			sample.cx = index % 2 ? 0.2 : 0.8;
		});
		expect(summarize(suggestPresentationRegions(options))).toEqual([
			{ startMs: 0, endMs: 20_000, mode: "demo" },
		]);
	});

	it("treats scroll and release events as screen activity without pointer movement", () => {
		const options = suggest();
		options.cursorTelemetry[10_000 / 250].interactionType = "scroll";
		options.cursorTelemetry[15_000 / 250].interactionType = "mouseup";
		const result = suggestPresentationRegions(options);
		expect(getPresentationModeAt(result, 9_000)).toBe("demo");
		expect(getPresentationModeAt(result, 19_999)).toBe("demo");
	});

	it("ignores small pointer jitter but recognizes a slow meaningful displacement", () => {
		const options = suggest();
		options.cursorTelemetry.forEach((sample, index) => {
			sample.cx += index % 2 ? 0.002 : -0.002;
		});
		expect(getPresentationModeAt(suggestPresentationRegions(options), 10_000)).toBe("face-only");
		options.cursorTelemetry.forEach((sample, index) => {
			sample.cx = 0.5 + index * 0.001;
		});
		expect(summarize(suggestPresentationRegions(options))).toEqual([
			{ startMs: 0, endMs: 20_000, mode: "demo" },
		]);
	});

	it("keeps silent audio, quiet noise, and isolated peaks in demo mode", () => {
		const options = suggest();
		for (const amplitude of [0, 0.001]) {
			options.samples.fill(amplitude);
			expect(summarize(suggestPresentationRegions(options))).toEqual([
				{ startMs: 0, endMs: 20_000, mode: "demo" },
			]);
		}
		options.samples.fill(0);
		for (let index = 0; index < options.samples.length; index += 1_000)
			options.samples[index] = 0.02;
		expect(getPresentationModeAt(suggestPresentationRegions(options), 10_000)).toBe("demo");
	});

	it("does not cover long silent gaps or turn brief narration into face-only shots", () => {
		const options = suggest(30_000);
		options.samples = narration(30_000, [
			[5_000, 7_000],
			[10_000, 14_000],
			[24_000, 25_000],
		]);
		expect(summarize(suggestPresentationRegions(options))).toEqual([
			{ startMs: 0, endMs: 10_000, mode: "demo" },
			{ startMs: 10_000, endMs: 14_000, mode: "face-only" },
			{ startMs: 14_000, endMs: 30_000, mode: "demo" },
		]);
	});

	it("preserves a short pause in an otherwise sustained narration candidate", () => {
		const options = suggest();
		options.samples = narration(20_000, [
			[0, 10_000],
			[10_500, 20_000],
		]);
		expect(summarize(suggestPresentationRegions(options))).toHaveLength(1);
	});

	it("refuses absent, sparse, uncovered, unordered or invalid telemetry", () => {
		const options = suggest();
		expect(() => suggestPresentationRegions({ ...options, cursorTelemetry: [] })).toThrow(
			/manually/,
		);
		expect(() =>
			suggestPresentationRegions({
				...options,
				cursorTelemetry: [options.cursorTelemetry[0], options.cursorTelemetry.at(-1)!],
			}),
		).toThrow(/gaps/);
		expect(() =>
			suggestPresentationRegions({ ...options, cursorTelemetry: options.cursorTelemetry.slice(8) }),
		).toThrow(/cover/);
		expect(() =>
			suggestPresentationRegions({
				...options,
				cursorTelemetry: [...options.cursorTelemetry].reverse(),
			}),
		).toThrow(/invalid/);
		expect(() =>
			suggestPresentationRegions({
				...options,
				cursorTelemetry: options.cursorTelemetry.map((sample) => ({ ...sample, cx: NaN })),
			}),
		).toThrow(/invalid/);
	});

	it("never requests face-only before a delayed camera starts", () => {
		const options = suggest();
		expect(summarize(suggestPresentationRegions({ ...options, webcamOffsetMs: 12_000 }))).toEqual([
			{ startMs: 0, endMs: 12_000, mode: "demo" },
			{ startMs: 12_000, endMs: 20_000, mode: "face-only" },
		]);
		expect(summarize(suggestPresentationRegions({ ...options, webcamOffsetMs: 30_000 }))).toEqual([
			{ startMs: 0, endMs: 20_000, mode: "demo" },
		]);
	});

	it("retains uncovered audio tails as demo and rejects malformed audio", () => {
		const options = suggest();
		options.samples = narration(12_000);
		expect(summarize(suggestPresentationRegions(options))).toEqual([
			{ startMs: 0, endMs: 12_000, mode: "face-only" },
			{ startMs: 12_000, endMs: 20_000, mode: "demo" },
		]);
		options.samples[6_000] = NaN;
		expect(() => suggestPresentationRegions(options)).toThrow(/invalid audio/);
	});

	it("handles a long buffer and many samples without spreading or changing either input", () => {
		const options = suggest(600_000);
		const lastSample = options.samples.at(-1);
		const lastPoint = { ...options.cursorTelemetry.at(-1)! };
		const result = suggestPresentationRegions(options);
		expect(result).toHaveLength(1);
		expect(result[0].startMs).toBe(0);
		expect(result.at(-1)?.endMs).toBe(600_000);
		expect(options.samples.at(-1)).toBe(lastSample);
		expect(options.cursorTelemetry.at(-1)).toEqual(lastPoint);
		expect(validatePresentationRegions(result, 600_000)).toEqual(result);
	});
});
