import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ALL_FORMATS,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	FilePathTarget,
	Input,
	Output,
	WebMOutputFormat,
} from "mediabunny";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HyperframesExportRequest } from "../../src/lib/exporter/hyperframesExporter";
import { type PreparedHyperframesMedia, writeHyperframesProject } from "./hyperframesProject";

const request: HyperframesExportRequest = {
	screenVideoPath: "/placeholder.webm",
	durationSeconds: 2,
	width: 640,
	height: 480,
	trimRegions: [{ id: "removed", startMs: 500, endMs: 1000 }],
	webcamLayoutPreset: "picture-in-picture",
	webcamSizePreset: 25,
	webcamPosition: null,
	webcamMaskShape: "circle",
	webcamMirrored: false,
};
const fixturePath = path.resolve("tests/fixtures/sample.webm");
const prepared: PreparedHyperframesMedia = {
	screen: { src: "assets/screen.webm", durationSeconds: 2, width: 640, height: 480 },
	audio: [],
};

describe("HyperFrames project filesystem safety", () => {
	let directory: string;
	let source: string;
	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "openscreen-hyperframes-"));
		source = path.join(directory, "recording.webm");
		await writeFile(source, "test media");
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	const exportOptions = () => ({
		request: { ...request, screenVideoPath: source },
		targetDirectory: path.join(directory, "new-project"),
		gsapSource: "/* bundled local runtime */",
		resolveApprovedMediaPath: async (candidate: string) =>
			candidate === source ? candidate : null,
		prepareMedia: async () => prepared,
	});

	it("creates a new self-contained project and retains exact local timing metadata", async () => {
		const result = await writeHyperframesProject(exportOptions());
		const manifest = JSON.parse(
			await readFile(path.join(result.path, "openscreen-export.json"), "utf8"),
		);
		expect(manifest.durationSeconds).toBe(1.5);
		expect(manifest.trimRegions[0]).toMatchObject({ startMs: 500, endMs: 1000 });
		expect(manifest.keptSegments[1]).toEqual({ sourceStart: 1, timelineStart: 0.5, duration: 1 });
		expect(await readFile(path.join(result.path, "vendor", "gsap.min.js"), "utf8")).toContain(
			"local runtime",
		);
		expect(await readFile(path.join(result.path, "README.md"), "utf8")).toContain(
			"hyperframes preview",
		);
		expect(await readFile(path.join(result.path, "README.md"), "utf8")).toContain(
			"hyperframes render",
		);
	});

	it("never overwrites an existing folder, file or symlink", async () => {
		const options = exportOptions();
		await mkdir(options.targetDirectory);
		await writeFile(path.join(options.targetDirectory, "existing.txt"), "preserve");
		await expect(writeHyperframesProject(options)).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(path.join(options.targetDirectory, "existing.txt"), "utf8")).toBe(
			"preserve",
		);
		const existingFile = path.join(directory, "existing-project");
		await writeFile(existingFile, "keep");
		await expect(
			writeHyperframesProject({ ...options, targetDirectory: existingFile }),
		).rejects.toMatchObject({ code: "EEXIST" });
		const link = path.join(directory, "symlink-project");
		await symlink(options.targetDirectory, link);
		await expect(
			writeHyperframesProject({ ...options, targetDirectory: link }),
		).rejects.toMatchObject({ code: "EEXIST" });
	});

	it("refuses unapproved paths and missing assets before creating a target", async () => {
		const options = exportOptions();
		await expect(
			writeHyperframesProject({ ...options, resolveApprovedMediaPath: async () => null }),
		).rejects.toThrow(/not approved/);
		await expect(stat(options.targetDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			writeHyperframesProject({
				...options,
				request: { ...options.request, webcamVideoPath: path.join(directory, "missing.webm") },
				resolveApprovedMediaPath: async (candidate) => candidate,
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(options.targetDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		"relative/project",
		"/",
		"/tmp/../unsafe-project",
	])("refuses unsafe targets %s", async (targetDirectory) => {
		await expect(writeHyperframesProject({ ...exportOptions(), targetDirectory })).rejects.toThrow(
			/new project directory/,
		);
	});

	it("cleans up only its newly created project when remuxing fails", async () => {
		const options = exportOptions();
		await expect(
			writeHyperframesProject({
				...options,
				prepareMedia: async () => {
					throw new Error("Unsupported source codec");
				},
			}),
		).rejects.toThrow("Unsupported source codec");
		await expect(stat(options.targetDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(source, "utf8")).toBe("test media");
	});
});

/** Original fixture video packets plus two valid Opus silence streams; no encoding/CLI required. */
async function fixtureWithAudio(destination: string): Promise<void> {
	const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(fixturePath) });
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new FilePathTarget(destination),
	});
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track?.codec) throw new Error("Fixture lacks video");
		const config = await track.getDecoderConfig();
		if (!config) throw new Error("Fixture lacks decoder configuration");
		const video = new EncodedVideoPacketSource(track.codec);
		const audio = [new EncodedAudioPacketSource("opus"), new EncodedAudioPacketSource("opus")];
		output.addVideoTrack(video);
		for (const source of audio) output.addAudioTrack(source);
		await output.start();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await video.add(packet, { decoderConfig: config });
		}
		for (const [index, source] of audio.entries()) {
			const offset = (index + 1) * 0.1;
			for (let packet = 0; packet < 90; packet += 1) {
				await source.add(
					new EncodedPacket(
						new Uint8Array([0xf8, 0xff, 0xfe]),
						"key",
						offset + packet * 0.02,
						0.02,
					),
					{
						decoderConfig: { codec: "opus", sampleRate: 48000, numberOfChannels: 2 },
					},
				);
			}
		}
		await output.finalize();
	} catch (error) {
		await output.cancel().catch(() => undefined);
		throw error;
	} finally {
		input.dispose();
	}
}

describe("actual HyperFrames asset copying and audio remux", () => {
	it("exports original fixture video and both source audio streams as separate editable clips", async () => {
		const scratch = await mkdtemp(path.join(tmpdir(), "openscreen-hyperframes-remux-"));
		// Set only when explicitly producing the requested persistent QA deliverable.
		const targetDirectory =
			process.env.OPENSCREEN_HYPERFRAMES_QA_DIR ?? path.join(scratch, "project");
		try {
			const source = path.join(scratch, "screen-with-audio.webm");
			await fixtureWithAudio(source);
			const gsapSource = await readFile(path.resolve("node_modules/gsap/dist/gsap.min.js"), "utf8");
			const result = await writeHyperframesProject({
				request: {
					...request,
					screenVideoPath: source,
					webcamVideoPath: fixturePath,
					webcamOffsetSeconds: 0,
				},
				targetDirectory,
				gsapSource,
				resolveApprovedMediaPath: async (candidate) =>
					candidate === source || candidate === fixturePath ? candidate : null,
			});
			const manifest = JSON.parse(
				await readFile(path.join(result.path, "openscreen-export.json"), "utf8"),
			);
			expect(manifest.media.screen).toMatchObject({ width: 640, height: 480 });
			expect(manifest.media.audio).toHaveLength(2);
			expect(manifest.media.audio[0].src).toBe("assets/screen-audio-1.webm");
			expect(manifest.media.audio[1].src).toBe("assets/screen-audio-2.webm");
			expect(manifest.media.audio[0].offsetSeconds).toBeCloseTo(0.1, 5);
			expect(manifest.media.audio[1].offsetSeconds).toBeCloseTo(0.2, 5);
			expect(await readFile(path.join(result.path, "assets", "screen.webm"))).toEqual(
				await readFile(source),
			);
			expect(await readFile(path.join(result.path, "assets", "webcam.webm"))).toEqual(
				await readFile(fixturePath),
			);
			const document = new DOMParser().parseFromString(
				await readFile(path.join(result.path, "index.html"), "utf8"),
				"text/html",
			);
			expect(document.querySelectorAll("video")).toHaveLength(4);
			expect(document.querySelectorAll("audio")).toHaveLength(4);
			for (const audio of manifest.media.audio) {
				const input = new Input({
					formats: ALL_FORMATS,
					source: new FilePathSource(path.join(result.path, audio.src)),
				});
				try {
					const tracks = await input.getAudioTracks();
					expect(tracks).toHaveLength(1);
					expect(tracks[0].codec).toBe("opus");
					expect(await tracks[0].getFirstTimestamp()).toBeCloseTo(0, 5);
					expect(await tracks[0].computeDuration()).toBeCloseTo(audio.durationSeconds, 4);
					const packet = await new EncodedPacketSink(tracks[0]).getFirstPacket();
					expect(packet?.data).toEqual(new Uint8Array([0xf8, 0xff, 0xfe]));
					let packetCount = 0;
					for await (const _packet of new EncodedPacketSink(tracks[0]).packets()) packetCount += 1;
					expect(packetCount).toBe(90);
				} finally {
					input.dispose();
				}
			}
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}, 30000);
});
