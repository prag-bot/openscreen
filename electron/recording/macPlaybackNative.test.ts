// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Only synthetic local media. Compiles/runs the real helper without starting capture,
// enumerating devices, requesting privacy permissions, or touching installed apps.
describe.runIf(process.platform === "darwin")("native offline playback audio", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "openscreen-native-playback-"));
	const helper = path.join(directory, "capture-helper");
	const root = path.resolve(
		import.meta.dirname,
		"..",
		"native",
		"screencapturekit",
		"Sources",
		"OpenScreenScreenCaptureKitHelper",
	);
	function run(command: string, args: string[], success = true) {
		const result = spawnSync(command, args, { encoding: "utf8", timeout: 55_000 });
		if (success) expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		return result;
	}
	beforeAll(() => {
		const sdk =
			process.env.OPENSCREEN_SWIFT_TEST_SDK ??
			run("xcrun", ["--sdk", "macosx", "--show-sdk-path"]).stdout.trim();
		run("xcrun", [
			"swiftc",
			"-parse-as-library",
			"-sdk",
			sdk,
			"-module-cache-path",
			path.join(directory, "module-cache"),
			path.join(root, "main.swift"),
			path.join(root, "OfflinePlaybackPreparation.swift"),
			"-o",
			helper,
		]);
	}, 60_000);
	function fixture(name: string, audio: string[], offsets: string[] = []) {
		const source = path.join(directory, `${name}.mp4`);
		const args = ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=2"];
		audio.forEach((input, index) =>
			args.push(
				...(offsets[index] ? ["-itsoffset", offsets[index]] : []),
				"-f",
				"lavfi",
				"-i",
				input,
			),
		);
		args.push(
			"-map",
			"0:v",
			...audio.flatMap((_, i) => ["-map", `${i + 1}:a`]),
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-t",
			"2",
			source,
		);
		run("ffmpeg", args);
		return source;
	}
	function prepare(source: string) {
		const target = source.replace(/\.mp4$/, "-playback.mp4");
		const original = readFileSync(source);
		const result = run(helper, ["--prepare-playback", source, target]);
		expect(result.stdout).toContain('"event":"playback-ready"');
		expect(readFileSync(source)).toEqual(original);
		const videoHash = (file: string) =>
			run("ffmpeg", [
				"-v",
				"error",
				"-i",
				file,
				"-map",
				"0:v",
				"-c:v",
				"copy",
				"-f",
				"hash",
				"-hash",
				"sha256",
				"-",
			]).stdout;
		expect(videoHash(target)).toBe(videoHash(source));
		const probe = JSON.parse(
			run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", target])
				.stdout,
		);
		return { target, probe };
	}
	function volume(target: string, start = "0", duration = "2") {
		const result = run("ffmpeg", [
			"-hide_banner",
			"-ss",
			start,
			"-t",
			duration,
			"-i",
			target,
			"-vn",
			"-af",
			"volumedetect",
			"-f",
			"null",
			"-",
		]);
		return Number(result.stderr.match(/mean_volume: ([-\d.]+) dB/)?.[1] ?? "-Infinity");
	}
	it("mixes silent system + audible microphone into the only audio track", () => {
		const { target, probe } = prepare(
			fixture("silent-system", [
				"anullsrc=r=48000:cl=stereo:d=2",
				"sine=frequency=880:sample_rate=48000:duration=2",
			]),
		);
		expect(
			probe.streams.filter((s: { codec_type: string }) => s.codec_type === "audio"),
		).toHaveLength(1);
		expect(volume(target)).toBeGreaterThan(-30);
		expect(probe.streams[0].codec_name).toBe("h264");
	});
	it("preserves both audible tracks in one mix", () => {
		const { target } = prepare(
			fixture("both-audible", [
				"sine=frequency=440:sample_rate=48000:duration=2",
				"sine=frequency=880:sample_rate=48000:duration=2",
			]),
		);
		for (const frequency of [440, 880]) {
			const filtered = run("ffmpeg", [
				"-hide_banner",
				"-i",
				target,
				"-vn",
				"-af",
				`bandpass=f=${frequency}:width_type=h:width=20,volumedetect`,
				"-f",
				"null",
				"-",
			]);
			expect(Number(filtered.stderr.match(/mean_volume: ([-\d.]+) dB/)?.[1])).toBeGreaterThan(-30);
		}
	});
	it("keeps a delayed microphone on the original video clock", () => {
		const { target } = prepare(
			fixture(
				"delayed-mic",
				["anullsrc=r=48000:cl=stereo:d=2", "sine=frequency=880:sample_rate=48000:duration=1"],
				["0", "0.75"],
			),
		);
		expect(volume(target, "0", "0.5")).toBeLessThan(-70);
		expect(volume(target, "1", "0.5")).toBeGreaterThan(-30);
	});
	it.each([0, 1])("handles %s audio tracks without inventing silence", (count) => {
		const { target, probe } = prepare(
			fixture(`audio-${count}`, count ? ["sine=frequency=440:sample_rate=48000:duration=2"] : []),
		);
		expect(
			probe.streams.filter((s: { codec_type: string }) => s.codec_type === "audio"),
		).toHaveLength(count);
		if (count) expect(volume(target)).toBeGreaterThan(-30);
	});
	it("validates on reload, refuses overwrite, and fails without publishing on invalid input", () => {
		const source = fixture("exclusive", ["sine=frequency=440:sample_rate=48000:duration=2"]);
		const { target } = prepare(source);
		run(helper, ["--validate-playback", source, target]);
		const bytes = readFileSync(target);
		expect(run(helper, ["--prepare-playback", source, target], false).status).not.toBe(0);
		expect(readFileSync(target)).toEqual(bytes);
		expect(
			run(
				helper,
				[
					"--prepare-playback",
					path.join(directory, "missing.mp4"),
					path.join(directory, "failed.mp4"),
				],
				false,
			).status,
		).not.toBe(0);
	});
});
