import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrophoneDevices } from "./useMicrophoneDevices";

const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();

beforeEach(() => {
	getUserMedia.mockReset();
	enumerateDevices.mockReset();
	Object.defineProperty(navigator, "mediaDevices", {
		value: {
			getUserMedia,
			enumerateDevices,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		},
		configurable: true,
	});
});
afterEach(cleanup);

function permissionStream() {
	const stop = vi.fn();
	return { stop, stream: { getTracks: () => [{ stop }] } as unknown as MediaStream };
}

describe("microphone device permission streams", () => {
	it("releases the permission stream when device enumeration fails", async () => {
		const { stream, stop } = permissionStream();
		getUserMedia.mockResolvedValueOnce(stream);
		enumerateDevices.mockRejectedValueOnce(new Error("Device enumeration failed"));
		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.error).toBe("Device enumeration failed"));
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("releases the permission stream immediately on unmount while enumeration is pending", async () => {
		const { stream, stop } = permissionStream();
		getUserMedia.mockResolvedValueOnce(stream);
		let finishEnumeration: (devices: MediaDeviceInfo[]) => void = vi.fn();
		enumerateDevices.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishEnumeration = resolve;
				}),
		);
		const { unmount } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(enumerateDevices).toHaveBeenCalledTimes(1));
		unmount();
		expect(stop).toHaveBeenCalledTimes(1);
		await act(async () => finishEnumeration([]));
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("stops late permission streams after unmount without enumerating devices", async () => {
		const { stream, stop } = permissionStream();
		let grantPermission: (stream: MediaStream) => void = vi.fn();
		getUserMedia.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					grantPermission = resolve;
				}),
		);
		const { unmount } = renderHook(() => useMicrophoneDevices(true));
		unmount();
		await act(async () => grantPermission(stream));
		expect(stop).toHaveBeenCalledTimes(1);
		expect(enumerateDevices).not.toHaveBeenCalled();
	});
});
