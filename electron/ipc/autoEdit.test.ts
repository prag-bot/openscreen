import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRequest } from "../auto-edit/processRunner";

type TestSender = EventEmitter & { id: number; isDestroyed: () => boolean };
type TestHandler = (
	event: { sender: TestSender },
	payload?: unknown,
) => Promise<{ success: boolean; path?: string }>;
const state = vi.hoisted(() => ({
	handlers: new Map<string, TestHandler>(),
	extract: vi.fn(),
	propose: vi.fn(),
	run: vi.fn(),
}));
vi.mock("electron", () => ({
	app: { getPath: () => "/tmp" },
	ipcMain: { handle: (name: string, callback: TestHandler) => state.handlers.set(name, callback) },
}));
vi.mock("../autoEditAudio", () => ({ extractNarrationWav: state.extract }));
vi.mock("../auto-edit/processRunner", async (importOriginal) => ({
	...(await importOriginal<typeof import("../auto-edit/processRunner")>()),
	runBoundedProcess: state.run,
}));
vi.mock("../auto-edit/codexPlanner", () => ({
	createAutoEditPlan: state.propose,
	getAutoEditStatus: async () => ({ available: true, message: "Ready" }),
}));

import { registerAutoEditHandlers } from "./autoEdit";

function sender(id: number) {
	return Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
}
describe("auto-edit IPC ownership", () => {
	const approve = vi.fn();
	const revoke = vi.fn();
	const resolveMedia = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		state.handlers.clear();
		resolveMedia.mockResolvedValue("/approved.mp4");
		state.extract.mockImplementation(async (_source, target) => {
			await fs.writeFile(target, new Uint8Array(100));
		});
		state.propose.mockResolvedValue({
			cuts: [],
			summary: "Keep it",
			originalDurationSeconds: 10,
			removedSeconds: 0,
		});
		registerAutoEditHandlers({
			resolveApprovedMediaPath: resolveMedia,
			approvePath: approve,
			revokePath: revoke,
		});
	});
	it("approves only its generated audio, plans once and cleans the derivative", async () => {
		const event = { sender: sender(1) };
		const prepared = await state.handlers.get("prepare-auto-edit-audio")!(event, {
			jobId: "job-a",
			videoPath: "/source.mp4",
		});
		expect(prepared.success).toBe(true);
		expect(state.extract).toHaveBeenCalledWith(
			"/approved.mp4",
			expect.stringMatching(/openscreen-auto-edit-audio-.+\/narration\.wav$/),
			expect.any(AbortSignal),
		);
		expect(approve).toHaveBeenCalledOnce();
		const result = await state.handlers.get("plan-auto-edit")!(event, { jobId: "job-a" });
		expect(result.success).toBe(true);
		expect(revoke).toHaveBeenCalledWith(approve.mock.calls[0][0]);
		await expect(fs.stat(approve.mock.calls[0][0])).rejects.toThrow();
		const repeated = await state.handlers.get("plan-auto-edit")!(event, { jobId: "job-a" });
		expect(repeated.success).toBe(false);
		expect(state.propose).toHaveBeenCalledOnce();
	});
	it("rejects unapproved paths without creating or approving audio", async () => {
		resolveMedia.mockResolvedValue(null);
		const result = await state.handlers.get("prepare-auto-edit-audio")!(
			{ sender: sender(1) },
			{ jobId: "job-a", videoPath: "/unapproved.mp4" },
		);
		expect(result.success).toBe(false);
		expect(state.extract).not.toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
	});
	it("honors cancellation even while path approval is unresolved", async () => {
		let release!: (value: string) => void;
		resolveMedia.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const event = { sender: sender(1) };
		const preparation = state.handlers.get("prepare-auto-edit-audio")!(event, {
			jobId: "job-a",
			videoPath: "/source.mp4",
		});
		await state.handlers.get("cancel-auto-edit")!(event, "job-a");
		release("/approved.mp4");
		const result = await preparation;
		expect(result.success).toBe(false);
		expect(state.extract).not.toHaveBeenCalled();
	});
	it("another renderer cannot cancel the owning renderer's job", async () => {
		const event = { sender: sender(1) };
		await state.handlers.get("prepare-auto-edit-audio")!(event, {
			jobId: "job-a",
			videoPath: "/source.mp4",
		});
		await state.handlers.get("cancel-auto-edit")!({ sender: sender(2) }, "job-a");
		const result = await state.handlers.get("plan-auto-edit")!(event, { jobId: "job-a" });
		expect(result.success).toBe(true);
		expect(state.propose.mock.calls[0][1].signal.aborted).toBe(false);
	});
	it.each([
		"afinfo",
		"afconvert",
	])("cancels during %s, removes only its derivative and frees the owning editor's job", async (stage) => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
		try {
			const { extractNarrationWav } =
				await vi.importActual<typeof import("../autoEditAudio")>("../autoEditAudio");
			state.extract.mockImplementation(extractNarrationWav);
			state.run.mockImplementation(async (request: ProcessRequest) => {
				if (request.command.endsWith(stage)) {
					if (stage === "afconvert") await fs.writeFile(request.args.at(-1)!, new Uint8Array(20));
					await new Promise<void>((_resolve, reject) => {
						const cancel = () => reject(new Error("Native process canceled"));
						if (request.signal?.aborted) cancel();
						else request.signal?.addEventListener("abort", cancel, { once: true });
					});
				}
				return {
					stdout:
						"File: original\n----\nbit rate: 48000 bits per second\n----\nbit rate: 96000 bits per second",
					stderr: "",
					exitCode: 0,
				};
			});
			const event = { sender: sender(1) };
			const preparation = state.handlers.get("prepare-auto-edit-audio")!(event, {
				jobId: "job-a",
				videoPath: "/source.mp4",
			});
			await vi.waitFor(() =>
				expect(state.run.mock.calls.some(([request]) => request.command.endsWith(stage))).toBe(
					true,
				),
			);
			const generatedPath = state.extract.mock.calls[0][1] as string;
			await state.handlers.get("cancel-auto-edit")!(event, "job-a");
			expect((await preparation).success).toBe(false);
			expect(approve).not.toHaveBeenCalled();
			expect(revoke).toHaveBeenCalledWith(generatedPath);
			expect(revoke).not.toHaveBeenCalledWith("/approved.mp4");
			await expect(fs.stat(path.dirname(generatedPath))).rejects.toThrow();
			expect(event.sender.listenerCount("destroyed")).toBe(0);
			expect(state.propose).not.toHaveBeenCalled();
			for (const [request] of state.run.mock.calls) {
				expect(request.signal).toBe(state.extract.mock.calls[0][2]);
				expect(request.signal.aborted).toBe(true);
				expect(request.timeoutMs).toBeGreaterThan(0);
				expect(request.maxOutputBytes).toBe(64 * 1024);
			}
			if (stage === "afinfo") expect(state.run).toHaveBeenCalledOnce();
			state.extract.mockImplementation(async (_source, target) => {
				await fs.writeFile(target, new Uint8Array(100));
			});
			const restarted = await state.handlers.get("prepare-auto-edit-audio")!(event, {
				jobId: "job-b",
				videoPath: "/source.mp4",
			});
			expect(restarted.success).toBe(true);
			await state.handlers.get("plan-auto-edit")!(event, { jobId: "job-b" });
		} finally {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});
});
