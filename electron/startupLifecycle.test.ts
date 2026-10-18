import { EventEmitter } from "node:events";
import type { App } from "electron";
import { describe, expect, it, vi } from "vitest";
import { configureSingleInstanceLifecycle } from "./startupLifecycle";

function mockApp(ownsLock = true) {
	return Object.assign(new EventEmitter(), {
		requestSingleInstanceLock: vi.fn(() => ownsLock),
		quit: vi.fn(),
	});
}

describe("recording app startup lifecycle", () => {
	it("quits a second process before it can initialize another toolbar", () => {
		const app = mockApp(false);
		const showWindow = vi.fn();
		expect(configureSingleInstanceLifecycle(app as unknown as App, showWindow, () => true)).toBe(
			false,
		);
		expect(app.quit).toHaveBeenCalledOnce();
		expect(app.listenerCount("activate")).toBe(0);
		expect(app.listenerCount("second-instance")).toBe(0);
		expect(showWindow).not.toHaveBeenCalled();
	});

	it("does not show an early toolbar before its IPC is registered", () => {
		const app = mockApp();
		let ready = false;
		const showWindow = vi.fn();
		configureSingleInstanceLifecycle(app as unknown as App, showWindow, () => ready);
		app.emit("activate");
		app.emit("second-instance");
		expect(showWindow).not.toHaveBeenCalled();
		ready = true;
		app.emit("activate");
		expect(showWindow).toHaveBeenCalledOnce();
	});

	it("reuses the primary window when the app is opened again after startup", () => {
		const app = mockApp();
		const showWindow = vi.fn();
		configureSingleInstanceLifecycle(app as unknown as App, showWindow, () => true);
		app.emit("second-instance");
		expect(showWindow).toHaveBeenCalledOnce();
		expect(app.quit).not.toHaveBeenCalled();
		expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
	});
});
