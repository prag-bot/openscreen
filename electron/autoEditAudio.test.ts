import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAfinfoAudioTrackBitrates, selectSupplementalAudioTrack } from "./audioTrackSelection";

const state = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./auto-edit/processRunner", async (importOriginal) => ({
	...(await importOriginal<typeof import("./auto-edit/processRunner")>()),
	runBoundedProcess: state.run,
}));

import { extractNarrationWav } from "./autoEditAudio";

// Shape captured from native afinfo output, including the closing separator.
const singleTrack = `File:           original.aiff
File type ID:   AIFC
Num Tracks:     1
----
Data format:     1 ch,  22050 Hz, lpcm (0x0000000E) 16-bit big-endian signed integer
                no channel layout.
estimated duration: 10.462540 sec
audio bytes: 461398
audio packets: 230699
bit rate: 352800 bits per second
packet size upper bound: 2
maximum packet size: 2
audio data file offset: 4096
optimized
source bit depth: I16
----
`;
const dualTrack = `File:           original.mp4
File type ID:   mp4f
Num Tracks:     2
----
Data format:     1 ch,  48000 Hz, aac
bit rate: 0 bits per second
----
Data format:     1 ch,  48000 Hz, aac
bit rate: 96000 bits per second
----
`;
const multiTrack = `File:           original.mp4
File type ID:   mp4f
Num Tracks:     3
----
Data format:     2 ch,  48000 Hz, aac
bit rate: 192000 bits per second
----
Data format:     1 ch,  48000 Hz, aac
bit rate: 48000 bits per second
----
Data format:     1 ch,  48000 Hz, aac
bit rate: 96000 bits per second
----
`;

describe("shared native narration-track selection", () => {
	it("chooses the best supplemental track, not the higher-bitrate main track", () => {
		expect(parseAfinfoAudioTrackBitrates(multiTrack)).toEqual([192000, 48000, 96000]);
		expect(selectSupplementalAudioTrack(multiTrack)).toBe(2);
	});
	it("ignores afinfo's trailing separator for a real single-track file", () => {
		expect(parseAfinfoAudioTrackBitrates(singleTrack)).toEqual([352800]);
		expect(selectSupplementalAudioTrack(singleTrack)).toBeNull();
	});
	it("preserves a real zero-bitrate main track and selects supplemental track one", () => {
		expect(parseAfinfoAudioTrackBitrates(dualTrack)).toEqual([0, 96000]);
		expect(selectSupplementalAudioTrack(dualTrack)).toBe(1);
	});
	it("keeps track order with missing bitrate metadata and supports single-track imports", () => {
		expect(
			selectSupplementalAudioTrack(
				"File: original\r\n----\r\nData format: 1 ch, 48000 Hz, aac\r\nbit rate: 192000 bits per second\r\n----\r\nData format: 1 ch, 48000 Hz, aac\r\nunknown\r\n----\r\n",
			),
		).toBe(1);
		expect(parseAfinfoAudioTrackBitrates("File: original\n----\nfooter only\n----\n")).toEqual([]);
		expect(selectSupplementalAudioTrack("")).toBeNull();
	});
});

describe("job-owned narration extraction", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
		state.run.mockResolvedValue({ stdout: multiTrack, stderr: "", exitCode: 0 });
	});
	afterEach(() => {
		Object.defineProperty(process, "platform", originalPlatform);
	});
	it("probes and directly converts the approved original with one bounded signal", async () => {
		const controller = new AbortController();
		await extractNarrationWav("/approved/original.mp4", "/job/narration.wav", controller.signal);
		expect(state.run).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				command: "/usr/bin/afinfo",
				args: ["/approved/original.mp4"],
				signal: controller.signal,
				timeoutMs: 15_000,
				maxOutputBytes: 64 * 1024,
			}),
		);
		expect(state.run).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				command: "/usr/bin/afconvert",
				args: [
					"--read-track",
					"2",
					"-f",
					"WAVE",
					"-d",
					"LEI16@16000",
					"-c",
					"1",
					"/approved/original.mp4",
					"/job/narration.wav",
				],
				signal: controller.signal,
				timeoutMs: 180_000,
				maxOutputBytes: 64 * 1024,
			}),
		);
	});
	it("uses track zero for an ordinary single-track import", async () => {
		state.run.mockResolvedValue({
			stdout: singleTrack,
			stderr: "",
			exitCode: 0,
		});
		await extractNarrationWav(
			"/approved/original.mov",
			"/job/narration.wav",
			new AbortController().signal,
		);
		expect(state.run.mock.calls[1][0].args.slice(0, 2)).toEqual(["--read-track", "0"]);
	});
	it("extracts a real-shaped two-track original's supplemental track one", async () => {
		state.run.mockResolvedValue({ stdout: dualTrack, stderr: "", exitCode: 0 });
		await extractNarrationWav(
			"/approved/original.mp4",
			"/job/narration.wav",
			new AbortController().signal,
		);
		expect(state.run.mock.calls[1][0].args.slice(0, 2)).toEqual(["--read-track", "1"]);
	});
	it("never starts native work for an already canceled request", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			extractNarrationWav("/original.mp4", "/job/narration.wav", controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(state.run).not.toHaveBeenCalled();
	});
	it.each([
		"afinfo",
		"afconvert",
	])("reports a bounded %s timeout without native stderr", async (stage) => {
		state.run.mockImplementation(async (request) => {
			if (request.command.endsWith(stage)) {
				const error = new Error("sensitive native stderr");
				error.name = "TimeoutError";
				throw error;
			}
			return { stdout: multiTrack, stderr: "", exitCode: 0 };
		});
		await expect(
			extractNarrationWav("/original.mp4", "/job/narration.wav", new AbortController().signal),
		).rejects.toThrow("Narration extraction timed out. Your recording is unchanged.");
		expect(state.run).toHaveBeenCalledTimes(stage === "afinfo" ? 1 : 2);
	});
});
