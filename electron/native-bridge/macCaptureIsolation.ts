import type {
	NativeMacHelperRecordingRequest,
	NativeMacRecordingRequest,
} from "../../src/lib/nativeMacRecording";

/** Bind capture exclusion to Electron's browser process, which owns the HUD's
 * native windows. Renderer process IDs and the separately spawned helper PID do
 * not identify those windows. App-level exclusion also covers future HUD windows.
 */
export function withRecorderCaptureExclusion(
	request: NativeMacRecordingRequest,
	recorderProcessId: number,
): NativeMacHelperRecordingRequest {
	if (
		!Number.isInteger(recorderProcessId) ||
		recorderProcessId <= 0 ||
		recorderProcessId >= 2 ** 31
	) {
		throw new Error("A valid recorder process id is required for isolated macOS capture.");
	}
	return { ...request, captureExclusion: { processId: recorderProcessId } };
}

/** Older helper binaries ignore unknown request fields. Require their explicit
 * acknowledgement so an outdated helper cannot silently bake the HUD into video.
 */
export function assertNativeMacCaptureIsolation(
	event: Record<string, unknown>,
	recorderProcessId: number,
): void {
	if (event.excludedRecorderProcessId !== recorderProcessId) {
		throw new Error(
			"Native macOS capture helper did not confirm recorder-window exclusion. Rebuild or update the capture helper.",
		);
	}
}
