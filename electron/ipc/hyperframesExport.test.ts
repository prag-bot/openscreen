// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const hyperframesRequest = {
	screenVideoPath: "/recording.mp4",
	durationSeconds: 2,
	width: 640,
	height: 480,
	trimRegions: [],
	webcamLayoutPreset: "no-webcam",
	webcamSizePreset: 25,
	webcamPosition: null,
	webcamMaskShape: "circle",
	webcamMirrored: false,
};
type Handler = (event: unknown, payload?: unknown) => Promise<Record<string, unknown>>;
const mocks = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	dialog: vi.fn(),
	project: vi.fn(),
	render: vi.fn(),
	resolve: vi.fn(),
}));
vi.mock("electron", () => ({
	app: { getPath: () => "/downloads" },
	dialog: { showSaveDialog: mocks.dialog },
	ipcMain: { handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler) },
}));
vi.mock("../export/hyperframesProject", () => ({ writeHyperframesProject: mocks.project }));
vi.mock("../export/hyperframesRender", () => ({
	renderHyperframesVideo: mocks.render,
	resolveHyperframesExecutable: mocks.resolve,
}));

import { registerHyperframesExportHandler } from "./hyperframesExport";

describe("explicit HyperFrames project versus video IPC", () => {
	const event = { sender: { id: 7, isDestroyed: () => false, send: vi.fn() } };
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.handlers.clear();
		mocks.dialog.mockResolvedValue({ canceled: false, filePath: "/downloads/new-project" });
		mocks.resolve.mockResolvedValue("/opt/homebrew/bin/hyperframes");
		mocks.project.mockResolvedValue({
			path: "/downloads/new-project",
			warnings: [],
			audioTrackCount: 2,
		});
		mocks.render.mockResolvedValue({ videoPath: "/downloads/new-project/edited.mp4" });
		registerHyperframesExportHandler({
			getMainWindow: () => null,
			resolveApprovedMediaPath: async (file) => file,
		});
	});
	it("returns the exact final MP4 path and its retained editable project", async () => {
		const result = await mocks.handlers.get("export-hyperframes-video")!(event, hyperframesRequest);
		expect(result).toMatchObject({
			success: true,
			path: "/downloads/new-project/edited.mp4",
			videoPath: "/downloads/new-project/edited.mp4",
			projectPath: "/downloads/new-project",
		});
		expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ expectedAudio: true }));
	});
	it("keeps project-only export available without starting a renderer", async () => {
		expect(
			await mocks.handlers.get("export-hyperframes-project")!(event, hyperframesRequest),
		).toMatchObject({ success: true, path: "/downloads/new-project" });
		expect(mocks.render).not.toHaveBeenCalled();
	});
	it("fails missing local tools before creating a project and never claims a video", async () => {
		mocks.resolve.mockRejectedValue(new Error("No installed local HyperFrames"));
		expect(
			await mocks.handlers.get("export-hyperframes-video")!(event, hyperframesRequest),
		).toMatchObject({ success: false, error: expect.stringContaining("installed") });
		expect(mocks.project).not.toHaveBeenCalled();
	});
	it("rejects duplicate jobs even while the native destination dialog is open", async () => {
		let release!: (value: unknown) => void;
		mocks.dialog.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const job = mocks.handlers.get("export-hyperframes-video")!(event, hyperframesRequest);
		await vi.waitFor(() => expect(mocks.dialog).toHaveBeenCalledOnce());
		expect(
			await mocks.handlers.get("export-hyperframes-project")!(event, hyperframesRequest),
		).toMatchObject({ success: false, error: expect.stringMatching(/already/i) });
		release({ canceled: true });
		await expect(job).resolves.toMatchObject({ success: false, canceled: true });
	});
	it("reports a render error with recoverable project, not a finished-video result", async () => {
		mocks.render.mockRejectedValue(new Error("missing Chrome"));
		const result = await mocks.handlers.get("export-hyperframes-video")!(event, hyperframesRequest);
		expect(result).toMatchObject({
			success: false,
			projectPath: "/downloads/new-project",
			error: expect.stringContaining("missing Chrome"),
		});
		expect(result.videoPath).toBeUndefined();
	});
	it("never acknowledges cancellation after the renderer enters its publication commit", async () => {
		mocks.render.mockImplementationOnce(
			async (options: { onPublicationCommit: () => void; signal: AbortSignal }) => {
				options.onPublicationCommit();
				expect(await mocks.handlers.get("cancel-hyperframes-export")!(event)).toMatchObject({
					success: false,
				});
				expect(options.signal.aborted).toBe(false);
				return { videoPath: "/downloads/new-project/edited.mp4" };
			},
		);
		await expect(
			mocks.handlers.get("export-hyperframes-video")!(event, hyperframesRequest),
		).resolves.toMatchObject({ success: true, videoPath: "/downloads/new-project/edited.mp4" });
	});
	it("acknowledges precommit cancellation only when the render will not publish a video", async () => {
		mocks.render.mockImplementationOnce(async (options: { signal: AbortSignal }) => {
			expect(await mocks.handlers.get("cancel-hyperframes-export")!(event)).toMatchObject({
				success: true,
			});
			expect(options.signal.aborted).toBe(true);
			throw new Error("HyperFrames export canceled; editable project retained");
		});
		const result = await mocks.handlers.get("export-hyperframes-video")!(event, hyperframesRequest);
		expect(result).toMatchObject({ success: false, canceled: true });
		expect(result.videoPath).toBeUndefined();
	});
});
