// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

type MenuEntry = { label?: string; click?: () => void };

/** Execute the actual main, lifecycle, and window modules without loading Electron. */
function createMainHarness() {
	let releaseDirectory!: () => void;
	const directoryReady = new Promise<void>((resolve) => {
		releaseDirectory = resolve;
	});
	let startup!: Promise<void>;
	let ipcRegistered = false;
	let callbacks!: {
		openEditor: () => void;
		returnToHud: () => void;
		getMainWindow: () => MockWindow | null;
	};
	const liveWindows = new Set<MockWindow>();
	const constructedWindows: MockWindow[] = [];
	const remainingWindowsAfterClose: number[] = [];
	const app = Object.assign(new EventEmitter(), {
		requestSingleInstanceLock: vi.fn(() => true),
		quit: vi.fn(),
		getPath: vi.fn(() => "/virtual/openscreen-test/userData"),
		whenReady: () => ({
			then(callback: () => Promise<void>) {
				startup = Promise.resolve().then(callback);
				return startup;
			},
		}),
		commandLine: { appendSwitch: vi.fn() },
		dock: { show: vi.fn() },
		name: "Openscreen test",
	});
	const ipcMain = Object.assign(new EventEmitter(), { handle: vi.fn() });

	class MockWindow extends EventEmitter {
		destroyed = false;
		windowType = "";
		readonly ipcReadyAtConstruction = ipcRegistered;
		readonly webContents = Object.assign(new EventEmitter(), {
			getURL: () => `file:///virtual/index.html?windowType=${this.windowType}`,
			send: vi.fn(),
			insertCSS: vi.fn(() => Promise.resolve()),
		});
		show = vi.fn();
		focus = vi.fn();
		restore = vi.fn();
		maximize = vi.fn();
		setIgnoreMouseEvents = vi.fn();
		setVisibleOnAllWorkspaces = vi.fn();

		constructor(_options: unknown) {
			super();
			liveWindows.add(this);
			constructedWindows.push(this);
		}

		isDestroyed() {
			return this.destroyed;
		}

		isMinimized() {
			return false;
		}

		loadFile(_file: string, options?: { query?: { windowType?: string } }) {
			this.windowType = options?.query?.windowType ?? "";
			return Promise.resolve();
		}

		loadURL(url: string) {
			this.windowType = new URL(url).searchParams.get("windowType") ?? "";
			return Promise.resolve();
		}

		close() {
			const event = {
				prevented: false,
				preventDefault() {
					this.prevented = true;
				},
			};
			this.emit("close", event);
			if (event.prevented) return;
			this.destroyed = true;
			liveWindows.delete(this);
			this.emit("closed");
			remainingWindowsAfterClose.push(liveWindows.size);
			if (liveWindows.size === 0) app.emit("window-all-closed");
		}

		static getFocusedWindow() {
			return null;
		}
	}

	let tray!: MockTray;
	class MockTray extends EventEmitter {
		contextMenu: MenuEntry[] = [];
		setImage = vi.fn();
		setToolTip = vi.fn();

		constructor(_image: unknown) {
			super();
			tray = this;
		}

		setContextMenu(menu: MenuEntry[]) {
			this.contextMenu = menu;
		}
	}

	const registerIpcHandlers = vi.fn(
		(
			openEditor: () => void,
			_sourceFactory: unknown,
			_countdownFactory: unknown,
			getMainWindow: () => MockWindow | null,
			_getSource: unknown,
			_getCountdown: unknown,
			_recordingChanged: unknown,
			returnToHud: () => void,
		) => {
			ipcRegistered = true;
			callbacks = { openEditor, returnToHud, getMainWindow };
		},
	);
	const mkdir = vi.fn(() => directoryReady);
	const electron = {
		app,
		BrowserWindow: MockWindow,
		ipcMain,
		Tray: MockTray,
		Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: vi.fn() },
		nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
		screen: {
			getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
		},
		session: {
			defaultSession: {
				setPermissionCheckHandler: vi.fn(),
				setPermissionRequestHandler: vi.fn(),
				setDisplayMediaRequestHandler: vi.fn(),
			},
		},
	};
	const sourceDir = path.dirname(fileURLToPath(import.meta.url));
	const modules = new Map<string, unknown>();
	function loadSource(filename: string): unknown {
		if (modules.has(filename)) return modules.get(filename);
		const code = transformSync(readFileSync(path.join(sourceDir, filename), "utf8"), {
			loader: "ts",
			format: "cjs",
			logLevel: "silent",
		}).code;
		const module = { exports: {} };
		runInNewContext(
			code,
			{
				module,
				exports: module.exports,
				require(id: string) {
					switch (id) {
						case "electron":
							return electron;
						case "node:fs/promises":
							return { mkdir };
						case "node:path":
							return path;
						case "node:url":
							return {
								fileURLToPath: () => `/virtual/openscreen-test/electron/${filename}`,
								pathToFileURL,
							};
						case "./startupLifecycle":
							return loadSource("startupLifecycle.ts");
						case "./windows":
							return loadSource("windows.ts");
						case "./i18n":
							return { mainT: () => "", setMainLocale: vi.fn() };
						case "./globalShortcut":
							return {
								loadAndRegisterGlobalShortcut: vi.fn(() => Promise.resolve()),
								registerOpenAppShortcut: vi.fn(() => true),
								unregisterAllGlobalShortcuts: vi.fn(),
							};
						case "./ipc/handlers":
							return { getSelectedDesktopSource: () => null, registerIpcHandlers };
						default:
							throw new Error(`Unexpected runtime dependency: ${id}`);
					}
				},
				process: { platform: "darwin", env: {} },
				console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
				setImmediate,
			},
			{ filename: path.join(sourceDir, filename) },
		);
		modules.set(filename, module.exports);
		return module.exports;
	}
	loadSource("main.ts");

	return {
		app,
		ipcMain,
		mkdir,
		registerIpcHandlers,
		constructedWindows,
		liveWindows,
		remainingWindowsAfterClose,
		get tray() {
			return tray;
		},
		get callbacks() {
			return callbacks;
		},
		async finishStartup() {
			releaseDirectory();
			await startup;
		},
	};
}

describe("actual main startup barrier and window handoffs", () => {
	it("blocks tray and lifecycle reopening while directory setup is held, then creates one IPC-ready HUD", async () => {
		const harness = createMainHarness();
		await Promise.resolve();
		expect(harness.mkdir).toHaveBeenCalledOnce();
		expect(harness.registerIpcHandlers).not.toHaveBeenCalled();

		const reopen = () => {
			harness.app.emit("activate");
			harness.app.emit("second-instance");
			harness.tray.emit("click");
			harness.tray.emit("double-click");
			const open = harness.tray.contextMenu.find((item) => item.label === "Open");
			expect(open?.click).toBeTypeOf("function");
			open?.click?.();
		};
		try {
			reopen();
			expect(harness.constructedWindows).toHaveLength(0);
			expect(harness.liveWindows.size).toBe(0);
		} finally {
			await harness.finishStartup();
		}

		expect(harness.registerIpcHandlers).toHaveBeenCalledOnce();
		expect(harness.constructedWindows).toHaveLength(1);
		expect(harness.constructedWindows[0].windowType).toBe("hud-overlay");
		expect(harness.constructedWindows[0].ipcReadyAtConstruction).toBe(true);
		reopen();
		expect(harness.constructedWindows).toHaveLength(1);
		expect(harness.liveWindows.size).toBe(1);
		expect(harness.app.quit).not.toHaveBeenCalled();
	});

	it("constructs the editor before closing the HUD, without quitting", async () => {
		const harness = createMainHarness();
		await harness.finishStartup();
		const previousHud = harness.callbacks.getMainWindow();

		harness.callbacks.openEditor();

		expect(previousHud?.isDestroyed()).toBe(true);
		expect(harness.callbacks.getMainWindow()?.windowType).toBe("editor");
		expect([...harness.liveWindows]).toEqual([harness.callbacks.getMainWindow()]);
		expect(harness.remainingWindowsAfterClose).toEqual([1]);
		expect(harness.app.quit).not.toHaveBeenCalled();
	});

	it("constructs the HUD before force-closing the editor and reuses it on repeated return", async () => {
		const harness = createMainHarness();
		await harness.finishStartup();
		harness.callbacks.openEditor();
		const previousEditor = harness.callbacks.getMainWindow();
		harness.ipcMain.emit("set-has-unsaved-changes", {}, true);

		harness.callbacks.returnToHud();
		const replacementHud = harness.callbacks.getMainWindow();
		expect(previousEditor?.isDestroyed()).toBe(true);
		expect(replacementHud?.windowType).toBe("hud-overlay");
		expect([...harness.liveWindows]).toEqual([replacementHud]);
		expect(harness.remainingWindowsAfterClose).toEqual([1, 1]);
		harness.callbacks.returnToHud();
		expect(harness.callbacks.getMainWindow()).toBe(replacementHud);
		expect(harness.constructedWindows).toHaveLength(3);
		expect(harness.liveWindows.size).toBe(1);
		expect(harness.app.quit).not.toHaveBeenCalled();
	});
});
