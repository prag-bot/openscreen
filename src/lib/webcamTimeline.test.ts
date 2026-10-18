import { describe, expect, it } from "vitest";
import { buildKeptClipSegments, mapKeptClipsToMedia } from "./exporter/hyperframesExporter";
import { buildWebcamDecodeTimeline, webcamSourceTimeSeconds } from "./webcamTimeline";

const trims = [{ id: "cut", startMs: 2000, endMs: 4000 }];
describe("shared webcam source clock", () => {
	it("unions overlapping manual/auto removals on the shifted camera clock", () => {
		const timeline = buildWebcamDecodeTimeline(10, 12, -2, [
			{ id: "manual", startMs: 2000, endMs: 8000 },
			{ id: "auto", startMs: 4000, endMs: 5000 },
		]);
		expect(timeline.trimRegions).toEqual([
			{ id: "webcam-clock-0", startMs: 0, endMs: 2000 },
			{ id: "webcam-clock-1", startMs: 4000, endMs: 10000 },
		]);
		expect(
			buildKeptClipSegments(12, timeline.trimRegions).map(({ sourceStart, duration }) => ({
				sourceStart,
				duration,
			})),
		).toEqual([
			{ sourceStart: 2, duration: 2 },
			{ sourceStart: 10, duration: 2 },
		]);
	});
	it("shifts cuts and speed boundaries into a leading camera's clock, retaining the end tail", () => {
		expect(
			buildWebcamDecodeTimeline(10, 13, -2, trims, [
				{ id: "speed", startMs: 6000, endMs: 8000, speed: 2 },
			]),
		).toEqual({
			hasFrames: true,
			trimRegions: [
				{ id: "webcam-clock-0", startMs: 0, endMs: 2000 },
				{ id: "webcam-clock-1", startMs: 4000, endMs: 6000 },
				{ id: "webcam-clock-2", startMs: 12000, endMs: 13000 },
			],
			speedRegions: [{ id: "speed", startMs: 8000, endMs: 10000, speed: 2 }],
		});
		expect(webcamSourceTimeSeconds(9.9, -2, 13)).toBe(11.9);
	});
	it("shows no frozen first/last frame outside a late/short camera's source range", () => {
		expect(webcamSourceTimeSeconds(1.9, 2, 5)).toBeNull();
		expect(webcamSourceTimeSeconds(2, 2, 5)).toBe(0);
		expect(webcamSourceTimeSeconds(6.9, 2, 5)).toBeCloseTo(4.9);
		expect(webcamSourceTimeSeconds(7, 2, 5)).toBeNull();
		expect(buildWebcamDecodeTimeline(10, 5, 20, trims).hasFrames).toBe(false);
	});
	it.each([-2, 2, 0])("matches editable HF source cuts for offset %s", (offset) => {
		const webcamDuration = 12;
		const timeline = buildWebcamDecodeTimeline(10, webcamDuration, offset, trims);
		const normalExportRanges = buildKeptClipSegments(webcamDuration, timeline.trimRegions);
		const hfRanges = mapKeptClipsToMedia(buildKeptClipSegments(10, trims), offset, webcamDuration);
		expect(
			normalExportRanges.map(({ sourceStart, duration }) => ({ sourceStart, duration })),
		).toEqual(hfRanges.map(({ sourceStart, duration }) => ({ sourceStart, duration })));
	});
});
