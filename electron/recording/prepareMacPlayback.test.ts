// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveProjectMediaPaths, prepareMacPlaybackSession } from "./prepareMacPlayback";

describe("immutable native Mac playback preparation", () => {
	let directory: string;
	let original: string;
	const runHelper = vi.fn();
	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "openscreen-playback-test-"));
		original = path.join(directory, "screen.mp4");
		await writeFile(original, "immutable original");
		runHelper.mockReset().mockImplementation(async (_helper, args: string[]) => {
			if (args[0] === "--prepare-playback")
				await writeFile(args[2], "validated playback", { flag: "wx" });
			return {
				code: 0,
				stdout: JSON.stringify({
					event: "playback-ready",
					audioTrackCount: 1,
					audioSampleCount: 1024,
				}),
				stderr: "",
			};
		});
	});
	const options = () => ({ platform: "darwin" as const, helperPath: "/native/helper", runHelper });
	it("retains metadata and original while copying validated cursor telemetry to one mixed derivative", async () => {
		const telemetry = JSON.stringify({
			version: 2,
			provider: "native",
			samples: [{ timeMs: 0, cx: 0.4, cy: 0.5 }],
			assets: [],
		});
		await writeFile(`${original}.cursor.json`, telemetry);
		const session = await prepareMacPlaybackSession(
			{
				screenVideoPath: original,
				webcamVideoPath: "/camera.webm",
				webcamOffsetSeconds: -0.2,
				createdAt: 1234,
				cursorCaptureMode: "editable-overlay",
			},
			options(),
		);
		expect(session).toEqual({
			screenVideoPath: path.join(directory, "screen-playback.mp4"),
			originalScreenVideoPath: original,
			webcamVideoPath: "/camera.webm",
			webcamOffsetSeconds: -0.2,
			createdAt: 1234,
			cursorCaptureMode: "editable-overlay",
		});
		expect(await readFile(original, "utf8")).toBe("immutable original");
		expect(await readFile(`${session.screenVideoPath}.cursor.json`, "utf8")).toBe(telemetry);
		expect(runHelper).toHaveBeenCalledWith("/native/helper", [
			"--prepare-playback",
			original,
			session.screenVideoPath,
		]);
	});
	it("never overwrites an existing derivative", async () => {
		const occupied = path.join(directory, "screen-playback.mp4");
		await writeFile(occupied, "existing file");
		const session = await prepareMacPlaybackSession(
			{ screenVideoPath: original, createdAt: 1 },
			options(),
		);
		expect(session.screenVideoPath).not.toBe(occupied);
		expect(await readFile(occupied, "utf8")).toBe("existing file");
	});
	it("validates, but does not remix, a prepared session on reload", async () => {
		const playback = path.join(directory, "screen-playback.mp4");
		await writeFile(playback, "prepared");
		const session = { screenVideoPath: playback, originalScreenVideoPath: original, createdAt: 1 };
		expect(await prepareMacPlaybackSession(session, options())).toEqual(session);
		expect(runHelper).toHaveBeenCalledWith("/native/helper", [
			"--validate-playback",
			original,
			playback,
		]);
	});
	it("refuses to overwrite a playback sidecar with different telemetry", async () => {
		const playback = path.join(directory, "screen-playback.mp4");
		const originalTelemetry = JSON.stringify({ samples: [{ timeMs: 0, cx: 0.1, cy: 0.2 }] });
		const existingTelemetry = JSON.stringify({ samples: [{ timeMs: 0, cx: 0.8, cy: 0.9 }] });
		await writeFile(playback, "prepared");
		await writeFile(`${original}.cursor.json`, originalTelemetry);
		await writeFile(`${playback}.cursor.json`, existingTelemetry);
		await expect(
			prepareMacPlaybackSession(
				{ screenVideoPath: playback, originalScreenVideoPath: original, createdAt: 1 },
				options(),
			),
		).rejects.toThrow(/cursor.*refusing to overwrite/i);
		expect(await readFile(`${playback}.cursor.json`, "utf8")).toBe(existingTelemetry);
	});
	it("rejects an audio track with no samples and a missing helper", async () => {
		runHelper.mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ event: "playback-ready", audioTrackCount: 1, audioSampleCount: 0 }),
			stderr: "",
		});
		await expect(
			prepareMacPlaybackSession({ screenVideoPath: original, createdAt: 1 }, options()),
		).rejects.toThrow(/validation/i);
		await expect(
			prepareMacPlaybackSession(
				{ screenVideoPath: original, createdAt: 1 },
				{ ...options(), helperPath: null },
			),
		).rejects.toThrow(/helper.*unavailable/i);
	});
	it("fails actionably and retains the original when mixing or validation fails", async () => {
		runHelper.mockResolvedValue({ code: 1, stdout: "", stderr: "audio reader failed" });
		await expect(
			prepareMacPlaybackSession({ screenVideoPath: original, createdAt: 1 }, options()),
		).rejects.toThrow(/original.*retained.*audio reader failed/i);
		expect(await readFile(original, "utf8")).toBe("immutable original");
	});
	it("does not publish malformed helper success or unvalidated cursor metadata", async () => {
		runHelper.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		await expect(
			prepareMacPlaybackSession({ screenVideoPath: original, createdAt: 1 }, options()),
		).rejects.toThrow(/validation/i);
		runHelper.mockClear();
		await writeFile(`${original}.cursor.json`, '{"samples":"invalid"}');
		await expect(
			prepareMacPlaybackSession({ screenVideoPath: original, createdAt: 1 }, options()),
		).rejects.toThrow(/cursor/i);
		expect(runHelper).not.toHaveBeenCalled();
	});
	it("leaves non-Mac/non-MP4 sessions unchanged", async () => {
		const session = { screenVideoPath: "/screen.webm", createdAt: 1 };
		expect(await prepareMacPlaybackSession(session, options())).toBe(session);
		expect(
			await prepareMacPlaybackSession(
				{ ...session, screenVideoPath: original },
				{ ...options(), platform: "linux" },
			),
		).toEqual({ ...session, screenVideoPath: original });
		expect(runHelper).not.toHaveBeenCalled();
	});
	it("approves every media path, including the original, and rejects an unapproved original", async () => {
		const media = {
			screenVideoPath: "/screen-playback.mp4",
			originalScreenVideoPath: "/screen.mp4",
			webcamVideoPath: "/camera.webm",
			webcamOffsetSeconds: -0.2,
		};
		const approve = vi.fn(async (value: string) => value);
		expect(await approveProjectMediaPaths(media, approve)).toEqual(media);
		expect(approve.mock.calls.flat()).toEqual([
			media.screenVideoPath,
			media.originalScreenVideoPath,
			media.webcamVideoPath,
		]);
		await expect(
			approveProjectMediaPaths(media, async (value) =>
				value === media.originalScreenVideoPath ? null : value,
			),
		).rejects.toThrow(/original/i);
	});
});
