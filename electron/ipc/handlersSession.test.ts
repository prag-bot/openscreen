// @vitest-environment node
import { constants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import {
	ALL_FORMATS,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	FilePathTarget,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRecordingSession, type RecordingSession } from "../../src/lib/recordingSession";
import { restoreRecordingSession } from "../recording/restoreRecordingSession";

const source = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
function productionSection(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	if (from < 0 || to < 0) throw new Error(`Missing production section: ${start}`);
	return source.slice(from, to);
}

/** Remux the checked-in VP9 fixture into a real playable MP4 without an encoder or CLI. */
async function writePlayableDerivative(destination: string): Promise<void> {
	const input = new Input({
		formats: ALL_FORMATS,
		source: new FilePathSource(path.resolve("tests/fixtures/sample.webm")),
	});
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new FilePathTarget(destination),
	});
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track?.codec) throw new Error("Fixture lacks video");
		const decoderConfig = await track.getDecoderConfig();
		if (!decoderConfig) throw new Error("Fixture lacks decoder configuration");
		const video = new EncodedVideoPacketSource(track.codec);
		output.addVideoTrack(video);
		await output.start();
		for await (const packet of new EncodedPacketSink(track).packets())
			await video.add(packet, { decoderConfig });
		await output.finalize();
	} catch (error) {
		await output.cancel().catch(() => undefined);
		throw error;
	} finally {
		input.dispose();
	}
}

describe("actual recording-session loader and current-video fallback", () => {
	let directory: string;
	let session: RecordingSession;
	let manifestPath: string;
	let originalManifestPath: string;
	let serialized: string;
	let derivative: Buffer;
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(tmpdir(), "openscreen-external-session-"));
		const mediaDirectory = path.join(directory, "external");
		await fs.mkdir(mediaDirectory);
		session = {
			screenVideoPath: path.join(mediaDirectory, "screen-playback.mp4"),
			originalScreenVideoPath: path.join(mediaDirectory, "screen.mp4"),
			webcamVideoPath: path.join(mediaDirectory, "camera.webm"),
			webcamOffsetSeconds: -0.35,
			cursorCaptureMode: "editable-overlay",
			createdAt: 1234,
		};
		await writePlayableDerivative(session.screenVideoPath);
		derivative = await fs.readFile(session.screenVideoPath);
		await fs.writeFile(session.webcamVideoPath!, "original camera");
		manifestPath = path.join(mediaDirectory, "screen-playback.session.json");
		originalManifestPath = path.join(mediaDirectory, "screen.session.json");
		serialized = JSON.stringify(session, null, 2);
		await fs.writeFile(manifestPath, serialized);
		await fs.writeFile(originalManifestPath, serialized);
	});
	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	function harness(unreadable?: string) {
		const writes = vi.fn(fs.writeFile);
		const access = vi.fn(async (candidate: string, mode?: number) => {
			if (candidate === unreadable) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			await fs.access(candidate, mode);
		});
		const prepare = vi.fn(async (value: RecordingSession) => ({
			...value,
			screenVideoPath: value.screenVideoPath.replace(/\.mp4$/, "-playback.mp4"),
			originalScreenVideoPath: value.originalScreenVideoPath ?? value.screenVideoPath,
		}));
		// Execute the production functions verbatim, as in cursorAccess.test.ts. No Electron
		// app, native capture, or duplicated restoration implementation is involved.
		const code = [
			productionSection("function approveFilePath(", "// Attach the parent window"),
			productionSection("function hasAllowedImportVideoExtension(", "function runProcess("),
			productionSection(
				"async function approveReadableVideoPath(",
				"function resolveRecordingOutputPath(",
			),
			productionSection("function normalizePath(", "function isTrustedProjectPath("),
			productionSection(
				"function setCurrentRecordingSessionState(",
				"export function registerIpcHandlers(",
			),
			productionSection(
				"\tasync function setCurrentVideoPath(",
				'\tipcMain.handle("get-current-video-path"',
			),
			"globalThis.testApi = { setCurrentVideoPath, readRecordedSessionForVideoPath, current: () => currentRecordingSession };",
		].join("\n");
		const context = {
			fs: { ...fs, writeFile: writes, access },
			fsConstants: constants,
			path,
			fileURLToPath,
			process: { platform: "darwin" },
			approvedPaths: new Set([session.screenVideoPath]),
			RECORDINGS_DIR: path.join(directory, "app-recordings"),
			RECORDING_SESSION_SUFFIX: ".session.json",
			ALLOWED_IMPORT_VIDEO_EXTENSIONS: new Set([".mp4", ".webm"]),
			normalizeRecordingSession,
			restoreRecordingSession,
			prepareMacPlaybackSession: prepare,
			findNativeMacCaptureHelperPath: vi.fn().mockResolvedValue("/unused/native-helper"),
			currentRecordingSession: null,
			currentVideoPath: null,
			currentProjectPath: null,
			console: { error: vi.fn() },
			testApi: {} as {
				setCurrentVideoPath: (video: string) => Promise<{ success: boolean; message?: string }>;
				readRecordedSessionForVideoPath: (video: string) => Promise<RecordingSession | null>;
				current: () => RecordingSession | null;
			},
		};
		runInNewContext(transformSync(code, { loader: "ts" }).code, context);
		return { ...context.testApi, prepare, writes, access };
	}

	it.each([
		"missing original",
		"unapproved original",
		"unreadable original",
		"missing webcam",
		"missing screen",
	])("fails closed for a matching session with %s, preserving both manifests and every metadata field", async (failure) => {
		if (failure === "unapproved original") {
			session.originalScreenVideoPath = path.join(directory, "unapproved.mp4");
			serialized = JSON.stringify(session, null, 2);
			await fs.writeFile(manifestPath, serialized);
			await fs.writeFile(originalManifestPath, serialized);
		}
		if (failure !== "missing original")
			await fs.writeFile(session.originalScreenVideoPath!, "original screen");
		if (failure === "missing webcam") await fs.unlink(session.webcamVideoPath!);
		if (failure === "missing screen") await fs.unlink(session.screenVideoPath);
		const api = harness(
			failure === "unreadable original" ? session.originalScreenVideoPath : undefined,
		);
		const result = await api.setCurrentVideoPath(session.screenVideoPath);
		expect(result).toMatchObject({
			success: false,
			message: expect.stringMatching(/restore.*session/i),
		});
		expect(result.message).toContain(
			failure.includes("original")
				? session.originalScreenVideoPath
				: failure.includes("webcam")
					? session.webcamVideoPath
					: session.screenVideoPath,
		);
		expect(result.message).toMatch(/metadata.*not.*discarded/i);
		expect(api.prepare).not.toHaveBeenCalled();
		expect(api.writes).not.toHaveBeenCalled();
		expect(api.current()).toBeNull();
		expect(await fs.readFile(manifestPath, "utf8")).toBe(serialized);
		expect(await fs.readFile(originalManifestPath, "utf8")).toBe(serialized);
		if (failure !== "missing screen")
			expect(await fs.readFile(session.screenVideoPath)).toEqual(derivative);
		if (failure !== "missing original")
			expect(await fs.readFile(session.originalScreenVideoPath!, "utf8")).toBe("original screen");
		if (failure !== "missing webcam")
			expect(await fs.readFile(session.webcamVideoPath!, "utf8")).toBe("original camera");
		await expect(
			fs.stat(path.join(path.dirname(session.screenVideoPath), "screen-playback-playback.mp4")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("restores the complete matching session when all media remain readable", async () => {
		await fs.writeFile(session.originalScreenVideoPath!, "original screen");
		const api = harness();
		await expect(api.setCurrentVideoPath(session.screenVideoPath)).resolves.toMatchObject({
			success: true,
		});
		expect(api.prepare).toHaveBeenCalledExactlyOnceWith(session, {
			helperPath: "/unused/native-helper",
		});
		expect(api.current()).toMatchObject({
			originalScreenVideoPath: session.originalScreenVideoPath,
			webcamVideoPath: session.webcamVideoPath,
			webcamOffsetSeconds: -0.35,
			cursorCaptureMode: "editable-overlay",
			createdAt: 1234,
		});
	});

	it.each([
		"absent",
		"unrelated",
	])("retains the intended null result for an %s session", async (kind) => {
		if (kind === "absent") await fs.unlink(manifestPath);
		else
			await fs.writeFile(
				manifestPath,
				JSON.stringify({ ...session, screenVideoPath: path.join(directory, "unrelated.mp4") }),
			);
		const api = harness();
		await expect(api.readRecordedSessionForVideoPath(session.screenVideoPath)).resolves.toBeNull();
		expect(api.prepare).not.toHaveBeenCalled();
		expect(api.writes).not.toHaveBeenCalled();
	});
});
