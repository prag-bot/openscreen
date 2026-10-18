import { describe, expect, it } from "vitest";
import { canonicalRemovalRanges, keptSourceRanges, removedDurationBefore } from "./removalRanges";

describe("shared export removal union", () => {
	it("merges nested, partial and touching cuts, clamps bounds and preserves editor input", () => {
		const raw = [
			{ id: "late", startMs: 8000, endMs: 12000 },
			{ id: "manual", startMs: 2000, endMs: 6000 },
			{ id: "auto-nested", startMs: 3000, endMs: 4000 },
			{ id: "partial", startMs: 5000, endMs: 7000 },
			{ id: "touch", startMs: 7000, endMs: 8000 },
			{ id: "negative", startMs: -1000, endMs: 500 },
			{ id: "empty", startMs: 1000, endMs: 1000 },
		];
		const snapshot = structuredClone(raw);
		expect(canonicalRemovalRanges(10000, raw)).toEqual([
			{ startMs: 0, endMs: 500 },
			{ startMs: 2000, endMs: 10000 },
		]);
		expect(keptSourceRanges(10000, raw)).toEqual([{ startMs: 500, endMs: 2000 }]);
		expect(removedDurationBefore(9000, raw)).toBe(7500);
		expect(raw).toEqual(snapshot);
	});
	it("keeps canonical input read-only without repeated sorting/allocation", () => {
		const raw = [
			{ startMs: 1000, endMs: 2000 },
			{ startMs: 3000, endMs: 4000 },
		];
		expect(canonicalRemovalRanges(10000, raw)).toBe(raw);
	});
	it("returns no kept range when all footage is removed", () => {
		expect(keptSourceRanges(10000, [{ startMs: -1, endMs: 11000 }])).toEqual([]);
	});
	it.each([
		{ startMs: NaN, endMs: 1 },
		{ startMs: 2, endMs: 1 },
		{ startMs: 0, endMs: Infinity },
	])("rejects invalid timing %s", (range) => {
		expect(() => canonicalRemovalRanges(10000, [range])).toThrow();
	});
});
