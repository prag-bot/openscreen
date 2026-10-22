// @vitest-environment node
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	normalizeHyperframesAudio,
	renderHyperframesVideo,
	resolveHyperframesBrowser,
	resolveHyperframesExecutable,
} from "./hyperframesRender";

describe("installed-only HyperFrames MP4 rendering", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await realpath(await mkdtemp(path.join(tmpdir(), "openscreen-render-test-")));
		await writeFile(path.join(directory, "index.html"), "<!doctype html>");
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	const fakeChild = () =>
		Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		});
	const renderOptions = () => ({
		projectDirectory: directory,
		executable: "/local/hyperframes",
		browserExecutable: "/local/chrome",
	});
	it("finds a local executable without invoking npx or a shell", async () => {
		const executable = path.join(directory, "hyperframes");
		await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
		await expect(resolveHyperframesExecutable({ candidates: [executable] })).resolves.toBe(
			executable,
		);
		await expect(
			resolveHyperframesExecutable({ candidates: [path.join(directory, "absent")] }),
		).rejects.toThrow(/installed.*HyperFrames/i);
		await expect(resolveHyperframesBrowser({ candidates: [] })).rejects.toThrow(/installed Chrome/);
	});
	it("returns only a verified MP4 and never overwrites an existing destination", async () => {
		const child = fakeChild();
		const spawn = vi.fn((_exe, args: string[], _options: unknown) => {
			void writeFile(args[args.indexOf("--output") + 1], "valid mp4").then(() =>
				child.emit("close", 0, null),
			);
			return child;
		});
		const probe = vi.fn().mockResolvedValue(undefined);
		const result = await renderHyperframesVideo({
			...renderOptions(),
			spawn: spawn as never,
			verifyVideo: probe,
		});
		expect(result.videoPath).toBe(path.join(directory, "edited.mp4"));
		expect(await readFile(result.videoPath, "utf8")).toBe("valid mp4");
		expect(spawn.mock.calls[0][1]).toEqual(
			expect.arrayContaining(["render", directory, "--strict", "--no-best-effort"]),
		);
		expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false, cwd: directory });
		expect(spawn.mock.calls[0][2]).toMatchObject({
			env: {
				HYPERFRAMES_NO_UPDATE_CHECK: "1",
				HYPERFRAMES_NO_AUTO_INSTALL: "1",
				HYPERFRAMES_BROWSER_PATH: "/local/chrome",
				PUPPETEER_SKIP_DOWNLOAD: "true",
			},
		});
		expect(probe).toHaveBeenCalledOnce();
		await expect(renderHyperframesVideo(renderOptions())).rejects.toThrow(/already exists/);
	});
	it("propagates CLI errors and leaves the editable project intact", async () => {
		const child = fakeChild();
		const job = renderHyperframesVideo({
			...renderOptions(),
			spawn: (() => {
				queueMicrotask(() => {
					child.stderr.write("missing Chrome");
					child.emit("close", 2, null);
				});
				return child;
			}) as never,
		});
		await expect(job).rejects.toThrow(/missing Chrome/);
		expect(await readFile(path.join(directory, "index.html"), "utf8")).toContain("doctype");
	});
	it("rejects duplicate jobs while a long render is running, then releases its lock", async () => {
		const child = fakeChild();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const job = renderHyperframesVideo({
			...renderOptions(),
			spawn: (() => {
				started();
				return child;
			}) as never,
		});
		await ready;
		await expect(renderHyperframesVideo(renderOptions())).rejects.toThrow(/render.*already/i);
		child.emit("error", new Error("spawn failed"));
		await expect(job).rejects.toThrow(/spawn failed/);
		await expect(
			renderHyperframesVideo({ projectDirectory: directory, executableCandidates: [] }),
		).rejects.toThrow(/installed.*HyperFrames/i);
	});
	it("rejects a successful CLI with missing output, bad media or a directory masquerading as MP4", async () => {
		for (const output of ["missing", "directory", "corrupt"]) {
			const child = fakeChild();
			const spawn = vi.fn((_exe, args: string[]) => {
				const target = args[args.indexOf("--output") + 1];
				void (
					output === "directory"
						? mkdir(target)
						: output === "corrupt"
							? writeFile(target, "bad")
							: Promise.resolve()
				).then(() => child.emit("close", 0, null));
				return child;
			});
			await expect(
				renderHyperframesVideo({ ...renderOptions(), spawn: spawn as never }),
			).rejects.toThrow();
		}
	});
	it("force-rejects a wedged process that ignores TERM and emits no close, then releases the lock", async () => {
		const child = fakeChild();
		await expect(
			renderHyperframesVideo({
				...renderOptions(),
				spawn: (() => child) as never,
				timeoutMs: 10,
				terminationGraceMs: 10,
			}),
		).rejects.toThrow(/timed out/);
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		await expect(
			renderHyperframesVideo({ projectDirectory: directory, executableCandidates: [] }),
		).rejects.toThrow(/installed.*HyperFrames/i);
	});
	it("verifies the single soundtrack both before and after normalization", async () => {
		const child = fakeChild();
		const spawn = vi.fn((_exe, args: string[]) => {
			void writeFile(args[args.indexOf("--output") + 1], "raw mp4").then(() =>
				child.emit("close", 0, null),
			);
			return child;
		});
		const verifyVideo = vi.fn().mockResolvedValue(undefined);
		const normalizeAudio = vi.fn(async ({ outputPath }: { outputPath: string }) => {
			await writeFile(outputPath, "normalized mp4");
			return "normalized" as const;
		});
		const result = await renderHyperframesVideo({
			...renderOptions(),
			spawn: spawn as never,
			expectedAudio: true,
			verifyVideo,
			normalizeAudio,
		});
		expect(verifyVideo.mock.calls.map((call) => call[1])).toEqual([true, true]);
		expect(result.audioNormalization).toBe("normalized");
		expect(await readFile(result.videoPath, "utf8")).toBe("normalized mp4");
	});
	it.each([
		"first verification",
		"normalization",
		"final verification",
	])("honors cancellation paused at %s, publishes nothing, and releases its lock", async (phase) => {
		const controller = new AbortController(),
			child = fakeChild();
		let reached!: () => void, release!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pause = async () => {
			reached();
			await resume;
		};
		const spawn = vi.fn((_exe, args: string[]) => {
			void writeFile(args[args.indexOf("--output") + 1], "raw mp4").then(() =>
				child.emit("close", 0, null),
			);
			return child;
		});
		let verifications = 0;
		const job = renderHyperframesVideo({
			...renderOptions(),
			spawn: spawn as never,
			signal: controller.signal,
			expectedAudio: phase !== "first verification",
			verifyVideo: async () => {
				verifications++;
				if (
					phase === "first verification" ||
					(phase === "final verification" && verifications === 2)
				)
					await pause();
			},
			normalizeAudio: async ({ outputPath }) => {
				await writeFile(outputPath, "normalized mp4");
				if (phase === "normalization") await pause();
				return "normalized";
			},
		});
		await paused;
		const rejection = expect(job).rejects.toThrow(/canceled/);
		controller.abort();
		release();
		await rejection;
		await expect(readFile(path.join(directory, "edited.mp4"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await readFile(path.join(directory, "index.html"), "utf8")).toContain("doctype");
		await expect(
			renderHyperframesVideo({ projectDirectory: directory, executableCandidates: [] }),
		).rejects.toThrow(/installed.*HyperFrames/i);
	});
	it("treats publication as a non-cancelable commit before the asynchronous exclusive link starts", async () => {
		const controller = new AbortController(),
			child = fakeChild();
		let entered!: () => void, release!: () => void;
		const linking = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onPublicationCommit = vi.fn();
		const job = renderHyperframesVideo({
			...renderOptions(),
			signal: controller.signal,
			verifyVideo: async () => undefined,
			spawn: ((_exe, args: string[]) => {
				void writeFile(args[args.indexOf("--output") + 1], "verified mp4").then(() =>
					child.emit("close", 0, null),
				);
				return child;
			}) as never,
			onPublicationCommit,
			publishVideo: async (source, destination) => {
				expect(onPublicationCommit).toHaveBeenCalledOnce();
				entered();
				await resume;
				await link(source, destination);
			},
		});
		await linking;
		controller.abort();
		release();
		const result = await job;
		expect(await readFile(result.videoPath, "utf8")).toBe("verified mp4");
	});
	it("preserves another owner's destination if it appears during the exclusive publication window", async () => {
		const controller = new AbortController(),
			child = fakeChild();
		await expect(
			renderHyperframesVideo({
				...renderOptions(),
				signal: controller.signal,
				verifyVideo: async () => undefined,
				spawn: ((_exe, args: string[]) => {
					void writeFile(args[args.indexOf("--output") + 1], "verified mp4").then(() =>
						child.emit("close", 0, null),
					);
					return child;
				}) as never,
				publishVideo: async (source, destination) => {
					await writeFile(destination, "another owner's video", { flag: "wx" });
					controller.abort();
					await link(source, destination);
				},
			}),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(path.join(directory, "edited.mp4"), "utf8")).toBe(
			"another owner's video",
		);
		await expect(renderHyperframesVideo(renderOptions())).rejects.toThrow(/already exists/);
	});
});

describe("finished soundtrack speech loudness", () => {
	it("measures then normalizes quiet speech with stream-copied video and one mapped audio track", async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce(
				'noise\n{"input_i":"-35.87","input_tp":"-18.0","input_lra":"4.0","input_thresh":"-45.0","target_offset":"0.02"}',
			)
			.mockResolvedValueOnce("");
		expect(
			await normalizeHyperframesAudio({
				inputPath: "/project/raw.mp4",
				outputPath: "/project/normalized.mp4",
				executable: "/local/ffmpeg",
				run,
			}),
		).toBe("normalized");
		expect(run).toHaveBeenCalledTimes(2);
		const args = run.mock.calls[1][1] as string[];
		expect(args).toEqual(expect.arrayContaining(["0:v:0", "0:a:0", "-c:v", "copy", "-n"]));
		expect(args[args.indexOf("-af") + 1]).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
		expect(args[args.indexOf("-af") + 1]).toContain("measured_I=-35.87");
	});
	it.each([
		"-inf",
		"-72",
	])("preserves legitimate silence/near-silence (%s LUFS) without amplifying noise", async (input_i) => {
		const run = vi.fn().mockResolvedValueOnce(
			JSON.stringify({
				input_i,
				input_tp: "-70",
				input_lra: "0",
				input_thresh: "-80",
				target_offset: "inf",
			}),
		);
		await expect(
			normalizeHyperframesAudio({
				inputPath: "/project/raw.mp4",
				outputPath: "/project/normalized.mp4",
				executable: "/local/ffmpeg",
				run,
			}),
		).resolves.toBe("silent");
		expect(run).toHaveBeenCalledOnce();
	});
	it("fails actionable processing errors and invalid measurements instead of silently delivering quiet audio", async () => {
		for (const run of [
			vi.fn().mockRejectedValue(new Error("FFmpeg failed")),
			vi.fn().mockResolvedValue("not measurements"),
		])
			await expect(
				normalizeHyperframesAudio({
					inputPath: "/project/raw.mp4",
					outputPath: "/project/normalized.mp4",
					executable: "/local/ffmpeg",
					run,
				}),
			).rejects.toThrow(/FFmpeg|loudness/);
	});
});
