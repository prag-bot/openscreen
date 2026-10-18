import { describe, expect, it } from "vitest";
import type { TrimRegion } from "@/components/video-editor/types";
import { buildKeptClipSegments } from "./hyperframesExporter";
import {
	StreamingVideoDecoder,
	shouldFailDecodeEndedEarly,
	validateDuration,
} from "./streamingDecoder";

describe("real decoder removal segments/metrics", () => {
	it.each([
		[
			[
				[2000, 8000],
				[4000, 5000],
			],
			[
				[0, 2],
				[8, 10],
			],
			4,
		],
		[
			[
				[2000, 5000],
				[4000, 8000],
			],
			[
				[0, 2],
				[8, 10],
			],
			4,
		],
		[
			[
				[2000, 4000],
				[4000, 8000],
			],
			[
				[0, 2],
				[8, 10],
			],
			4,
		],
		[
			[
				[-2000, 2000],
				[8000, 12000],
				[5000, 5000],
				[20000, 21000],
			],
			[[2, 8]],
			6,
		],
	] as const)("matches HF for union of %j", (ranges, expected, duration) => {
		const trims = ranges.map(([startMs, endMs], index) => ({
			id: `trim-${index}`,
			startMs,
			endMs,
		}));
		const snapshot = structuredClone(trims);
		const decoder = new StreamingVideoDecoder();
		const real = decoder as unknown as {
			metadata: { duration: number };
			computeSegments: (
				totalDuration: number,
				trims: TrimRegion[],
			) => { startSec: number; endSec: number }[];
		};
		real.metadata = { duration: 10 }; // synthetic metadata; no media/WebCodecs needed
		const segments = real.computeSegments(10, trims);
		expect(segments).toEqual(expected.map(([startSec, endSec]) => ({ startSec, endSec })));
		expect(decoder.getExportMetrics(30, trims)).toEqual({
			effectiveDuration: duration,
			totalFrames: duration * 30,
		});
		expect(
			buildKeptClipSegments(10, trims).map(({ sourceStart, duration }) => ({
				startSec: sourceStart,
				endSec: sourceStart + duration,
			})),
		).toEqual(segments);
		expect(trims).toEqual(snapshot);
	});
});

describe("validateDuration", () => {
	it("returns scanned duration when container reports Infinity", () => {
		expect(validateDuration(Infinity, 15.3)).toBe(15.3);
	});

	it("returns scanned duration when container reports 0", () => {
		expect(validateDuration(0, 15.3)).toBe(15.3);
	});

	it("returns scanned duration when container reports NaN", () => {
		expect(validateDuration(NaN, 15.3)).toBe(15.3);
	});

	it("returns scanned duration when container is inflated beyond threshold", () => {
		expect(validateDuration(42, 15.3)).toBe(15.3);
	});

	it("returns container duration when values are close", () => {
		expect(validateDuration(15.5, 15.3)).toBe(15.5);
	});

	it("returns container duration when scanned is slightly higher", () => {
		// container < scanned (scanned overshoot from last frame duration)
		expect(validateDuration(15.0, 15.3)).toBe(15.0);
	});

	it("returns scanned duration when container under-reports beyond threshold", () => {
		expect(validateDuration(10, 15.3)).toBe(15.3);
	});

	it("returns container duration when scanned is zero (corrupted/empty file)", () => {
		expect(validateDuration(10, 0)).toBe(10);
	});

	it("returns 0 when both container is NaN and scanned is zero", () => {
		expect(validateDuration(NaN, 0)).toBe(0);
	});
});

describe("shouldFailDecodeEndedEarly", () => {
	it("does not fail once every segment has been satisfied", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 5.33,
				requiredEndSec: 6.498,
				streamDurationSec: 5.33,
			}),
		).toBe(false);
	});

	it("fails when decode stops far before the required end", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 5.33,
				requiredEndSec: 10,
				streamDurationSec: 5.33,
			}),
		).toBe(true);
	});

	it("fails when no frame could be decoded for a non-empty timeline", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: null,
				requiredEndSec: 1,
			}),
		).toBe(true);
	});

	it("fails when the decoder has not reached the reported stream end", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 4.9,
				requiredEndSec: 6.498,
				streamDurationSec: 5.33,
			}),
		).toBe(true);
	});
});
