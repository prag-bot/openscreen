// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { RecordingSession } from "../../src/lib/recordingSession";
import { prepareMacPlaybackSession } from "./prepareMacPlayback";
import { restoreRecordingSession } from "./restoreRecordingSession";

describe("recorded session restoration persistence boundary", () => {
	it.each([
		{
			platform: "darwin" as const,
			screenVideoPath: "/readonly/screen.webm",
			originalScreenVideoPath: undefined,
		},
		{
			platform: "linux" as const,
			screenVideoPath: "/readonly/screen-playback.mp4",
			originalScreenVideoPath: "/readonly/screen.mp4",
		},
	])("does not masquerade a read-only $platform rewrite failure as an absent session", async ({
		platform,
		screenVideoPath,
		originalScreenVideoPath,
	}) => {
		const session: RecordingSession = {
			screenVideoPath,
			...(originalScreenVideoPath ? { originalScreenVideoPath } : {}),
			webcamVideoPath: "/readonly/camera.webm",
			webcamOffsetSeconds: -0.35,
			cursorCaptureMode: "editable-overlay",
			createdAt: 1234,
		};
		const before = structuredClone(session);
		const persist = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("EACCES: recording folder is read-only"), { code: "EACCES" }),
			);
		const fallback = vi.fn(() => ({ screenVideoPath, createdAt: 9999 }));
		const restored = restoreRecordingSession({
			read: async () => session,
			prepare: (value) => prepareMacPlaybackSession(value, { platform, helperPath: null }),
			persist,
		}).then((value) => value ?? fallback());
		await expect(restored).rejects.toThrow(
			/Could not update recording session metadata.*retained.*EACCES/s,
		);
		expect(persist).toHaveBeenCalledWith(before);
		expect(session).toEqual(before);
		expect(fallback).not.toHaveBeenCalled();
	});
	it("returns the complete prepared session after persistence succeeds", async () => {
		const session: RecordingSession = {
			screenVideoPath: "/screen.mp4",
			webcamVideoPath: "/camera.webm",
			webcamOffsetSeconds: 0.25,
			cursorCaptureMode: "system",
			createdAt: 1234,
		};
		const prepared = {
			...session,
			screenVideoPath: "/screen-playback.mp4",
			originalScreenVideoPath: session.screenVideoPath,
		};
		const persist = vi.fn().mockResolvedValue(undefined);
		expect(
			await restoreRecordingSession({
				read: async () => session,
				prepare: async () => prepared,
				persist,
			}),
		).toEqual(prepared);
		expect(persist).toHaveBeenCalledWith(prepared);
	});
	it("uses absence only for a genuine missing or nonmatching parsed session", async () => {
		const prepare = vi.fn();
		const persist = vi.fn();
		expect(await restoreRecordingSession({ read: async () => null, prepare, persist })).toBeNull();
		expect(prepare).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});
	it("propagates preparation errors without writing or returning an absent session", async () => {
		const session: RecordingSession = {
			screenVideoPath: "/screen.mp4",
			webcamVideoPath: "/camera.webm",
			webcamOffsetSeconds: -0.5,
			createdAt: 1234,
		};
		const persist = vi.fn();
		await expect(
			restoreRecordingSession({
				read: async () => session,
				prepare: async () => {
					throw new Error("Original retained; native mixing failed");
				},
				persist,
			}),
		).rejects.toThrow("Original retained; native mixing failed");
		expect(persist).not.toHaveBeenCalled();
	});
});
