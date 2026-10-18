import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	constructor: vi.fn(),
	windows: [] as Array<{
		destroyed: boolean;
		isDestroyed: () => boolean;
		callbacks: Map<string, () => void>;
	}>,
}));

vi.mock("electron", () => ({
	ipcMain: { on: vi.fn() },
	screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
	BrowserWindow: class {
		destroyed = false;
		callbacks = new Map<string, () => void>();
		webContents = { on: vi.fn(), send: vi.fn() };
		setIgnoreMouseEvents = vi.fn();
		setVisibleOnAllWorkspaces = vi.fn();
		once = vi.fn();
		show = vi.fn();
		loadFile = vi.fn();
		loadURL = vi.fn();
		constructor(options: unknown) {
			mocks.constructor(options);
			mocks.windows.push(this);
		}
		isDestroyed() {
			return this.destroyed;
		}
		on(event: string, callback: () => void) {
			this.callbacks.set(event, callback);
		}
	},
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mocks.windows.length = 0;
});

describe("HUD window singleton", () => {
	it("returns the existing toolbar instead of constructing a second one", async () => {
		const { createHudOverlayWindow } = await import("./windows");
		const first = createHudOverlayWindow();
		expect(createHudOverlayWindow()).toBe(first);
		expect(mocks.constructor).toHaveBeenCalledOnce();
	});

	it("creates a replacement only after the previous toolbar is destroyed", async () => {
		const { createHudOverlayWindow } = await import("./windows");
		const first = createHudOverlayWindow();
		mocks.windows[0].destroyed = true;
		expect(createHudOverlayWindow()).not.toBe(first);
		expect(mocks.constructor).toHaveBeenCalledTimes(2);
	});

	it("does not let an old closed callback discard the current toolbar", async () => {
		const { createHudOverlayWindow } = await import("./windows");
		createHudOverlayWindow();
		const old = mocks.windows[0];
		old.destroyed = true;
		const replacement = createHudOverlayWindow();
		old.callbacks.get("closed")?.();
		expect(createHudOverlayWindow()).toBe(replacement);
		expect(mocks.constructor).toHaveBeenCalledTimes(2);
	});
});
