// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MacNativeCursorRecordingSession,
	requestMacCursorAccessibilityAccess,
} from "./macNativeCursorRecordingSession";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	accessSync: vi.fn(),
	isTrustedAccessibilityClient: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	accessSync: mocks.accessSync,
}));
vi.mock("electron", () => ({
	systemPreferences: { isTrustedAccessibilityClient: mocks.isTrustedAccessibilityClient },
	screen: {
		getCursorScreenPoint: () => ({ x: 50, y: 50 }),
		getDisplayNearestPoint: () => ({
			bounds: { x: 0, y: 0, width: 100, height: 100 },
			scaleFactor: 2,
		}),
	},
}));

function fakeChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		killed: false,
		kill: vi.fn(function (this: { killed: boolean }) {
			this.killed = true;
			return true;
		}),
	});
}

let child: ReturnType<typeof fakeChild>;
beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	child = fakeChild();
	mocks.accessSync.mockReset();
	mocks.spawn.mockImplementation(() => child);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("macOS cursor accessibility probe (mocked child processes, no OS acquisition)", () => {
	it.each([
		undefined,
		{},
		{ prompt: false },
		{ prompt: "true" },
		true,
		null,
	])("keeps omitted/malformed input quiet (%j)", async (options) => {
		const result = requestMacCursorAccessibilityAccess(options as never);
		expect(mocks.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
		expect(JSON.parse(mocks.spawn.mock.calls[0][1][0])).toMatchObject({
			promptAccessibility: false,
			accessibilityProbeOnly: true,
		});
		child.stdout.write(`${JSON.stringify({ type: "ready", accessibilityTrusted: false })}\n`);
		await expect(result).resolves.toMatchObject({ granted: false });
		expect(child.kill).toHaveBeenCalledTimes(1);
	});
	it("prompts only the helper for explicit opt-in, avoiding a stacked parent prompt", async () => {
		const result = requestMacCursorAccessibilityAccess({ prompt: true });
		expect(mocks.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
		expect(JSON.parse(mocks.spawn.mock.calls[0][1][0])).toMatchObject({
			promptAccessibility: true,
			accessibilityProbeOnly: true,
		});
		child.stdout.write(`${JSON.stringify({ type: "ready", accessibilityTrusted: true })}\n`);
		await expect(result).resolves.toMatchObject({ success: true, granted: true });
	});
	it("accepts readiness drained after helper exit and before close", async () => {
		const result = requestMacCursorAccessibilityAccess({ prompt: true });
		child.emit("exit", 0, null);
		child.stdout.write(`${JSON.stringify({ type: "ready", accessibilityTrusted: true })}\n`);
		child.emit("close", 0, null);
		await expect(result).resolves.toMatchObject({
			success: true,
			granted: true,
			status: "granted",
		});
		expect(child.kill).toHaveBeenCalledTimes(1);
	});
	it("waits through exit without readiness and fails only when stdout has closed", async () => {
		const result = requestMacCursorAccessibilityAccess();
		const settled = vi.fn();
		void result.then(settled);
		child.emit("exit", 1, null);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
		child.emit("close", 1, null);
		await expect(result).resolves.toMatchObject({
			success: false,
			granted: false,
			status: "exited",
		});
		expect(child.kill).toHaveBeenCalledTimes(1);
	});
	it("fails close without readiness immediately rather than waiting for the timeout", async () => {
		vi.useFakeTimers();
		const result = requestMacCursorAccessibilityAccess();
		const settled = vi.fn();
		void result.then(settled);
		child.emit("close", 1, "SIGTERM");
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledWith(
			expect.objectContaining({ success: false, granted: false, status: "exited" }),
		);
		await expect(result).resolves.toMatchObject({
			error: expect.stringContaining("code=1, signal=SIGTERM"),
		});
		expect(vi.getTimerCount()).toBe(0);
	});
	it("retains an explicit denial drained after exit", async () => {
		const result = requestMacCursorAccessibilityAccess({ prompt: true });
		child.emit("exit", 0, null);
		child.stdout.write(`${JSON.stringify({ type: "ready", accessibilityTrusted: false })}\n`);
		child.emit("close", 0, null);
		await expect(result).resolves.toMatchObject({
			success: true,
			granted: false,
			status: "not-determined",
		});
		expect(child.kill).toHaveBeenCalledTimes(1);
	});
	it("handles child errors immediately and ignores later readiness/close", async () => {
		vi.useFakeTimers();
		const result = requestMacCursorAccessibilityAccess({ prompt: true });
		child.emit("error", new Error("spawn failed"));
		await expect(result).resolves.toMatchObject({
			success: false,
			granted: false,
			status: "error",
			error: "spawn failed",
		});
		child.stdout.write(`${JSON.stringify({ type: "ready", accessibilityTrusted: true })}\n`);
		child.emit("close", 1, null);
		await expect(result).resolves.toMatchObject({ granted: false, status: "error" });
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("times out if exited stdio never closes and ignores later readiness/close", async () => {
		vi.useFakeTimers();
		const result = requestMacCursorAccessibilityAccess();
		child.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(5000);
		await expect(result).resolves.toMatchObject({
			success: false,
			granted: false,
			status: "timeout",
		});
		child.stdout.write(`${JSON.stringify({ type: "ready", accessibilityTrusted: true })}\n`);
		child.emit("close", 0, null);
		await expect(result).resolves.toMatchObject({ granted: false, status: "timeout" });
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("skips macOS probes on other platforms", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		await expect(requestMacCursorAccessibilityAccess({ prompt: true })).resolves.toMatchObject({
			granted: true,
		});
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});

describe("actual macOS cursor session startup", () => {
	function session() {
		return new MacNativeCursorRecordingSession({
			getDisplayBounds: () => null,
			maxSamples: 100,
			sampleIntervalMs: 33,
			startTimeMs: 1000,
		});
	}
	it("starts quietly and preserves authorized cursor data", async () => {
		const active = session();
		const ready = active.start();
		expect(mocks.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
		expect(JSON.parse(mocks.spawn.mock.calls[0][1][0])).toMatchObject({
			promptAccessibility: false,
		});
		child.stdout.write(
			`${JSON.stringify({ type: "ready", accessibilityTrusted: true, mouseTapReady: true })}\n`,
		);
		await ready;
		child.stdout.write(
			`${JSON.stringify({ type: "sample", timestampMs: 1100, cursorType: "pointer", leftButtonPressed: true })}\n`,
		);
		expect((await active.stop()).samples).toEqual([
			expect.objectContaining({
				timeMs: 100,
				cx: 0.5,
				cy: 0.5,
				cursorType: "pointer",
				interactionType: "click",
			}),
		]);
	});
	it("rejects quiet untrusted startup instead of claiming editable capture succeeded", async () => {
		const active = session();
		const ready = active.start();
		const rejected = expect(ready).rejects.toThrow(/system cursor/i);
		child.stdout.write(`${JSON.stringify({ type: "ready", accessibilityTrusted: false })}\n`);
		await rejected;
		expect(child.kill).toHaveBeenCalledTimes(1);
		await active.stop();
	});
	it("rejects missing helper instead of recording without the requested cursor", async () => {
		mocks.accessSync.mockImplementation(() => {
			throw new Error("missing");
		});
		await expect(session().start()).rejects.toThrow(/helper/i);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
