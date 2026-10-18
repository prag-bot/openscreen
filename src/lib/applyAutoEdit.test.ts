import { describe, expect, it } from "vitest";
import { buildAutoEditTrims } from "./applyAutoEdit";
import type { AutoEditPlan } from "./autoEdit";
import { buildKeptClipSegments } from "./exporter/hyperframesExporter";

const plan: AutoEditPlan = {
	cuts: [{ startMs: 2000, endMs: 4000, reason: "Repeated sentence", source: "codex" }],
	summary: "Tighter demo",
	originalDurationSeconds: 10,
	removedSeconds: 2,
};
describe("apply Codex cut plan", () => {
	it("retains manual cuts and applies the same source-clock trims for HyperFrames", () => {
		const original = [{ id: "trim-1", startMs: 5000, endMs: 6000 }];
		const next = buildAutoEditTrims(plan, 10, original, 2);
		expect(next.trims).toEqual([...original, { id: "trim-2", startMs: 2000, endMs: 4000 }]);
		expect(original).toHaveLength(1);
		expect(next.nextId).toBe(3);
		expect(buildKeptClipSegments(10, next.trims)).toEqual([
			{ sourceStart: 0, timelineStart: 0, duration: 2 },
			{ sourceStart: 4, timelineStart: 2, duration: 1 },
			{ sourceStart: 6, timelineStart: 3, duration: 4 },
		]);
	});
	it("rejects stale duration, invalid ranges and a fully removed remaining demo", () => {
		expect(() => buildAutoEditTrims(plan, 20, [], 1)).toThrow(/changed/);
		expect(() =>
			buildAutoEditTrims({ ...plan, cuts: [{ ...plan.cuts[0], startMs: Number.NaN }] }, 10, [], 1),
		).toThrow(/outside/);
		expect(() =>
			buildAutoEditTrims(plan, 10, [{ id: "manual", startMs: 0, endMs: 10000 }], 1),
		).toThrow(/removed|entire/);
	});
});
