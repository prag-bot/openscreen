import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";

/** Local installations only. Never use npx, a login shell, or a download fallback. */
export async function resolveHyperframesExecutable(
	options: { candidates?: string[] } = {},
): Promise<string> {
	return resolveInstalledExecutable("hyperframes", options.candidates);
}

async function resolveInstalledExecutable(tool: string, explicit?: string[]): Promise<string> {
	const executable = process.platform === "win32" ? `${tool}.exe` : tool;
	const candidates = explicit ?? [
		`/opt/homebrew/bin/${tool}`,
		`/usr/local/bin/${tool}`,
		...(process.env.PATH ?? "")
			.split(path.delimiter)
			.filter(Boolean)
			.map((directory) => path.join(directory, executable)),
	];
	for (const candidate of candidates) {
		if (!path.isAbsolute(candidate)) continue;
		try {
			const resolved = await fs.realpath(candidate);
			if (!(await fs.stat(resolved)).isFile()) continue;
			await fs.access(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK);
			return resolved;
		} catch {
			/* Try the next installed location. */
		}
	}
	throw new Error(
		`No installed local ${tool === "hyperframes" ? "HyperFrames" : tool} executable was found. Install/configure it explicitly, then retry. No tools were downloaded.`,
	);
}

/** Pin an existing browser so HyperFrames cannot enter its implicit browser-download path. */
export async function resolveHyperframesBrowser(
	options: { candidates?: string[] } = {},
): Promise<string> {
	const candidates =
		options.candidates ??
		[
			process.env.HYPERFRAMES_BROWSER_PATH,
			process.env.PUPPETEER_EXECUTABLE_PATH,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			...(process.env.LOCALAPPDATA
				? [path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")]
				: []),
			...(process.env.PROGRAMFILES
				? [path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")]
				: []),
		].filter((candidate): candidate is string => Boolean(candidate));
	// Only bounded standard cache directories are examined, never arbitrary recursive home scans.
	for (const root of options.candidates
		? []
		: [
				path.join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"),
				path.join(homedir(), ".cache", "puppeteer", "chrome-headless-shell"),
			]) {
		for (const version of (await fs.readdir(root).catch(() => [])).sort().reverse().slice(0, 128)) {
			for (const platformDirectory of [
				"chrome-headless-shell-mac-arm64",
				"chrome-headless-shell-mac-x64",
				"chrome-headless-shell-linux64",
				"chrome-headless-shell-win64",
			])
				candidates.push(
					path.join(
						root,
						version,
						platformDirectory,
						process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
					),
				);
		}
	}
	try {
		return await resolveInstalledExecutable("Chrome/Chromium", candidates);
	} catch {
		throw new Error(
			"No installed Chrome/Chromium browser was found. Configure HYPERFRAMES_BROWSER_PATH or install the browser explicitly; OpenScreen will not download it.",
		);
	}
}

async function runInstalledTool(
	executable: string,
	args: string[],
	options: {
		cwd: string;
		signal?: AbortSignal;
		spawn?: typeof nodeSpawn;
		env?: Record<string, string>;
		timeoutMs?: number;
		terminationGraceMs?: number;
	},
): Promise<string> {
	if (options.signal?.aborted)
		throw new Error("HyperFrames export canceled; editable project retained");
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			PATH: [
				path.dirname(executable),
				"/opt/homebrew/bin",
				"/usr/local/bin",
				process.env.PATH ?? "",
			].join(path.delimiter),
			HYPERFRAMES_NO_UPDATE_CHECK: "1",
			HYPERFRAMES_NO_AUTO_INSTALL: "1",
			PUPPETEER_SKIP_DOWNLOAD: "true",
			...options.env,
		};
		const child = (options.spawn ?? nodeSpawn)(executable, args, {
			cwd: options.cwd,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		let diagnostics = "",
			settled = false,
			terminationReason: string | undefined,
			forceTimer: ReturnType<typeof setTimeout> | undefined;
		const collect = (chunk: Buffer | string) => {
			diagnostics = (diagnostics + chunk.toString()).slice(-32768);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const terminate = (reason: string) => {
			if (settled || terminationReason) return;
			terminationReason = reason;
			try {
				child.kill("SIGTERM");
			} catch {
				/* Force completion after the grace period. */
			}
			forceTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* The process may already be gone. */
				}
				finish(new Error(reason));
			}, options.terminationGraceMs ?? 5000);
		};
		const abort = () => terminate("HyperFrames export canceled; editable project retained");
		const timer = setTimeout(
			() => terminate("HyperFrames export timed out; editable project retained"),
			options.timeoutMs ?? 24 * 60 * 60 * 1000,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			child.stdout?.removeListener("data", collect);
			child.stderr?.removeListener("data", collect);
			options.signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(diagnostics);
		};
		child.once("error", (error) =>
			finish(new Error(`Cannot start installed ${path.basename(executable)}: ${error.message}`)),
		);
		child.once("close", (code, signal) =>
			finish(
				terminationReason
					? new Error(terminationReason)
					: options.signal?.aborted
						? new Error("HyperFrames export canceled; editable project retained")
						: code === 0
							? undefined
							: new Error(
									`${path.basename(executable)} failed (${signal ?? code}): ${diagnostics.trim() || "No diagnostic output"}`,
								),
			),
		);
	});
}

export interface HyperframesAudioNormalizationOptions {
	inputPath: string;
	outputPath: string;
	executable?: string;
	signal?: AbortSignal;
	/** Test boundary; production always runs the installed FFmpeg process. */
	run?: typeof runInstalledTool;
}
/** Two-pass EBU R128 speech normalization. Original assets and video packets are untouched. */
export async function normalizeHyperframesAudio(
	options: HyperframesAudioNormalizationOptions,
): Promise<"normalized" | "silent"> {
	const executable = options.executable ?? (await resolveInstalledExecutable("ffmpeg"));
	const run = options.run ?? runInstalledTool;
	const processOptions = { cwd: path.dirname(options.inputPath), signal: options.signal };
	const target = "loudnorm=I=-16:TP=-1.5:LRA=11";
	const analysis = await run(
		executable,
		[
			"-hide_banner",
			"-nostdin",
			"-i",
			options.inputPath,
			"-map",
			"0:a:0",
			"-af",
			`${target}:print_format=json`,
			"-f",
			"null",
			"-",
		],
		processOptions,
	);
	const match = [...analysis.matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)].pop();
	if (!match)
		throw new Error(
			"FFmpeg loudness analysis returned no measurements; finished video was not published",
		);
	const measured = JSON.parse(match[0]) as Record<string, unknown>;
	const integrated = Number(measured.input_i);
	if (measured.input_i === "-inf" || (Number.isFinite(integrated) && integrated < -60))
		return "silent";
	const numeric = (key: string) => {
		const value = Number(measured[key]);
		if (!Number.isFinite(value) || Math.abs(value) > 200)
			throw new Error(`Invalid FFmpeg loudness measurement: ${key}`);
		return value;
	};
	const filter = `${target}:measured_I=${numeric("input_i")}:measured_TP=${numeric("input_tp")}:measured_LRA=${numeric("input_lra")}:measured_thresh=${numeric("input_thresh")}:offset=${numeric("target_offset")}:linear=true:print_format=summary`;
	await run(
		executable,
		[
			"-hide_banner",
			"-nostdin",
			"-n",
			"-i",
			options.inputPath,
			"-map",
			"0:v:0",
			"-map",
			"0:a:0",
			"-c:v",
			"copy",
			"-af",
			filter,
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			"-ar",
			"48000",
			"-map_metadata",
			"0",
			"-movflags",
			"+faststart",
			options.outputPath,
		],
		processOptions,
	);
	return "normalized";
}

export async function verifyHyperframesVideo(
	videoPath: string,
	expectedAudio: boolean,
): Promise<void> {
	const stat = await fs.lstat(videoPath);
	if (!stat.isFile() || stat.size < 12)
		throw new Error("HyperFrames did not produce a non-empty MP4 file");
	const handle = await fs.open(videoPath, "r");
	try {
		const signature = Buffer.alloc(12);
		await handle.read(signature, 0, 12, 0);
		if (signature.toString("ascii", 4, 8) !== "ftyp")
			throw new Error("HyperFrames output is not an MP4");
	} finally {
		await handle.close();
	}
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(videoPath) });
	try {
		const video = await input.getPrimaryVideoTrack();
		if (!video || !((await video.computeDuration()) > 0))
			throw new Error("HyperFrames output has no playable video track");
		const audio = await input.getAudioTracks();
		if (expectedAudio && audio.length !== 1)
			throw new Error(
				"HyperFrames must deliver one mixed soundtrack; output audio is missing or contains alternative tracks",
			);
		if (audio.some((track) => !track.codec))
			throw new Error("HyperFrames output has an unreadable audio track");
	} finally {
		input.dispose();
	}
}

let rendering = false;
export interface HyperframesRenderOptions {
	projectDirectory: string;
	/** Only main-process/test callers can supply these; IPC never accepts executables or commands. */
	executable?: string;
	executableCandidates?: string[];
	browserExecutable?: string;
	ffmpegExecutable?: string;
	timeoutMs?: number;
	terminationGraceMs?: number;
	expectedAudio?: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	spawn?: typeof nodeSpawn;
	verifyVideo?: typeof verifyHyperframesVideo;
	normalizeAudio?: typeof normalizeHyperframesAudio;
}

/** Render the new editable project, preserving it if rendering fails. */
export async function renderHyperframesVideo(
	options: HyperframesRenderOptions,
): Promise<{ videoPath: string; audioNormalization: "normalized" | "silent" | "none" }> {
	if (rendering)
		throw new Error("A HyperFrames video render is already running. Wait for it to finish.");
	rendering = true;
	let scratch: string | undefined;
	try {
		const requested = options.projectDirectory;
		if (
			!path.isAbsolute(requested) ||
			requested.includes("\0") ||
			path.normalize(requested) !== requested ||
			path.dirname(requested) === requested
		)
			throw new Error("Invalid HyperFrames project directory");
		const project = await fs.realpath(requested);
		const entry = await fs.lstat(path.join(project, "index.html"));
		if (!entry.isFile() || !entry.size)
			throw new Error("HyperFrames project index.html is missing or invalid");
		const videoPath = path.join(project, "edited.mp4");
		if (
			await fs.lstat(videoPath).then(
				() => true,
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return false;
					throw error;
				},
			)
		)
			throw new Error(
				"The finished video already exists. Nothing was overwritten; choose a new project folder.",
			);
		const executable =
			options.executable ??
			(await resolveHyperframesExecutable({ candidates: options.executableCandidates }));
		const browserExecutable = options.browserExecutable ?? (await resolveHyperframesBrowser());
		if (options.signal?.aborted)
			throw new Error("HyperFrames render canceled; editable project retained");
		scratch = await fs.mkdtemp(path.join(project, ".openscreen-render-"));
		const output = path.join(scratch, "edited.mp4");
		options.onProgress?.("Rendering MP4 locally. Long recordings may take several minutes…");
		await runInstalledTool(
			executable,
			[
				"render",
				project,
				"--output",
				output,
				"--format",
				"mp4",
				"--quality",
				"high",
				"--video-frame-format",
				"png",
				"--workers",
				"1",
				"--strict",
				"--no-best-effort",
			],
			{
				cwd: project,
				signal: options.signal,
				spawn: options.spawn,
				timeoutMs: options.timeoutMs,
				terminationGraceMs: options.terminationGraceMs,
				env: { HYPERFRAMES_BROWSER_PATH: browserExecutable },
			},
		);
		await (options.verifyVideo ?? verifyHyperframesVideo)(output, options.expectedAudio ?? false);
		let finalOutput = output;
		let audioNormalization: "normalized" | "silent" | "none" = "none";
		if (options.expectedAudio) {
			options.onProgress?.("Normalizing the finished mixed soundtrack for clear speech…");
			const normalized = path.join(scratch, "normalized.mp4");
			audioNormalization = await (options.normalizeAudio ?? normalizeHyperframesAudio)({
				inputPath: output,
				outputPath: normalized,
				executable: options.ffmpegExecutable,
				signal: options.signal,
			});
			if (audioNormalization === "normalized") finalOutput = normalized;
			await (options.verifyVideo ?? verifyHyperframesVideo)(finalOutput, true);
		}
		// Atomic, exclusive final publication: unlike rename, link can never replace an existing file.
		await fs.link(finalOutput, videoPath);
		options.onProgress?.("Finished MP4 verified");
		return { videoPath, audioNormalization };
	} finally {
		if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		rendering = false;
	}
}
