import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecorderHandle } from "./recorderHandle";
import { useScreenRecorder } from "./useScreenRecorder";

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return { useScopedT: () => translate };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("./recorderHandle", () => ({ createRecorderHandle: vi.fn() }));

const getUserMedia = vi.fn();
const api = {
	getPlatform: vi.fn().mockResolvedValue("linux"),
	getSelectedSource: vi.fn().mockResolvedValue({ id: "screen:1:0", name: "Display" }),
	showCountdownOverlay: vi.fn().mockResolvedValue(undefined),
	setCountdownOverlayValue: vi.fn().mockResolvedValue(undefined),
	hideCountdownOverlay: vi.fn().mockResolvedValue(undefined),
	setRecordingState: vi.fn(),
	storeRecordedSession: vi.fn(),
	switchToEditor: vi.fn(),
};

class FakeMediaStream {
	constructor(private tracks: MediaStreamTrack[] = []) {}
	getTracks() {
		return this.tracks;
	}
	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === "video");
	}
	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === "audio");
	}
	addTrack(track: MediaStreamTrack) {
		this.tracks.push(track);
	}
}

function screenStream() {
	const track = {
		kind: "video",
		stop: vi.fn(),
		applyConstraints: vi.fn().mockResolvedValue(undefined),
		getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
	} as unknown as MediaStreamTrack;
	return { track, stream: new FakeMediaStream([track]) };
}

beforeEach(() => {
	vi.clearAllMocks();
	getUserMedia.mockReset();
	vi.useFakeTimers();
	vi.stubGlobal("MediaStream", FakeMediaStream);
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
	Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
	Object.defineProperty(window, "electronAPI", { value: api, configurable: true });
	vi.mocked(createRecorderHandle).mockReturnValue({
		recorder: { state: "recording", stop: vi.fn(), addEventListener: vi.fn() },
	} as unknown as ReturnType<typeof createRecorderHandle>);
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

describe("requested microphone capture", () => {
	it.each([
		"permission denial",
		"missing audio track",
	])("aborts on %s without recording or saving silent footage", async (failure) => {
		const screen = screenStream();
		getUserMedia.mockResolvedValueOnce(screen.stream);
		const emptyMic = new FakeMediaStream();
		if (failure === "permission denial") {
			getUserMedia.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
		} else {
			getUserMedia.mockResolvedValueOnce(emptyMic);
		}
		const { result } = renderHook(() => useScreenRecorder({ microphoneEnabled: true }));
		await recordAfterCountdown(() => result.current.toggleRecording());
		expect(result.current.recording).toBe(false);
		expect(result.current.microphoneEnabled).toBe(true);
		expect(createRecorderHandle).not.toHaveBeenCalled();
		expect(api.storeRecordedSession).not.toHaveBeenCalled();
		expect(api.switchToEditor).not.toHaveBeenCalled();
		expect(screen.track.stop).toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith("recording.microphoneRequired");
	});

	it("permits an explicitly muted video-only recording without requesting microphone access", async () => {
		const screen = screenStream();
		getUserMedia.mockResolvedValueOnce(screen.stream);
		const { result } = renderHook(() => useScreenRecorder({ microphoneEnabled: false }));
		expect(getUserMedia).not.toHaveBeenCalled();
		await recordAfterCountdown(() => result.current.toggleRecording());
		expect(result.current.recording).toBe(true);
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
		expect(createRecorderHandle).toHaveBeenCalledTimes(1);
		expect(toast.error).not.toHaveBeenCalled();
	});
});
