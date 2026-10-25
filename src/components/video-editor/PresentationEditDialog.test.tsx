import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresentationRegion } from "@/lib/presentation";
import { PresentationEditDialog, type PresentationEditDialogProps } from "./PresentationEditDialog";

afterEach(cleanup);

const face: PresentationRegion = {
	id: "face-1",
	startMs: 0,
	endMs: 10000,
	mode: "face-only",
	reason: "Voice activity with no screen action; review this candidate.",
};

function props(overrides: Partial<PresentationEditDialogProps> = {}): PresentationEditDialogProps {
	return {
		open: true,
		onOpenChange: vi.fn(),
		durationSeconds: 20,
		screenVideoPath: "file:///screen.mp4",
		webcamVideoPath: "file:///camera.webm",
		regions: [],
		onSuggest: vi.fn().mockResolvedValue([face]),
		onApply: vi.fn(),
		...overrides,
	};
}

describe("presentation switch review", () => {
	it("keeps generated switches local until explicit approval", async () => {
		const input = props();
		render(<PresentationEditDialog {...input} />);
		fireEvent.click(screen.getByRole("button", { name: "Suggest switches" }));
		await screen.findByLabelText("Switch 1 view");
		expect(input.onSuggest).toHaveBeenCalledOnce();
		expect(input.onApply).not.toHaveBeenCalled();
		expect(screen.getByText(/Nothing changes until/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Apply switches" }));
		expect(input.onApply).toHaveBeenCalledWith([face]);
		expect(input.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("lets a reviewer build and split a demo section without automatic analysis", () => {
		const input = props();
		render(<PresentationEditDialog {...input} />);
		fireEvent.click(screen.getByRole("button", { name: "Add a demo section" }));
		fireEvent.click(screen.getByRole("button", { name: "Split 1" }));
		fireEvent.change(screen.getByLabelText("Switch 1 view"), { target: { value: "face-only" } });
		expect(input.onSuggest).not.toHaveBeenCalled();
		expect(input.onApply).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Apply switches" }));
		const applied = vi.mocked(input.onApply).mock.calls[0][0];
		expect(applied).toEqual([
			expect.objectContaining({ startMs: 0, endMs: 10000, mode: "face-only" }),
			expect.objectContaining({ startMs: 10000, endMs: 20000, mode: "demo" }),
		]);
		expect(applied[0].id).not.toBe(applied[1].id);
	});

	it("validates edited times and applies the reviewed view rather than the generated one", async () => {
		const input = props({ regions: [face] });
		render(<PresentationEditDialog {...input} />);
		fireEvent.change(screen.getByLabelText("Switch 1 end seconds"), { target: { value: "-1" } });
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Apply switches" }).hasAttribute("disabled")).toBe(
			true,
		);
		fireEvent.click(screen.getByRole("button", { name: "Apply switches" }));
		expect(input.onApply).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Switch 1 end seconds"), { target: { value: "6.5" } });
		fireEvent.change(screen.getByLabelText("Switch 1 view"), { target: { value: "demo" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply switches" }));
		expect(input.onApply).toHaveBeenCalledWith([
			{ ...face, endMs: 6500, mode: "demo", reason: "Adjusted during review." },
		]);
		expect(face.endMs).toBe(10000);
		expect(face.mode).toBe("face-only");
	});

	it("discards a late suggestion after closing and reopening", async () => {
		let complete!: (regions: PresentationRegion[]) => void;
		const pending = new Promise<PresentationRegion[]>((resolve) => {
			complete = resolve;
		});
		const input = props({ onSuggest: vi.fn().mockReturnValue(pending) });
		const view = render(<PresentationEditDialog {...input} />);
		fireEvent.click(screen.getByRole("button", { name: "Suggest switches" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		view.rerender(<PresentationEditDialog {...input} open={false} />);
		view.rerender(<PresentationEditDialog {...input} />);
		await act(async () => complete([face]));
		expect(screen.queryByLabelText("Switch 1 view")).toBeNull();
		expect(input.onApply).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Suggest switches" }).hasAttribute("disabled")).toBe(
			false,
		);
	});

	it("does not attach a delayed old-source plan to a replacement recording", async () => {
		let complete!: (regions: PresentationRegion[]) => void;
		const pending = new Promise<PresentationRegion[]>((resolve) => {
			complete = resolve;
		});
		const input = props({ onSuggest: vi.fn().mockReturnValue(pending) });
		const view = render(<PresentationEditDialog {...input} />);
		fireEvent.click(screen.getByRole("button", { name: "Suggest switches" }));
		view.rerender(
			<PresentationEditDialog {...input} screenVideoPath="file:///new-recording.mp4" />,
		);
		await act(async () => complete([face]));
		expect(screen.queryByLabelText("Switch 1 view")).toBeNull();
		expect(input.onApply).not.toHaveBeenCalled();
	});

	it("resets canceled draft edits to the currently applied switches on reopen", () => {
		const input = props({ regions: [face] });
		const view = render(<PresentationEditDialog {...input} />);
		fireEvent.change(screen.getByLabelText("Switch 1 view"), { target: { value: "demo" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		view.rerender(<PresentationEditDialog {...input} open={false} />);
		view.rerender(<PresentationEditDialog {...input} />);
		expect((screen.getByLabelText("Switch 1 view") as HTMLSelectElement).value).toBe("face-only");
		expect(input.onApply).not.toHaveBeenCalled();
	});

	it("requires camera footage for suggestions but allows clearing an old plan without it", () => {
		const input = props({ webcamVideoPath: undefined, regions: [face] });
		render(<PresentationEditDialog {...input} />);
		expect(screen.getByText(/A camera recording is needed/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Suggest again" }).hasAttribute("disabled")).toBe(
			true,
		);
		expect(screen.getByRole("button", { name: "Apply switches" }).hasAttribute("disabled")).toBe(
			true,
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove 1" }));
		fireEvent.click(screen.getByRole("button", { name: "Apply switches" }));
		expect(input.onApply).toHaveBeenCalledWith([]);
	});

	it("surfaces analysis failures without replacing the applied plan", async () => {
		const input = props({
			regions: [face],
			onSuggest: vi.fn().mockRejectedValue(new Error("Cursor activity is unavailable.")),
		});
		render(<PresentationEditDialog {...input} />);
		fireEvent.click(screen.getByRole("button", { name: "Suggest again" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"Cursor activity is unavailable.",
		);
		expect((screen.getByLabelText("Switch 1 view") as HTMLSelectElement).value).toBe("face-only");
		expect(input.onApply).not.toHaveBeenCalled();
	});

	it("maps a source-frame preview to the camera clock and hides unavailable camera frames", async () => {
		render(<PresentationEditDialog {...props({ regions: [face], webcamOffsetSeconds: 3 })} />);
		const camera = screen.getByLabelText("Camera source frame") as HTMLVideoElement;
		const video = screen.getByLabelText("Screen source frame") as HTMLVideoElement;
		Object.defineProperty(camera, "duration", { configurable: true, value: 20 });
		Object.defineProperty(camera, "readyState", { configurable: true, value: 1 });
		Object.defineProperty(video, "duration", { configurable: true, value: 20 });
		Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
		fireEvent.loadedMetadata(camera);
		expect(camera.className).toContain("opacity-0");
		expect(screen.getByText(/No camera frame is available/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Preview source time"), { target: { value: "6" } });
		await waitFor(() => expect(camera.currentTime).toBe(3));
		expect(video.currentTime).toBe(6);
		expect(camera.className).not.toContain("opacity-0");
		expect(screen.queryByText(/No camera frame is available/)).toBeNull();
	});
});
