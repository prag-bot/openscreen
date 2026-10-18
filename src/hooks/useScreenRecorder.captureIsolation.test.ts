import { fixWebmDuration } from "@fix-webm-duration/fix";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestCameraAccess } from "@/lib/requestCameraAccess";
import { createRecorderHandle } from "./recorderHandle";
import { useScreenRecorder } from "./useScreenRecorder";

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return { useScopedT: () => translate };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/requestCameraAccess", () => ({ requestCameraAccess: vi.fn() }));
vi.mock("./recorderHandle", () => ({ createRecorderHandle: vi.fn() }));
vi.mock("@fix-webm-duration/fix", () => ({ fixWebmDuration: vi.fn(async (blob) => blob) }));

const getUserMedia = vi.fn();
const getDisplayMedia = vi.fn();
const api = {
	getPlatform: vi.fn().mockResolvedValue("darwin"),
	getSelectedSource: vi
		.fn()
		.mockResolvedValue({ id: "screen:1:0", display_id: "1", name: "Display" }),
	requestNativeMacCursorAccess: vi.fn().mockResolvedValue({ granted: true }),
	showCountdownOverlay: vi.fn().mockResolvedValue(undefined),
	setCountdownOverlayValue: vi.fn().mockResolvedValue(undefined),
	hideCountdownOverlay: vi.fn().mockResolvedValue(undefined),
	isNativeMacCaptureAvailable: vi.fn(),
	startNativeMacRecording: vi.fn().mockResolvedValue({ success: true, recordingId: 4123 }),
	stopNativeMacRecording: vi.fn().mockResolvedValue({ success: true, discarded: true }),
	attachNativeMacWebcamRecording: vi.fn(),
	setCurrentRecordingSession: vi.fn().mockResolvedValue({ success: true }),
	switchToEditor: vi.fn().mockResolvedValue({ success: true }),
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(20_000);
	api.startNativeMacRecording.mockImplementation(async () => ({
		success: true,
		recordingId: 4123,
		screenStartedAtUnixMs: Date.now(),
	}));
	api.stopNativeMacRecording.mockResolvedValue({ success: true, discarded: true });
	vi.mocked(requestCameraAccess).mockResolvedValue({
		success: true,
		granted: true,
		status: "granted",
	});
	api.isNativeMacCaptureAvailable.mockResolvedValue({ success: true, available: true });
	Object.defineProperty(navigator, "mediaDevices", {
		value: { getUserMedia, getDisplayMedia },
		configurable: true,
	});
	Object.defineProperty(window, "electronAPI", { value: api, configurable: true });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function recordAfterCountdown(toggle: () => void) {
	await act(async () => toggle());
	await act(async () => {
		await vi.advanceTimersByTimeAsync(3000);
	});
}

describe("macOS capture isolation routing", () => {
	it("records exactly one editable camera sidecar while keeping its live preview attached", async () => {
		const cameraTrack = { stop: vi.fn(), onended: null };
		const cameraStream = {
			getTracks: () => [cameraTrack],
			getVideoTracks: () => [cameraTrack],
		} as unknown as MediaStream;
		getUserMedia.mockResolvedValue(cameraStream);
		const recorder = { state: "recording", stop: vi.fn() };
		vi.mocked(createRecorderHandle).mockImplementation(
			() =>
				({
					recorder,
					startedAtUnixMs: Date.now(),
					recordedBlobPromise: Promise.resolve(new Blob()),
				}) as unknown as ReturnType<typeof createRecorderHandle>,
		);
		vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
		const { result } = renderHook(() => useScreenRecorder());
		await act(async () => {
			await result.current.setWebcamEnabled(true);
		});
		expect(result.current.webcamPreviewStream).toBe(cameraStream);
		await recordAfterCountdown(() => result.current.toggleRecording());
		expect(createRecorderHandle).toHaveBeenCalledTimes(1);
		expect(createRecorderHandle).toHaveBeenCalledWith(cameraStream, expect.any(Object));
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false });
		expect(getDisplayMedia).not.toHaveBeenCalled();
		expect(api.startNativeMacRecording).toHaveBeenCalledTimes(1);
		expect(result.current.webcamPreviewStream).toBe(cameraStream);
		expect(cameraTrack.stop).not.toHaveBeenCalled();
	});

	it("persists measured camera lead-in and retains its whole duration, excluding IPC ack delay", async () => {
		const track = { stop: vi.fn(), onended: null };
		getUserMedia.mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] });
		const recorder = {
			state: "recording",
			stop: vi.fn(() => {
				recorder.state = "inactive";
			}),
		};
		vi.mocked(createRecorderHandle).mockImplementation(
			() =>
				({
					recorder,
					startedAtUnixMs: Date.now(),
					recordedBlobPromise: Promise.resolve(new Blob(["camera-original"])),
				}) as unknown as ReturnType<typeof createRecorderHandle>,
		);
		vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
		api.startNativeMacRecording.mockImplementationOnce(async () => {
			const screenStartedAtUnixMs = Date.now() + 1250;
			vi.setSystemTime(Date.now() + 1750); // ack delivered 500ms after the actual screen zero
			return { success: true, recordingId: 4123, screenStartedAtUnixMs };
		});
		const { result } = renderHook(() => useScreenRecorder());
		await act(async () => {
			await result.current.setWebcamEnabled(true);
		});
		await recordAfterCountdown(() => result.current.toggleRecording());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		api.stopNativeMacRecording.mockResolvedValueOnce({
			success: true,
			path: "/recording.mp4",
		} as never);
		api.attachNativeMacWebcamRecording.mockResolvedValueOnce({
			success: true,
			session: {
				screenVideoPath: "/recording.mp4",
				webcamVideoPath: "/camera.webm",
				webcamOffsetSeconds: -1.25,
				createdAt: 4123,
			},
		});
		await act(async () => result.current.toggleRecording());
		expect(api.attachNativeMacWebcamRecording).toHaveBeenCalledWith(
			expect.objectContaining({ webcamOffsetSeconds: -1.25 }),
		);
		expect(fixWebmDuration).toHaveBeenLastCalledWith(expect.any(Blob), 3750);
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(
			expect.objectContaining({ webcamOffsetSeconds: -1.25 }),
		);
	});

	it.each([
		"editable-overlay",
		"system",
	] as const)("uses native app-excluding capture for %s cursor mode", async (mode) => {
		const { result } = renderHook(() => useScreenRecorder());
		act(() => result.current.setCursorCaptureMode(mode));
		await recordAfterCountdown(() => result.current.toggleRecording());
		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				cursor: { mode },
				video: expect.objectContaining({ hideSystemCursor: mode === "editable-overlay" }),
			}),
		);
		expect(result.current.recording).toBe(true);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(getDisplayMedia).not.toHaveBeenCalled();
	});

	it.each([
		"missing-helper",
		"unsupported-platform",
	])("fails closed on macOS when native isolation is unavailable (%s)", async (reason) => {
		api.isNativeMacCaptureAvailable.mockResolvedValue({ success: true, available: false, reason });
		getUserMedia.mockRejectedValue(new Error("Unisolated browser capture was attempted"));
		const { result } = renderHook(() => useScreenRecorder());
		act(() => result.current.setCursorCaptureMode("system"));
		await recordAfterCountdown(() => result.current.toggleRecording());
		expect(result.current.recording).toBe(false);
		expect(api.startNativeMacRecording).not.toHaveBeenCalled();
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(getDisplayMedia).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalled();
	});
});
