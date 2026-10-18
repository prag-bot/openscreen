import { describe, expect, it } from "vitest";
import {
	measureNativeMacWebcamOffsetSeconds,
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
	requireNativeMacScreenStartTime,
} from "./nativeMacRecording";

describe("native camera/screen start clocks", () => {
	it("measures signed lead-in and late-start offsets without IPC receipt time", () => {
		expect(measureNativeMacWebcamOffsetSeconds(10_000, 11_250)).toBe(-1.25);
		expect(measureNativeMacWebcamOffsetSeconds(11_250, 10_000)).toBe(1.25);
		expect(measureNativeMacWebcamOffsetSeconds(10_000, 10_000)).toBe(0);
	});
	it.each([
		undefined,
		NaN,
		Infinity,
		-1,
		0,
		"10000",
	])("rejects a missing/invalid helper clock (%s)", (value) => {
		expect(() => requireNativeMacScreenStartTime({ screenStartedAtUnixMs: value })).toThrow(
			/first-frame clock/,
		);
	});
});

describe("nativeMacRecording source parsing", () => {
	it("parses Electron window source ids into ScreenCaptureKit window ids", () => {
		expect(parseMacWindowIdFromSourceId("window:12345:0")).toBe(12345);
		expect(parseMacWindowIdFromSourceId("window:987")).toBe(987);
	});

	it("rejects non-window source ids for window parsing", () => {
		expect(parseMacWindowIdFromSourceId("screen:1:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId("window:not-a-number:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId(null)).toBeNull();
	});

	it("parses Electron display source ids into ScreenCaptureKit display ids", () => {
		expect(parseMacDisplayIdFromSourceId("screen:1:0")).toBe(1);
		expect(parseMacDisplayIdFromSourceId("screen:69733248")).toBe(69733248);
	});

	it("rejects non-display source ids for display parsing", () => {
		expect(parseMacDisplayIdFromSourceId("window:123:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId("screen:not-a-number:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId(undefined)).toBeNull();
	});
});
