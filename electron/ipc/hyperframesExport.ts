import path from "node:path";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import gsapSource from "gsap/dist/gsap.min.js?raw";
import { validateHyperframesExportRequest } from "../../src/lib/exporter/hyperframesExporter";
import { writeHyperframesProject } from "../export/hyperframesProject";

export function registerHyperframesExportHandler(options: {
	getMainWindow: () => BrowserWindow | null;
	resolveApprovedMediaPath: (filePath: string) => Promise<string | null>;
}): void {
	ipcMain.handle("export-hyperframes-project", async (_, payload: unknown) => {
		try {
			const request = validateHyperframesExportRequest(payload);
			const parent = options.getMainWindow();
			const dialogOptions: Electron.SaveDialogOptions = {
				title: "Create a new HyperFrames project folder",
				buttonLabel: "Create project",
				defaultPath: path.join(app.getPath("downloads"), "openscreen-hyperframes"),
				nameFieldLabel: "New project folder name",
				message: "Choose a NEW folder name. Existing folders and files will never be overwritten.",
				properties: ["createDirectory", "showOverwriteConfirmation"],
			};
			const selection =
				parent && !parent.isDestroyed()
					? await dialog.showSaveDialog(parent, dialogOptions)
					: await dialog.showSaveDialog(dialogOptions);
			if (selection.canceled || !selection.filePath) {
				return { success: false, canceled: true, error: "HyperFrames export canceled" };
			}
			const result = await writeHyperframesProject({
				request,
				targetDirectory: path.normalize(selection.filePath),
				gsapSource,
				resolveApprovedMediaPath: options.resolveApprovedMediaPath,
			});
			return { success: true, ...result };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			return {
				success: false,
				error:
					code === "EEXIST"
						? "That file or folder already exists. Choose a NEW project folder; nothing was overwritten."
						: code === "ENOENT"
							? "Recording media or the selected parent folder is missing. Reload your recording and choose an existing parent folder."
							: error instanceof Error
								? error.message
								: "HyperFrames project export failed",
			};
		}
	});
}
