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
	type HyperframesExportRequest,
	type HyperframesMedia,
	validateHyperframesDuration,
	validateHyperframesExportRequest,
} from "../../src/lib/exporter/hyperframesExporter";

export interface PreparedHyperframesMedia {
	screen: HyperframesMedia;
	webcam?: HyperframesMedia;
	audio: HyperframesAudioTrack[];
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
			for (const [index, track] of (await input.getAudioTracks()).entries()) {
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
	const screen = await prepare(request.screenVideoPath, "screen", 0);
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
): Promise<{ path: string; warnings: string[] }> {
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
					units: { trimRegions: "milliseconds", clips: "seconds" },
					durationSeconds: composition.durationSeconds,
					trimRegions: request.trimRegions,
					keptSegments: composition.segments,
					webcamOffsetSeconds: request.webcamOffsetSeconds ?? 0,
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
			`# OpenScreen → HyperFrames\n\n${HYPERFRAMES_RAW_FOOTAGE_NOTE}\n\nThis is a local editable project, not a flattened video or an AI auto-trim. No media was uploaded. Full source footage is copied into assets/ so removed footage can be restored. Each retained range is a separate clip.\n\n## Preview and render\n\nRequires Node.js 22+ and HyperFrames. Rendering also requires FFmpeg and the browser supported by your HyperFrames installation. In a terminal, change directory to THIS folder, then run:\n\n\`\`\`sh\nnpx hyperframes lint\nnpx hyperframes validate\nnpx hyperframes preview\n# Once you finish editing:\nnpx hyperframes render --output edited.mp4\n\`\`\`\n\nThese commands are suggestions only; OpenScreen never runs them. npx may download HyperFrames if it is not already installed. GSAP is already bundled locally in vendor/gsap.min.js.\n\n## Editable tracks\n\n- Track 0: screen video (muted).\n- Track 1: camera video, when recorded (muted). With no-webcam selected, camera clips are omitted entirely; the copied camera asset remains available in assets/ to add later.\n- Tracks 10 onward: individual audio streams, losslessly remuxed from the recordings. Silent recordings have no audio clips.\n\nEdit in HyperFrames Studio, or adjust index.html. Keep every video/audio a DIRECT child of the openscreen root. data-start, data-duration and data-media-start use seconds. Original removed ranges in openscreen-export.json use milliseconds. The camera offset is in seconds: positive means camera capture began later than screen capture. Current OpenScreen sessions do not persist a camera start offset, so exports use 0 unless an explicit offset was provided.\n\nThe composition retains static camera layout, size, position, mask, mirroring and visibility. Gaps before a delayed camera or after its footage ends remain gaps, not fabricated frames. Audio timing is aligned to original packet timestamps. Previously mixed system/microphone audio stays mixed; separate source streams stay separate. Unsupported media/codec or missing assets cause export failure instead of silent loss.\n\nThe fixed charcoal/green canvas follows OpenScreen's palette. Use MP4/GIF export in OpenScreen when you need its fully rendered effects.\n`,
			{ flag: "wx" },
		);
		return { path: destination, warnings: [HYPERFRAMES_RAW_FOOTAGE_NOTE] };
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
