import path from "node:path";
import { selectSupplementalAudioTrack } from "./audioTrackSelection";
import { runBoundedProcess, throwIfAborted } from "./auto-edit/processRunner";

/** Decode an approved original directly into this job's WAV, never a persistent preview sidecar. */
export async function extractNarrationWav(
	source: string,
	destination: string,
	signal: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	if (process.platform !== "darwin")
		throw new Error("Local narration extraction currently requires macOS.");
	const common = {
		cwd: path.dirname(source),
		env: process.env,
		signal,
		maxOutputBytes: 64 * 1024,
	};
	try {
		const info = await runBoundedProcess({
			...common,
			command: "/usr/bin/afinfo",
			args: [source],
			timeoutMs: 15_000,
		});
		throwIfAborted(signal);
		// Preserve the playback track policy; ordinary single-track imports use track zero.
		const track =
			info.exitCode === 0
				? (selectSupplementalAudioTrack(`${info.stdout}\n${info.stderr}`) ?? 0)
				: 0;
		const conversion = await runBoundedProcess({
			...common,
			command: "/usr/bin/afconvert",
			args: [
				"--read-track",
				String(track),
				"-f",
				"WAVE",
				"-d",
				"LEI16@16000",
				"-c",
				"1",
				source,
				destination,
			],
			timeoutMs: 180_000,
		});
		throwIfAborted(signal);
		if (conversion.exitCode !== 0)
			throw new Error(
				"No readable audio track found. Enable the microphone when recording, or import a video with speech.",
			);
	} catch (cause) {
		throwIfAborted(signal);
		if (cause instanceof Error && cause.name === "TimeoutError")
			throw new Error("Narration extraction timed out. Your recording is unchanged.");
		throw new Error(
			"Cannot prepare narration. Enable the microphone when recording, or import a video with readable speech audio.",
		);
	}
}
