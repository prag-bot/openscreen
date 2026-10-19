import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecorderHandle } from "@/hooks/recorderHandle";
import { requestCameraAccess } from "@/lib/requestCameraAccess";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { LaunchWindow } from "./LaunchWindow";

const microphones = vi.hoisted(() => ({
	devices: [] as { deviceId: string; label: string }[],
	selectedDeviceId: "default",
	setSelectedDeviceId: vi.fn(),
}));

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return {
		useScopedT: () => translate,
		useI18n: () => ({ locale: "en", systemLocaleSuggestion: null }),
	};
});
vi.mock("@/hooks/useAudioLevelMeter", () => ({ useAudioLevelMeter: () => ({ level: 0 }) }));
vi.mock("@/hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: [{ deviceId: "camera-one", label: "Camera One" }],
		selectedDeviceId: "camera-one",
		isLoading: false,
	}),
}));
vi.mock("@/hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => microphones,
}));
vi.mock("@/lib/requestCameraAccess", () => ({ requestCameraAccess: vi.fn() }));
vi.mock("@/hooks/recorderHandle", () => ({ createRecorderHandle: vi.fn() }));
vi.mock("@/native", () => ({
	nativeBridgeClient: { system: { getPlatform: () => Promise.resolve("darwin") } },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));

const getUserMedia = vi.fn();
const api = {
	getPlatform: vi.fn().mockResolvedValue("darwin"),
	getSelectedSource: vi
		.fn()
		.mockResolvedValue({ id: "screen:1:0", display_id: "1", name: "Display" }),
	setHudOverlaySize: vi.fn(),
	setHudOverlayIgnoreMouseEvents: vi.fn(),
	requestNativeMacCursorAccess: vi.fn().mockResolvedValue({ granted: true }),
	showCountdownOverlay: vi.fn().mockResolvedValue(undefined),
	setCountdownOverlayValue: vi.fn().mockResolvedValue(undefined),
	hideCountdownOverlay: vi.fn().mockResolvedValue(undefined),
	isNativeMacCaptureAvailable: vi.fn().mockResolvedValue({ success: true, available: true }),
	startNativeMacRecording: vi.fn(),
	stopNativeMacRecording: vi.fn().mockResolvedValue({ success: true, discarded: true }),
};

function cameraStream() {
	const track = { stop: vi.fn(), onended: null };
	return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
}

beforeEach(() => {
	vi.clearAllMocks();
	api.getPlatform.mockResolvedValue("darwin");
	api.requestNativeMacCursorAccess.mockReset().mockResolvedValue({ success: true, granted: true });
	microphones.devices = [];
	microphones.selectedDeviceId = "default";
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		},
	);
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
	Object.defineProperty(window, "electronAPI", { value: api, configurable: true });
	Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
	getUserMedia.mockReset().mockResolvedValue(cameraStream());
	vi.mocked(requestCameraAccess)
		.mockReset()
		.mockResolvedValue({ success: true, granted: true, status: "granted" });
	api.startNativeMacRecording.mockImplementation(async () => ({
		success: true,
		recordingId: 4123,
		screenStartedAtUnixMs: Date.now(),
	}));
	vi.mocked(createRecorderHandle).mockImplementation(
		() =>
			({
				recorder: { state: "recording", stop: vi.fn() },
				startedAtUnixMs: Date.now(),
				recordedBlobPromise: Promise.resolve(new Blob()),
			}) as unknown as ReturnType<typeof createRecorderHandle>,
	);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function expectControls(enabled: boolean) {
	expect(screen.getByTestId("launch-microphone-button").title).toBe(
		enabled ? "audio.disableMicrophone" : "audio.enableMicrophone",
	);
	expect(screen.getByTestId("launch-system-audio-button").title).toBe(
		enabled ? "audio.disableSystemAudio" : "audio.enableSystemAudio",
	);
	expect(screen.getByTestId("launch-webcam-button").title).toBe(
		enabled ? "webcam.disableWebcam" : "webcam.enableWebcam",
	);
}

describe("HUD recording preferences", () => {
	it.each([
		null,
		{},
		{ cursorCaptureMode: "wrong" },
	])("uses system cursor quietly on production HUD mount and Record (%j)", async (stored) => {
		if (stored) localStorage.setItem("openscreen_user_preferences", JSON.stringify(stored));
		render(<LaunchWindow />);
		await waitFor(() =>
			expect(screen.getByTestId("launch-cursor-mode-button").title).toBe(
				"cursor.useEditableCursor",
			),
		);
		await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
		expect(api.requestNativeMacCursorAccess).not.toHaveBeenCalled();
		vi.useFakeTimers();
		await act(async () => fireEvent.click(screen.getByTestId("launch-record-button")));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(api.requestNativeMacCursorAccess).not.toHaveBeenCalled();
		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				cursor: { mode: "system" },
				video: expect.objectContaining({ hideSystemCursor: false }),
			}),
		);
	});

	it("requests editable cursor only on explicit opt-in, deduplicates clicks, and restores successful choices quietly", async () => {
		let grant!: (value: { success: boolean; granted: boolean }) => void;
		api.requestNativeMacCursorAccess.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					grant = resolve;
				}),
		);
		const first = render(<LaunchWindow />);
		const button = await screen.findByTestId("launch-cursor-mode-button");
		expect(api.requestNativeMacCursorAccess).not.toHaveBeenCalled();
		await act(async () => {
			fireEvent.click(button);
			fireEvent.click(button);
		});
		expect(api.requestNativeMacCursorAccess).toHaveBeenCalledExactlyOnceWith({ prompt: true });
		expect(loadUserPreferences().cursorCaptureMode).toBe("system");
		await act(async () => grant({ success: true, granted: true }));
		expect(button.title).toBe("cursor.useSystemCursor");
		expect(loadUserPreferences().cursorCaptureMode).toBe("editable-overlay");
		first.unmount();
		render(<LaunchWindow />);
		const restored = await screen.findByTestId("launch-cursor-mode-button");
		expect(restored.title).toBe("cursor.useSystemCursor");
		expect(api.requestNativeMacCursorAccess).toHaveBeenCalledTimes(1);
		fireEvent.click(restored);
		expect(loadUserPreferences().cursorCaptureMode).toBe("system");
		expect(api.requestNativeMacCursorAccess).toHaveBeenCalledTimes(1);
	});

	it.each([
		"denied",
		"error",
	])("keeps the system cursor and preference after opt-in %s", async (outcome) => {
		if (outcome === "denied")
			api.requestNativeMacCursorAccess.mockResolvedValueOnce({ success: true, granted: false });
		else api.requestNativeMacCursorAccess.mockRejectedValueOnce(new Error("unavailable"));
		render(<LaunchWindow />);
		const button = await screen.findByTestId("launch-cursor-mode-button");
		await act(async () => fireEvent.click(button));
		expect(button.title).toBe("cursor.useEditableCursor");
		expect(loadUserPreferences().cursorCaptureMode).toBe("system");
		expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/system cursor/i));
	});

	it("enables supported non-macOS cursor mode without requesting macOS access", async () => {
		api.getPlatform.mockResolvedValue("win32");
		render(<LaunchWindow />);
		const button = await screen.findByTestId("launch-cursor-mode-button");
		await act(async () => fireEvent.click(button));
		expect(button.title).toBe("cursor.useSystemCursor");
		expect(loadUserPreferences().cursorCaptureMode).toBe("editable-overlay");
		expect(api.requestNativeMacCursorAccess).not.toHaveBeenCalled();
	});

	it("quietly refuses a previously opted-in editable Record when access is now denied", async () => {
		saveUserPreferences({ cursorCaptureMode: "editable-overlay", webcamEnabled: false });
		api.requestNativeMacCursorAccess.mockResolvedValueOnce({ success: true, granted: false });
		render(<LaunchWindow />);
		await waitFor(() =>
			expect(screen.getByTestId("launch-cursor-mode-button").title).toBe("cursor.useSystemCursor"),
		);
		expect(api.requestNativeMacCursorAccess).not.toHaveBeenCalled();
		await act(async () => fireEvent.click(screen.getByTestId("launch-record-button")));
		expect(api.requestNativeMacCursorAccess).toHaveBeenCalledExactlyOnceWith({ prompt: false });
		expect(api.showCountdownOverlay).not.toHaveBeenCalled();
		expect(api.startNativeMacRecording).not.toHaveBeenCalled();
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/system cursor/i));
	});

	it("arms all inputs, obtains one real camera preview, and never records on mount", async () => {
		const previewStream = cameraStream();
		getUserMedia.mockResolvedValue(previewStream);
		const { rerender } = render(
			<StrictMode>
				<LaunchWindow />
			</StrictMode>,
		);
		await waitFor(() => expectControls(true));
		await waitFor(() =>
			expect((screen.getByLabelText("Live camera preview") as HTMLVideoElement).srcObject).toBe(
				previewStream,
			),
		);
		expect(requestCameraAccess).toHaveBeenCalledTimes(1);
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(screen.getByLabelText("Live camera preview")).toBeTruthy();
		rerender(
			<StrictMode>
				<LaunchWindow />
			</StrictMode>,
		);
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(createRecorderHandle).not.toHaveBeenCalled();
		expect(api.startNativeMacRecording).not.toHaveBeenCalled();
	});

	it("restores explicit off choices when returning from the editor or relaunching the HUD", async () => {
		const first = render(<LaunchWindow />);
		await waitFor(() => expectControls(true));
		await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByTestId("launch-microphone-button"));
		fireEvent.click(screen.getByTestId("launch-system-audio-button"));
		await act(async () => fireEvent.click(screen.getByTestId("launch-webcam-button")));
		expectControls(false);
		expect(loadUserPreferences()).toMatchObject({
			microphoneEnabled: false,
			systemAudioEnabled: false,
			webcamEnabled: false,
		});
		first.unmount();
		render(<LaunchWindow />);
		expectControls(false);
		expect(requestCameraAccess).toHaveBeenCalledTimes(1);
		expect(getUserMedia).toHaveBeenCalledTimes(1);
	});

	it("does not persist a transient camera permission failure as a user off choice", async () => {
		vi.mocked(requestCameraAccess).mockResolvedValueOnce({
			success: true,
			granted: false,
			status: "denied",
		});
		const first = render(<LaunchWindow />);
		await act(async () => {
			/* Flush the denied startup permission check. */
		});
		expect(screen.getByTestId("launch-webcam-button").title).toBe("webcam.enableWebcam");
		expect(loadUserPreferences().webcamEnabled).toBe(true);
		first.unmount();
		render(<LaunchWindow />);
		await waitFor(() => expectControls(true));
		await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
	});

	it.each([
		true,
		false,
	])("sends actual persisted capture flags (%s) only after Record", async (enabled) => {
		saveUserPreferences({
			microphoneEnabled: enabled,
			systemAudioEnabled: enabled,
			webcamEnabled: enabled,
		});
		render(<LaunchWindow />);
		await waitFor(() => expectControls(enabled));
		if (enabled) await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
		vi.useFakeTimers();
		await act(async () => fireEvent.click(screen.getByTestId("launch-record-button")));
		expect(api.startNativeMacRecording).not.toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: { system: { enabled }, microphone: expect.objectContaining({ enabled }) },
				webcam: expect.objectContaining({ enabled }),
			}),
		);
		expect(createRecorderHandle).toHaveBeenCalledTimes(enabled ? 1 : 0);
	});

	it("forwards the default sentinel after selecting a physical then decorated default microphone", async () => {
		const defaultLabel = "Default - MacBook Pro Microphone (Built-in)";
		microphones.devices = [
			{ deviceId: "default", label: defaultLabel },
			{ deviceId: "opaque-physical-id", label: "MacBook Pro Microphone (Built-in)" },
		];
		render(<LaunchWindow />);
		await waitFor(() => expectControls(true));
		await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
		const selector = screen.getByRole("option", { name: defaultLabel })
			.parentElement as HTMLSelectElement;
		fireEvent.change(selector, { target: { value: "opaque-physical-id" } });
		expect(selector.value).toBe("opaque-physical-id");
		fireEvent.change(selector, { target: { value: "default" } });
		expect(selector.value).toBe("default");
		expect(microphones.setSelectedDeviceId.mock.calls).toEqual([
			["opaque-physical-id"],
			["default"],
		]);

		vi.useFakeTimers();
		await act(async () => fireEvent.click(screen.getByTestId("launch-record-button")));
		expect(api.startNativeMacRecording).not.toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: expect.objectContaining({
					microphone: expect.objectContaining({
						enabled: true,
						deviceId: "default",
						deviceName: defaultLabel,
					}),
				}),
			}),
		);
	});
});
