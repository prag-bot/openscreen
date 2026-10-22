import path from "node:path";
import { app, type BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from "electron";
import gsapSource from "gsap/dist/gsap.min.js?raw";
import { validateHyperframesExportRequest } from "../../src/lib/exporter/hyperframesExporter";
import { writeHyperframesProject } from "../export/hyperframesProject";
import { renderHyperframesVideo, resolveHyperframesExecutable } from "../export/hyperframesRender";

export function registerHyperframesExportHandler(options: {
	getMainWindow: () => BrowserWindow | null;
	resolveApprovedMediaPath: (filePath: string) => Promise<string | null>;
}): void {
	let active: { senderId: number; controller: AbortController; cancelable: boolean } | null = null;
	async function exportProject(event: IpcMainInvokeEvent, payload: unknown, renderVideo: boolean) {
		if (active)
			return {
				success: false,
				error: "A HyperFrames export is already running. Wait for it to finish or cancel it.",
			};
		const job = { senderId: event.sender.id, controller: new AbortController(), cancelable: true };
		active = job;
		const cancelOnClose = () => {
			if (job.cancelable) job.controller.abort();
		};
		event.sender.once?.("destroyed", cancelOnClose);
		let projectPath: string | undefined;
		try {
			const request = validateHyperframesExportRequest(payload);
			const executable = renderVideo ? await resolveHyperframesExecutable() : undefined;
			const parent = options.getMainWindow();
			const dialogOptions: Electron.SaveDialogOptions = {
				title: renderVideo
					? "Render MP4 in a new HyperFrames project folder"
					: "Create a new HyperFrames project folder (no video render)",
				buttonLabel: renderVideo ? "Create + render MP4" : "Create project only",
				defaultPath: path.join(app.getPath("downloads"), "openscreen-hyperframes"),
				nameFieldLabel: "New project folder name",
				message: renderVideo
					? "Choose a NEW folder. Its editable project and finished edited.mp4 stay together. Existing files are never overwritten."
					: "Choose a NEW folder. Creates an editable project only, not a finished video. Existing files are never overwritten.",
				properties: ["createDirectory", "showOverwriteConfirmation"],
			};
			const selection =
				parent && !parent.isDestroyed()
					? await dialog.showSaveDialog(parent, dialogOptions)
					: await dialog.showSaveDialog(dialogOptions);
			if (selection.canceled || !selection.filePath || job.controller.signal.aborted) {
				return { success: false, canceled: true, error: "HyperFrames export canceled" };
			}
			const progress = (message: string) => {
				if (!event.sender.isDestroyed()) event.sender.send("hyperframes-export-progress", message);
			};
			progress("Copying original media and preparing editable tracks…");
			const result = await writeHyperframesProject({
				request,
				targetDirectory: path.normalize(selection.filePath),
				gsapSource,
				resolveApprovedMediaPath: options.resolveApprovedMediaPath,
			});
			projectPath = result.path;
			if (job.controller.signal.aborted)
				throw new Error("HyperFrames export canceled; editable project retained");
			if (!renderVideo) {
				job.cancelable = false;
				return { success: true, ...result };
			}
			const rendered = await renderHyperframesVideo({
				projectDirectory: result.path,
				executable,
				expectedAudio: result.audioTrackCount > 0,
				signal: job.controller.signal,
				onProgress: progress,
				onPublicationCommit: () => {
					job.cancelable = false;
				},
			});
			return {
				success: true,
				path: rendered.videoPath,
				videoPath: rendered.videoPath,
				projectPath: result.path,
				warnings: result.warnings,
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			return {
				success: false,
				...(job.controller.signal.aborted ? { canceled: true } : {}),
				...(projectPath ? { projectPath } : {}),
				error:
					code === "EEXIST"
						? "That file or folder already exists. Choose a NEW project folder; nothing was overwritten."
						: code === "ENOENT"
							? "Recording media or the selected parent folder is missing. Reload your recording and choose an existing parent folder."
							: error instanceof Error
								? error.message
								: "HyperFrames export failed",
			};
		} finally {
			event.sender.removeListener?.("destroyed", cancelOnClose);
			if (active === job) active = null;
		}
	}
	ipcMain.handle("export-hyperframes-project", (event, payload: unknown) =>
		exportProject(event, payload, false),
	);
	ipcMain.handle("export-hyperframes-video", (event, payload: unknown) =>
		exportProject(event, payload, true),
	);
	ipcMain.handle("cancel-hyperframes-export", (event) => {
		if (!active || active.senderId !== event.sender.id || !active.cancelable)
			return { success: false };
		active.controller.abort();
		return { success: true };
	});
}
