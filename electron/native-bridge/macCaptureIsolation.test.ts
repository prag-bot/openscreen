// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import {
	assertNativeMacCaptureIsolation,
	withRecorderCaptureExclusion,
} from "./macCaptureIsolation";

const request: NativeMacRecordingRequest = {
	schemaVersion: 1,
	source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
	video: { fps: 60, width: 1920, height: 1080, hideSystemCursor: true },
	audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
	webcam: { enabled: false, width: 0, height: 0, fps: 30 },
	cursor: { mode: "editable-overlay" },
	outputs: { screenPath: "/recording.mp4" },
};

describe("macOS recorder capture isolation", () => {
	it.each([
		"editable-overlay",
		"system",
	] as const)("serializes the trusted recorder PID for %s cursor mode without changing footage settings", (mode) => {
		const input = { ...request, cursor: { mode } };
		const prepared = withRecorderCaptureExclusion(input, 4123);
		expect(JSON.parse(JSON.stringify(prepared))).toEqual({
			...input,
			captureExclusion: { processId: 4123 },
		});
		expect(input).not.toHaveProperty("captureExclusion");
	});

	it("replaces untrusted renderer-supplied identity instead of excluding another app", () => {
		const input = { ...request, captureExclusion: { processId: 9999 } };
		expect(withRecorderCaptureExclusion(input, 4123).captureExclusion).toEqual({ processId: 4123 });
		expect(input.captureExclusion.processId).toBe(9999);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		2 ** 31,
	])("rejects an invalid main-process identity (%s) instead of permitting unfiltered capture", (processId) => {
		expect(() => withRecorderCaptureExclusion(request, processId)).toThrow(/process id/i);
	});

	it("accepts acknowledgement only for the current recorder process", () => {
		expect(() =>
			assertNativeMacCaptureIsolation({ excludedRecorderProcessId: 4123 }, 4123),
		).not.toThrow();
	});

	it.each([
		{},
		{ excludedRecorderProcessId: 9999 },
		{ excludedRecorderProcessId: "4123" },
	])("rejects old or mismatched helper acknowledgement: %s", (event) => {
		expect(() => assertNativeMacCaptureIsolation(event, 4123)).toThrow(/exclusion/);
	});

	// These contract checks deliberately inspect the platform implementation: they run
	// without screen/camera access and fail if the tested identity stops reaching SCK.
	it("uses the trusted builder at the helper spawn boundary", () => {
		const handlers = readFileSync(new URL("../ipc/handlers.ts", import.meta.url), "utf8");
		const nativeHandler = handlers.slice(
			handlers.indexOf('ipcMain.handle("start-native-mac-recording"'),
		);
		expect(nativeHandler).toMatch(/withRecorderCaptureExclusion\([\s\S]*?process\.pid\s*,?\s*\)/);
		expect(nativeHandler).toContain("JSON.stringify(config)");
		expect(handlers).toContain("assertNativeMacCaptureIsolation(event, process.pid)");
	});

	it("requires recorder identity and excludes the owning application, not only a window snapshot", () => {
		const helper = readFileSync(
			new URL(
				"../native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/main.swift",
				import.meta.url,
			),
			"utf8",
		);
		expect(helper).toContain("let captureExclusion: CaptureExclusion");
		expect(helper).toMatch(/processID\s*==\s*request\.captureExclusion\.processId/);
		expect(helper).toMatch(
			/SCContentFilter\(\s*display: display,\s*excludingApplications: \[recorderApplication\],\s*exceptingWindows: \[\]/,
		);
		expect(helper).not.toContain("SCContentFilter(display: display, excludingWindows: [])");
		expect(helper).toContain("Recorder-owned windows cannot be recorded.");
		expect(helper).toContain('"excludedRecorderProcessId": request.captureExclusion.processId');
	});
});
