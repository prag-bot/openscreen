import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectMedia, RecordingSession } from "../../src/lib/recordingSession";

type HelperResult = { code: number | null; stdout: string; stderr: string };
interface PreparationOptions {
	helperPath: string | null;
	platform?: NodeJS.Platform;
	runHelper?: (helper: string, args: string[]) => Promise<HelperResult>;
}

// Keep process logs bounded even if a helper fails noisily. Media is streamed natively.
function runHelper(helper: string, args: string[]): Promise<HelperResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(helper, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout = (stdout + data.toString()).slice(-64_000);
		});
		child.stderr.on("data", (data) => {
			stderr = (stderr + data.toString()).slice(-64_000);
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

export async function approveProjectMediaPaths(
	media: ProjectMedia,
	approve: (value: string) => Promise<string | null>,
): Promise<ProjectMedia> {
	const screenVideoPath = await approve(media.screenVideoPath);
	if (!screenVideoPath)
		throw new Error("Project references an invalid or unsupported screen video path");
	const originalScreenVideoPath = media.originalScreenVideoPath
		? await approve(media.originalScreenVideoPath)
		: undefined;
	if (media.originalScreenVideoPath && !originalScreenVideoPath)
		throw new Error("Project references an invalid or unsupported original screen video path");
	const webcamVideoPath = media.webcamVideoPath ? await approve(media.webcamVideoPath) : undefined;
	if (media.webcamVideoPath && !webcamVideoPath)
		throw new Error("Project references an invalid or unsupported webcam video path");
	return {
		...media,
		screenVideoPath,
		...(originalScreenVideoPath ? { originalScreenVideoPath } : {}),
		...(webcamVideoPath ? { webcamVideoPath } : {}),
	};
}

async function cursorSidecar(source: string): Promise<Buffer | null> {
	try {
		const sidecar = `${source}.cursor.json`;
		const info = await fs.stat(sidecar);
		if (!info.isFile() || info.size > 32 * 1024 * 1024)
			throw new Error("Cursor telemetry sidecar is not a bounded regular file");
		const data = await fs.readFile(sidecar);
		const parsed = JSON.parse(data.toString("utf8"));
		const samples = Array.isArray(parsed) ? parsed : parsed?.samples;
		if (
			!Array.isArray(samples) ||
			samples.some((sample: unknown) => {
				if (!sample || typeof sample !== "object") return true;
				const point = sample as Record<string, unknown>;
				return ![point.timeMs, point.cx, point.cy].every(
					(value) => typeof value === "number" && Number.isFinite(value),
				);
			})
		)
			throw new Error("Cursor telemetry sidecar is invalid");
		return data;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file, constants.F_OK);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Native helper uses an exclusive atomic publication; it can never replace the capture. */
export async function prepareMacPlaybackSession(
	session: RecordingSession,
	options: PreparationOptions,
): Promise<RecordingSession> {
	if (
		(options.platform ?? process.platform) !== "darwin" ||
		path.extname(session.screenVideoPath).toLowerCase() !== ".mp4"
	)
		return session;
	const original = session.originalScreenVideoPath ?? session.screenVideoPath;
	try {
		if (!options.helperPath)
			throw new Error(
				"Native audio helper is unavailable; build the macOS capture helper and retry",
			);
		const source = await fs.stat(original);
		if (!source.isFile()) throw new Error("Original recording is not a regular file");
		const telemetry = await cursorSidecar(original);
		let playback = session.screenVideoPath;
		const reuse = Boolean(
			session.originalScreenVideoPath &&
				path.resolve(original) !== path.resolve(playback) &&
				(await exists(playback)),
		);
		if (!reuse) {
			const parsed = path.parse(original);
			playback = path.join(parsed.dir, `${parsed.name}-playback.mp4`);
			if (await exists(playback))
				playback = path.join(parsed.dir, `${parsed.name}-playback-${randomUUID()}.mp4`);
		}
		const result = await (options.runHelper ?? runHelper)(options.helperPath, [
			reuse ? "--validate-playback" : "--prepare-playback",
			original,
			playback,
		]);
		if (result.code !== 0)
			throw new Error(
				result.stderr.trim() || result.stdout.trim() || `Native audio helper exited ${result.code}`,
			);
		const ready = result.stdout.split(/\r?\n/).some((line) => {
			try {
				const event = JSON.parse(line);
				return (
					event.event === "playback-ready" &&
					(event.audioTrackCount === 0 ||
						(event.audioTrackCount === 1 && event.audioSampleCount > 0))
				);
			} catch {
				return false;
			}
		});
		if (!ready)
			throw new Error(
				"Native playback validation did not confirm a complete, single-soundtrack output",
			);
		if (telemetry) {
			const existingTelemetry = await cursorSidecar(playback);
			if (existingTelemetry && !existingTelemetry.equals(telemetry))
				throw new Error(
					"Playback cursor sidecar already exists with different telemetry; refusing to overwrite it",
				);
			if (!existingTelemetry)
				await fs.writeFile(`${playback}.cursor.json`, telemetry, { flag: "wx" });
		}
		return { ...session, screenVideoPath: playback, originalScreenVideoPath: original };
	} catch (error) {
		throw new Error(
			`Could not prepare recording audio. Original recording retained at ${original}. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
