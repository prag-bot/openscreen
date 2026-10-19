// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

describe("cursor access IPC and preload executable contracts", () => {
	// Execute the actual registration in isolation: unrelated recording IPC and OS
	// acquisition are intentionally excluded. This tests behavior, not Electron UI.
	it.each([
		undefined,
		{},
		null,
		true,
		{ prompt: "true" },
		{ prompt: false },
		{ prompt: true },
	])("normalizes IPC prompt input and never opens a modal/settings (%j)", async (options) => {
		const source = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
		const start = source.indexOf('ipcMain.handle("request-native-mac-cursor-access"');
		const end = source.indexOf('ipcMain.handle("open-source-selector"', start);
		let handler!: (_event: unknown, options?: unknown) => Promise<unknown>;
		const request = vi.fn().mockResolvedValue({ success: true, granted: false });
		const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
		const openExternal = vi.fn();
		runInNewContext(transformSync(source.slice(start, end), { loader: "ts" }).code, {
			ipcMain: {
				handle: (_name: string, callback: typeof handler) => {
					handler = callback;
				},
			},
			requestMacCursorAccessibilityAccess: request,
			process: { platform: "darwin" },
			getMainWindow: () => null,
			dialog: { showMessageBox },
			shell: { openExternal },
		});
		await expect(handler({}, options)).resolves.toMatchObject({ granted: false });
		expect(request).toHaveBeenCalledExactlyOnceWith({
			prompt: typeof options === "object" && options?.prompt === true,
		});
		expect(showMessageBox).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("preload sends only a normalized typed explicit prompt option, defaulting quiet", () => {
		let api!: Window["electronAPI"];
		const invoke = vi.fn();
		const source = readFileSync(new URL("../preload.ts", import.meta.url), "utf8");
		runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code, {
			process: { argv: [] },
			require: () => ({
				contextBridge: {
					exposeInMainWorld: (_name: string, value: typeof api) => {
						api = value;
					},
				},
				ipcRenderer: { invoke },
			}),
		});
		api.requestNativeMacCursorAccess();
		api.requestNativeMacCursorAccess({ prompt: true });
		api.requestNativeMacCursorAccess({ prompt: "true" } as never);
		expect(invoke.mock.calls).toEqual([
			["request-native-mac-cursor-access", { prompt: false }],
			["request-native-mac-cursor-access", { prompt: true }],
			["request-native-mac-cursor-access", { prompt: false }],
		]);
	});

	it("fails the actual macOS recording handler before screen-helper spawn if the editable cursor cannot start", async () => {
		const source = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
		const cursorStart = source.indexOf("async function startCursorRecording(");
		const cursorEnd = source.indexOf("async function stopCursorRecording(", cursorStart);
		const handlerStart = source.indexOf('ipcMain.handle("start-native-mac-recording"');
		const handlerEnd = source.indexOf('ipcMain.handle("pause-native-mac-recording"', handlerStart);
		let handler!: (_event: unknown, request: unknown) => Promise<unknown>;
		const spawn = vi.fn();
		const session = {
			start: vi
				.fn()
				.mockRejectedValue(new Error("Editable cursor unavailable. Use the system cursor.")),
			stop: vi.fn().mockResolvedValue({ samples: [], assets: [] }),
		};
		runInNewContext(
			transformSync(source.slice(cursorStart, cursorEnd) + source.slice(handlerStart, handlerEnd), {
				loader: "ts",
			}).code,
			{
				ipcMain: {
					handle: (_name: string, callback: typeof handler) => {
						handler = callback;
					},
				},
				process: { platform: "darwin", pid: 4123 },
				path,
				cursorRecordingSession: null,
				pendingCursorRecordingData: null,
				nativeMacCaptureProcess: null,
				createCursorRecordingSession: () => session,
				getSelectedSourceBounds: () => null,
				MAX_CURSOR_SAMPLES: 100,
				CURSOR_SAMPLE_INTERVAL_MS: 33,
				getSelectedSourceId: () => "screen:1:0",
				findNativeMacCaptureHelperPath: async () => "/virtual/screen-helper",
				normalizeCursorCaptureMode: () => "editable-overlay",
				desktopCapturer: { getSources: async () => [] },
				screen: { getAllDisplays: () => [] },
				withRecorderCaptureExclusion: (request: unknown) => request,
				fs: { mkdir: vi.fn().mockResolvedValue(undefined) },
				spawn,
				RECORDINGS_DIR: "/virtual/recordings",
				RECORDING_FILE_PREFIX: "recording-",
				RECORDING_SESSION_SUFFIX: ".session.json",
				console: { info: vi.fn(), error: vi.fn() },
				stopCursorRecording: vi.fn().mockResolvedValue(undefined),
			},
		);
		await expect(
			handler(
				{},
				{
					source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
					video: {},
					audio: { microphone: { enabled: false } },
					webcam: {},
					cursor: { mode: "editable-overlay" },
				},
			),
		).resolves.toMatchObject({ success: false, error: expect.stringMatching(/system cursor/i) });
		expect(session.start).toHaveBeenCalledOnce();
		expect(session.stop).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe("native cursor helper source contract (not a runtime permission or event-tap test)", () => {
	it("gates prompting, skips taps when untrusted, and uses probe-only mode", () => {
		const source = readFileSync(
			new URL(
				"../native/screencapturekit/Sources/OpenScreenMacOSCursorHelper/main.swift",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).toContain("let promptAccessibility: Bool?");
		expect(source).toContain("let accessibilityProbeOnly: Bool?");
		expect(source).toContain("guard prompt else { return AXIsProcessTrusted() }");
		expect(source).toContain(
			"requestAccessibilityTrust(prompt: request.promptAccessibility == true)",
		);
		expect(source).toContain(
			"accessibilityTrusted && request.accessibilityProbeOnly != true && mouseTracker.start()",
		);
		expect(source).toContain(
			"if request.accessibilityProbeOnly == true || !accessibilityTrusted { exit(0) }",
		);
	});
	it("propagates cursor-session startup failures before native macOS screen capture", () => {
		const source = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
		expect(source).toContain("await startCursorRecording(cursorStartTimeMs, true)");
		expect(source).toContain("if (requireCursorCapture) throw error;");
	});
});
