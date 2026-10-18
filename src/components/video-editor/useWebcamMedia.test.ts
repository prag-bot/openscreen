import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWebcamMedia } from "./useWebcamMedia";

describe("editor camera media state", () => {
	it("resets clock atomically for legacy/screen-only media, even when camera paths are reused", () => {
		const { result } = renderHook(() => useWebcamMedia());
		act(() => result.current.setWebcamMedia("/camera.webm", -1.25));
		expect(result.current.webcamOffsetSeconds).toBe(-1.25);
		act(() => result.current.setWebcamMedia("/camera.webm")); // another same-duration legacy project
		expect(result.current.webcamOffsetSeconds).toBe(0);
		act(() => result.current.setWebcamMedia("/camera.webm", 2));
		expect(result.current.webcamOffsetSeconds).toBe(2);
		act(() => result.current.setWebcamMedia(null)); // new project, raw import or screen-only session
		expect(result.current.webcamOffsetSeconds).toBe(0);
		expect(result.current.webcamVideoSourcePath).toBeNull();
		expect(result.current.webcamVideoPath).toBeNull();
	});
});
