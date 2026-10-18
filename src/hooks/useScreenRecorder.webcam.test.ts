import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestCameraAccess } from "@/lib/requestCameraAccess";
import { useScreenRecorder } from "./useScreenRecorder";

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return { useScopedT: () => translate };
});
vi.mock("@/lib/requestCameraAccess", () => ({ requestCameraAccess: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const getUserMedia = vi.fn();

function cameraStream() {
	const track = { stop: vi.fn(), onended: null as (() => void) | null };
	const stream = {
		getTracks: () => [track],
		getVideoTracks: () => [track],
	} as unknown as MediaStream;
	return { track, stream };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requestCameraAccess).mockResolvedValue({
		success: true,
		granted: true,
		status: "granted",
	});
	Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
	Object.defineProperty(window, "electronAPI", {
		value: { hideCountdownOverlay: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
});
afterEach(cleanup);

describe("recorder webcam preview stream", () => {
	it("exposes the existing camera stream and releases it on disable", async () => {
		const { stream, track } = cameraStream();
		getUserMedia.mockResolvedValue(stream);
		const { result } = renderHook(() => useScreenRecorder());
		expect(result.current.webcamPreviewStream).toBeNull();
		await act(async () => {
			await result.current.setWebcamEnabled(true);
		});
		await waitFor(() => expect(result.current.webcamPreviewStream).toBe(stream));
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		await act(async () => {
			await result.current.setWebcamEnabled(false);
		});
		expect(result.current.webcamPreviewStream).toBeNull();
		expect(track.stop).toHaveBeenCalledTimes(1);
	});

	it("clears the preview when the camera disconnects", async () => {
		const { stream, track } = cameraStream();
		getUserMedia.mockResolvedValue(stream);
		const { result } = renderHook(() => useScreenRecorder());
		await act(async () => {
			await result.current.setWebcamEnabled(true);
		});
		await waitFor(() => expect(result.current.webcamPreviewStream).toBe(stream));
		act(() => track.onended?.());
		expect(result.current.webcamPreviewStream).toBeNull();
		expect(result.current.webcamEnabled).toBe(false);
	});

	it("does not expose or retain a late stream after camera is disabled", async () => {
		const { stream, track } = cameraStream();
		let resolveStream: (stream: MediaStream) => void = vi.fn();
		getUserMedia.mockImplementationOnce(
			() =>
				new Promise<MediaStream>((resolve) => {
					resolveStream = resolve;
				}),
		);
		const { result } = renderHook(() => useScreenRecorder());
		await act(async () => {
			await result.current.setWebcamEnabled(true);
		});
		await act(async () => {
			await result.current.setWebcamEnabled(false);
		});
		await act(async () => resolveStream(stream));
		expect(result.current.webcamPreviewStream).toBeNull();
		expect(track.stop).toHaveBeenCalledTimes(1);
	});
});
