import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEBCAM_PREVIEW_SIZE, WebcamPreview } from "./WebcamPreview";

afterEach(cleanup);

function cameraStream() {
	const stop = vi.fn();
	const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
	return { stream, stop };
}

describe("WebcamPreview", () => {
	it.each([90, 160, 240])("keeps a %s-pixel preview square and explicitly circular", (size) => {
		render(<WebcamPreview stream={null} recording={false} paused={false} size={size} />);
		const frame = screen.getByLabelText("Live camera preview").parentElement!;
		expect(frame.style.width).toBe(`${size}px`);
		expect(frame.style.height).toBe(`${size}px`);
		expect(frame.style.aspectRatio).toBe("1 / 1");
		expect(frame.style.borderRadius).toBe("50%");
		expect(frame.classList.contains("shrink-0")).toBe(true);
		expect(frame.classList.contains("overflow-hidden")).toBe(true);
	});

	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("uses a square default instead of intrinsic video geometry for invalid size %s", (size) => {
		render(<WebcamPreview stream={null} recording={false} paused={false} size={size} />);
		const frame = screen.getByLabelText("Live camera preview").parentElement!;
		expect(frame.style.width).toBe(`${DEFAULT_WEBCAM_PREVIEW_SIZE}px`);
		expect(frame.style.height).toBe(`${DEFAULT_WEBCAM_PREVIEW_SIZE}px`);
	});

	it("attaches the recorder's stream to a muted, inline, mirrored preview", () => {
		const { stream } = cameraStream();
		render(<WebcamPreview stream={stream} recording={false} paused={false} />);
		const video = screen.getByLabelText("Live camera preview") as HTMLVideoElement;
		expect(video.srcObject).toBe(stream);
		expect(video.muted).toBe(true);
		expect(video.autoplay).toBe(true);
		expect(video.playsInline).toBe(true);
		expect(video.style.transform).toBe("scaleX(-1)");
	});

	it("keeps the same stream attached while recording and pausing", () => {
		const { stream, stop } = cameraStream();
		const { rerender } = render(<WebcamPreview stream={stream} recording={false} paused={false} />);
		rerender(<WebcamPreview stream={stream} recording paused={false} />);
		expect(screen.getByText("Recording")).toBeTruthy();
		rerender(<WebcamPreview stream={stream} recording paused />);
		expect(screen.getByText("Paused")).toBeTruthy();
		expect((screen.getByLabelText("Live camera preview") as HTMLVideoElement).srcObject).toBe(
			stream,
		);
		expect(stop).not.toHaveBeenCalled();
	});

	it("lets the user unmirror only the preview", () => {
		const { stream } = cameraStream();
		render(<WebcamPreview stream={stream} recording={false} paused={false} />);
		fireEvent.click(screen.getByRole("button", { name: "Unmirror preview" }));
		expect((screen.getByLabelText("Live camera preview") as HTMLVideoElement).style.transform).toBe(
			"none",
		);
	});

	it("shows connecting status before the camera stream arrives", () => {
		render(<WebcamPreview stream={null} recording={false} paused={false} />);
		expect(screen.getByRole("status").textContent).toBe("Connecting camera…");
	});

	it("detaches old streams without stopping the recorder's tracks", () => {
		const first = cameraStream();
		const second = cameraStream();
		const { rerender, unmount } = render(
			<WebcamPreview stream={first.stream} recording={false} paused={false} />,
		);
		const video = screen.getByLabelText("Live camera preview") as HTMLVideoElement;
		rerender(<WebcamPreview stream={second.stream} recording={false} paused={false} />);
		expect(video.srcObject).toBe(second.stream);
		unmount();
		expect(video.srcObject).toBeNull();
		expect(first.stop).not.toHaveBeenCalled();
		expect(second.stop).not.toHaveBeenCalled();
	});
});
