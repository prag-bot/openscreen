import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, ipcMain, type WebContents } from "electron";
import type { AutoEditRequest } from "../../src/lib/autoEdit";
import { createAutoEditPlan, getAutoEditStatus } from "../auto-edit/codexPlanner";
import { extractNarrationWav } from "../autoEditAudio";

interface Job {
	id: string;
	owner: WebContents;
	controller: AbortController;
	phase: "audio" | "ready" | "planning";
	directory?: string;
	audioPath?: string;
	timeout: ReturnType<typeof setTimeout>;
	onDestroyed: () => void;
	cleanup?: Promise<void>;
}

export function registerAutoEditHandlers(options: {
	resolveApprovedMediaPath: (value: string) => Promise<string | null>;
	approvePath: (value: string) => void;
	revokePath: (value: string) => void;
}): void {
	const jobs = new Map<number, Job>();
	function validId(id: unknown): id is string {
		return typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id);
	}
	function cleanup(job: Job): Promise<void> {
		if (job.cleanup) return job.cleanup;
		job.cleanup = (async () => {
			clearTimeout(job.timeout);
			job.owner.removeListener("destroyed", job.onDestroyed);
			if (jobs.get(job.owner.id) === job) jobs.delete(job.owner.id);
			if (job.audioPath) options.revokePath(job.audioPath);
			// Only this invocation's exclusive mkdtemp directory, never user media.
			if (job.directory) await fs.rm(job.directory, { recursive: true, force: true });
		})();
		return job.cleanup;
	}
	function abort(job: Job) {
		job.controller.abort();
		if (job.phase === "ready") void cleanup(job).catch(() => undefined);
	}
	ipcMain.handle("auto-edit-status", async () => {
		try {
			return await getAutoEditStatus();
		} catch {
			return {
				available: false,
				message:
					"Codex is unavailable. Install the Codex CLI and sign in with codex login, then restart this app.",
			};
		}
	});
	ipcMain.handle("prepare-auto-edit-audio", async (event, payload: unknown) => {
		let job: Job | undefined;
		try {
			const input = payload as { jobId?: unknown; videoPath?: unknown } | null;
			if (!input || !validId(input.jobId) || typeof input.videoPath !== "string")
				throw new Error("Invalid audio preparation request.");
			if (jobs.has(event.sender.id))
				throw new Error("An auto edit is already running. Cancel it before starting another.");
			if (event.sender.isDestroyed()) throw new Error("Auto edit is unavailable for this editor.");
			const controller = new AbortController();
			const onDestroyed = () => {
				if (job) abort(job);
			};
			job = {
				id: input.jobId,
				owner: event.sender,
				controller,
				phase: "audio",
				onDestroyed,
				timeout: setTimeout(
					() => {
						if (job) abort(job);
					},
					2 * 60 * 60 * 1000,
				),
			};
			job.timeout.unref?.();
			jobs.set(event.sender.id, job);
			event.sender.once("destroyed", onDestroyed);
			const media = await options.resolveApprovedMediaPath(input.videoPath);
			if (!media)
				throw new Error("Recording path is not approved. Reload the video using the file picker.");
			if (controller.signal.aborted) throw new Error("Auto edit canceled");
			job.directory = await fs.mkdtemp(
				path.join(app.getPath("temp"), "openscreen-auto-edit-audio-"),
			);
			job.audioPath = path.join(job.directory, "narration.wav");
			await extractNarrationWav(media, job.audioPath, controller.signal);
			if (controller.signal.aborted) throw new Error("Auto edit canceled");
			const stat = await fs.stat(job.audioPath);
			if (controller.signal.aborted) throw new Error("Auto edit canceled");
			if (stat.size < 44 || stat.size > 512 * 1024 * 1024)
				throw new Error("Narration is empty or exceeds the 4-hour audio limit.");
			options.approvePath(job.audioPath);
			job.phase = "ready";
			return { success: true, path: pathToFileURL(job.audioPath).href };
		} catch (cause) {
			if (job) await cleanup(job);
			return {
				success: false,
				error: cause instanceof Error ? cause.message : "Cannot extract narration.",
			};
		}
	});
	ipcMain.handle("plan-auto-edit", async (event, payload: AutoEditRequest) => {
		const job = jobs.get(event.sender.id);
		if (!job || job.id !== payload?.jobId || job.phase !== "ready" || job.controller.signal.aborted)
			return { success: false, error: "Auto edit session expired. Generate a new edit." };
		job.phase = "planning";
		try {
			const plan = await createAutoEditPlan(payload, { signal: job.controller.signal });
			if (job.controller.signal.aborted)
				return { success: false, canceled: true, error: "Auto edit canceled" };
			return { success: true, plan };
		} catch (cause) {
			return {
				success: false,
				canceled: job.controller.signal.aborted,
				error: cause instanceof Error ? cause.message : "Codex auto edit failed.",
			};
		} finally {
			await cleanup(job);
		}
	});
	ipcMain.handle("cancel-auto-edit", async (event, id: unknown) => {
		const job = jobs.get(event.sender.id);
		if (validId(id) && job?.id === id) abort(job);
		return { success: true };
	});
}
