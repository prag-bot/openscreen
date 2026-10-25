import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
	ALL_FORMATS,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	FilePathSource,
	FilePathTarget,
	Input,
	Mp4OutputFormat,
	Output,
	WebMOutputFormat,
} from "mediabunny";
import {
	createHyperframesComposition,
	HYPERFRAMES_RAW_FOOTAGE_NOTE,
	type HyperframesAudioTrack,
	type HyperframesCursorData,
	type HyperframesExportRequest,
	type HyperframesMedia,
	validateHyperframesDuration,
	validateHyperframesExportRequest,
} from "../../src/lib/exporter/hyperframesExporter";
import { prepareHyperframesCursor } from "./hyperframesCursor";

export interface PreparedHyperframesMedia {
	screen: HyperframesMedia;
	webcam?: HyperframesMedia;
	audio: HyperframesAudioTrack[];
	cursor?: HyperframesCursorData;
}

export interface HyperframesProjectOptions {
	request: unknown;
	/** Selected by the native main-process dialog, never supplied by the renderer. */
	targetDirectory: string;
	gsapSource: string;
	resolveApprovedMediaPath: (filePath: string) => Promise<string | null>;
	/** Injectable for filesystem/IPC tests; production always uses the local remuxer. */
	prepareMedia?: (
		request: HyperframesExportRequest,
		assetsDirectory: string,
	) => Promise<PreparedHyperframesMedia>;
}

/** Read packet metadata and losslessly remux each audio stream, without subprocesses. */
export async function prepareHyperframesMedia(
	request: HyperframesExportRequest,
	assetsDirectory: string,
): Promise<PreparedHyperframesMedia> {
	const audio: HyperframesAudioTrack[] = [];
	const audioSources = new Set<string>();
	async function prepare(
		filePath: string,
		name: "screen" | "webcam",
		offset: number,
	): Promise<HyperframesMedia> {
		const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
		try {
			const video = await input.getPrimaryVideoTrack();
			if (!video) throw new Error(`${name} media has no readable video track`);
			const durationSeconds = validateHyperframesDuration(await video.computeDuration());
			const width = video.displayWidth;
			const height = video.displayHeight;
			if (!width || !height) throw new Error(`${name} media has invalid dimensions`);
			const fileName = `${name}${path.extname(filePath).toLowerCase()}`;
			await fs.copyFile(filePath, path.join(assetsDirectory, fileName), constants.COPYFILE_EXCL);
			const audioTracks = audioSources.has(filePath) ? [] : await input.getAudioTracks();
			audioSources.add(filePath);
			for (const [index, track] of audioTracks.entries()) {
				if (!track.codec) throw new Error(`Cannot export unknown ${name} audio codec`);
				const config = await track.getDecoderConfig();
				if (!config) throw new Error(`Cannot read ${name} audio track ${index + 1}`);
				const firstTimestamp = await track.getFirstTimestamp();
				const audioDuration = validateHyperframesDuration(
					(await track.computeDuration()) - firstTimestamp,
				);
				const format =
					track.codec === "opus" || track.codec === "vorbis"
						? new WebMOutputFormat()
						: new Mp4OutputFormat({ fastStart: false });
				if (!format.getSupportedAudioCodecs().includes(track.codec)) {
					throw new Error(`Cannot losslessly export ${name} audio codec ${track.codec}`);
				}
				const audioFile = `${name}-audio-${index + 1}${format.fileExtension}`;
				const output = new Output({
					format,
					target: new FilePathTarget(path.join(assetsDirectory, audioFile)),
				});
				const source = new EncodedAudioPacketSource(track.codec);
				output.addAudioTrack(source);
				try {
					await output.start();
					for await (const packet of new EncodedPacketSink(track).packets()) {
						await source.add(packet.clone({ timestamp: packet.timestamp - firstTimestamp }), {
							decoderConfig: config,
						});
					}
					await output.finalize();
				} catch (error) {
					await output.cancel().catch(() => undefined);
					throw error;
				}
				audio.push({
					src: `assets/${audioFile}`,
					offsetSeconds: offset + firstTimestamp,
					durationSeconds: audioDuration,
				});
			}
			return { src: `assets/${fileName}`, durationSeconds, width, height };
		} finally {
			input.dispose();
		}
	}
	// A playback derivative already contains a mix: export the immutable original streams OR
	// that derivative, never both. This preserves every original track exactly once.
	const screen = await prepare(
		request.originalScreenVideoPath ?? request.screenVideoPath,
		"screen",
		0,
	);
	if (request.durationSeconds > screen.durationSeconds + 0.5) {
		throw new Error(
			"Editor duration exceeds available screen footage; reload the recording before exporting",
		);
	}
	const webcam = request.webcamVideoPath
		? await prepare(request.webcamVideoPath, "webcam", request.webcamOffsetSeconds ?? 0)
		: undefined;
	return { screen, webcam, audio };
}

export async function writeHyperframesProject(
	options: HyperframesProjectOptions,
): Promise<{ path: string; warnings: string[]; audioTrackCount: number }> {
	const request = validateHyperframesExportRequest(options.request);
	if (!options.gsapSource.trim()) throw new Error("The bundled GSAP runtime is missing");
	async function approvedFile(filePath: string): Promise<string> {
		const approved = await options.resolveApprovedMediaPath(filePath);
		if (!approved || !path.isAbsolute(approved))
			throw new Error("Media path is not approved for export");
		const stat = await fs.stat(approved);
		if (!stat.isFile() || stat.size === 0) throw new Error("Missing or empty recording media");
		return approved;
	}
	request.screenVideoPath = await approvedFile(request.screenVideoPath);
	if (request.originalScreenVideoPath)
		request.originalScreenVideoPath = await approvedFile(request.originalScreenVideoPath);
	if (request.webcamVideoPath)
		request.webcamVideoPath = await approvedFile(request.webcamVideoPath);

	const target = options.targetDirectory;
	if (
		typeof target !== "string" ||
		target.includes("\0") ||
		!path.isAbsolute(target) ||
		path.normalize(target) !== target ||
		path.dirname(target) === target
	) {
		throw new Error("Choose a new project directory with a valid absolute path");
	}
	// The existing parent is canonicalized. No recursive mkdir or writes into a pre-existing target.
	const parent = await fs.realpath(path.dirname(target));
	const destination = path.join(parent, path.basename(target));
	await fs.mkdir(destination);
	const ownedDirectory = await fs.lstat(destination);
	try {
		const assets = path.join(destination, "assets");
		await fs.mkdir(assets);
		await fs.mkdir(path.join(destination, "vendor"));
		const media = await (options.prepareMedia ?? prepareHyperframesMedia)(request, assets);
		if (request.cursorCaptureMode === "editable-overlay")
			media.cursor = await prepareHyperframesCursor(
				request.originalScreenVideoPath ?? request.screenVideoPath,
				assets,
			);
		const composition = createHyperframesComposition(request, media);
		await fs.writeFile(path.join(destination, "vendor", "gsap.min.js"), options.gsapSource, {
			flag: "wx",
		});
		await fs.writeFile(path.join(destination, "index.html"), composition.html, { flag: "wx" });
		await fs.writeFile(
			path.join(destination, "openscreen-export.json"),
			JSON.stringify(
				{
					version: 1,
					units: {
						trimRegions: "milliseconds",
						presentationRegions: "milliseconds",
						clips: "seconds",
					},
					durationSeconds: composition.durationSeconds,
					trimRegions: request.trimRegions,
					keptSegments: composition.segments,
					presentationRegions: request.presentationRegions ?? [],
					visualSegments: composition.visualSegments,
					warnings: composition.warnings,
					webcamOffsetSeconds: request.webcamOffsetSeconds ?? 0,
					cursor: {
						captureMode: request.cursorCaptureMode ?? "unknown",
						visible: request.showCursor ?? false,
						size: request.cursorSize ?? 1,
						clipToBounds: request.cursorClipToBounds !== false,
					},
					layout: {
						width: request.width,
						height: request.height,
						webcamLayoutPreset: request.webcamLayoutPreset,
						webcamMaskShape: request.webcamMaskShape,
						webcamMirrored: request.webcamMirrored,
						webcamSizePreset: request.webcamSizePreset,
						webcamPosition: request.webcamPosition,
					},
					media,
				},
				null,
				2,
			),
			{ flag: "wx" },
		);
		await fs.writeFile(
			path.join(destination, "README.md"),
			`# OpenScreen → HyperFrames\n\n${HYPERFRAMES_RAW_FOOTAGE_NOTE}\n\nThis editable local project preserves full source assets in assets/ and exact reviewed removal ranges and presentation switches in openscreen-export.json. The manifest also records effective visual intervals and any camera-availability fallback warnings. No media is uploaded. Each retained range is a separate screen/camera/audio clip; original removed footage remains recoverable.\n\n## Finished video versus project only\n\nOpenScreen’s Render HyperFrames MP4 action runs only an already-installed local HyperFrames executable, then verifies edited.mp4 before reporting success. Its final soundtrack mixes every source audio stream once and uses installed FFmpeg for speech normalization (-16 LUFS, -1.5 dBTP; legitimate silence is not amplified). A failed render retains this project for recovery. Project-only export deliberately creates no video.\n\n## Preview and render manually\n\nRequires an already-installed HyperFrames, Node.js 22+, FFmpeg and Chrome/Chromium. OpenScreen never installs tools. In this folder:\n\n\`\`\`sh\nHYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1 hyperframes lint\nHYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1 hyperframes validate\nHYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1 hyperframes preview\n# The CLI itself can download a browser when none is configured; set an existing browser path explicitly.\nHYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1 HYPERFRAMES_BROWSER_PATH=/absolute/path/to/existing/chrome hyperframes render --output edited.mp4\n\`\`\`\n\nGSAP is bundled locally in vendor/gsap.min.js.\n\n## Editable tracks\n\n- Track 0: screen video during demo or legacy intervals, muted; absent during face-only intervals. The immutable original is used instead of a playback derivative when available.\n- Track 1: camera video, muted; layout, size, position, mask, mirroring and start offset are retained. Reviewed face-only intervals fill the frame with unmasked camera footage; reviewed demo intervals use a bottom-right camera overlay. Without reviewed switches, the selected global layout is preserved. Missing camera time falls back to demo with a warning; no camera frames are fabricated. No-webcam hides legacy camera clips, not its source asset.\n- Tracks 10 onward: every original audio stream, losslessly remuxed separately and represented exactly once. Muted video elements cannot double the audio. A source mixed during recording cannot be unmixed.\n- Native cursor: validated recorded positions, hotspot/scale, asset changes and visibility. Source-clock snapshots at every cut join prevent motion across removed footage. Captured native PNGs (or the same bundled shapes used by the editor for telemetry-only capture) are copied locally. System-cursor recordings never get a second overlay.\n\nAll video/audio remain DIRECT children of the openscreen root. data-start, data-duration, data-media-start and camera offset are seconds; removal and presentation ranges are milliseconds on the original screen clock. Presentation boundaries split visual clips only; audio retains the same kept source ranges. The cursor is hidden during face-only intervals with seekable timeline states. Gaps before/after delayed camera or audio stay gaps, never fabricated frames.\n\nUnsupported OpenScreen effects listed above are not flattened into this raw-footage composition. Keep editing index.html in HyperFrames Studio when you need additional visual treatments. Original media is never modified.\n`,
			{ flag: "wx" },
		);
		return {
			path: destination,
			warnings: [HYPERFRAMES_RAW_FOOTAGE_NOTE, ...composition.warnings],
			audioTrackCount: composition.audioTrackCount,
		};
	} catch (error) {
		// Remove only the directory created by this invocation, never an existing project or replacement.
		const current = await fs.lstat(destination).catch(() => null);
		if (
			current?.isDirectory() &&
			current.ino === ownedDirectory.ino &&
			current.dev === ownedDirectory.dev
		) {
			await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
		}
		throw error;
	}
}
