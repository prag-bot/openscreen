import type { App } from "electron";

/** Reopen the primary app only after its IPC and recording services are ready. */
export function configureSingleInstanceLifecycle(
	app: App,
	showMainWindow: () => void,
	canShowMainWindow: () => boolean,
): boolean {
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return false;
	}
	const reopen = () => {
		if (canShowMainWindow()) showMainWindow();
	};
	app.on("second-instance", reopen);
	app.on("activate", reopen);
	return true;
}
