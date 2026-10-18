import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HyperframesExportRequest } from "@/lib/exporter/hyperframesExporter";
import { HyperframesExportButton } from "./HyperframesExportButton";

const hyperframesRequest: HyperframesExportRequest = {
	screenVideoPath: "/recording.webm",
	durationSeconds: 2,
	width: 640,
	height: 480,
	trimRegions: [{ id: "trim-1", startMs: 500, endMs: 1000 }],
	webcamLayoutPreset: "picture-in-picture",
	webcamSizePreset: 25,
	webcamPosition: null,
	webcamMaskShape: "circle",
	webcamMirrored: false,
};

const messages = vi.hoisted(() => ({
	success: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: messages }));

describe("Edit in HyperFrames", () => {
	const exportProject = vi.fn();
	const reveal = vi.fn();
	const originalAPI = window.electronAPI;
	beforeEach(() => {
		vi.clearAllMocks();
		window.electronAPI = {
			exportHyperframesProject: exportProject,
			revealInFolder: reveal,
		} as unknown as Window["electronAPI"];
	});
	afterEach(() => {
		window.electronAPI = originalAPI;
	});

	it("exports the current millisecond trims and reveals only a successful local project", async () => {
		exportProject.mockResolvedValue({ success: true, path: "/new-project", warnings: [] });
		reveal.mockResolvedValue({ success: true });
		render(<HyperframesExportButton getRequest={() => hyperframesRequest} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit in HyperFrames" }));
		await waitFor(() => expect(reveal).toHaveBeenCalledWith("/new-project"));
		expect(exportProject).toHaveBeenCalledWith(hyperframesRequest);
		expect(messages.success).toHaveBeenCalledOnce();
		expect(screen.getByText(/Use Auto edit with Codex first/)).toBeTruthy();
	});

	it("reports cancellation without claiming success or revealing anything", async () => {
		exportProject.mockResolvedValue({ success: false, canceled: true, error: "Canceled" });
		render(<HyperframesExportButton getRequest={() => hyperframesRequest} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit in HyperFrames" }));
		await waitFor(() => expect(messages.info).toHaveBeenCalledOnce());
		expect(reveal).not.toHaveBeenCalled();
		expect(messages.success).not.toHaveBeenCalled();
	});

	it("reports export errors and returns the button to its usable state", async () => {
		exportProject.mockResolvedValue({ success: false, error: "Recording media is missing" });
		render(<HyperframesExportButton getRequest={() => hyperframesRequest} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit in HyperFrames" }));
		await waitFor(() =>
			expect(messages.error).toHaveBeenCalledWith(expect.stringContaining("missing")),
		);
		expect(reveal).not.toHaveBeenCalled();
		expect(
			(screen.getByRole("button", { name: "Edit in HyperFrames" }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	it("does not confuse folder-reveal failure with export failure", async () => {
		exportProject.mockResolvedValue({ success: true, path: "/new-project", warnings: [] });
		reveal.mockResolvedValue({ success: false, error: "Unavailable" });
		render(<HyperframesExportButton getRequest={() => hyperframesRequest} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit in HyperFrames" }));
		await waitFor(() => expect(messages.warning).toHaveBeenCalledOnce());
		expect(messages.success).toHaveBeenCalledOnce();
		expect(messages.error).not.toHaveBeenCalled();
	});

	it("honestly reports missing metadata before invoking IPC", async () => {
		const getRequest = () => {
			throw new Error("Video not ready");
		};
		render(<HyperframesExportButton getRequest={getRequest} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit in HyperFrames" }));
		await waitFor(() =>
			expect(messages.error).toHaveBeenCalledWith(expect.stringContaining("Video not ready")),
		);
		expect(exportProject).not.toHaveBeenCalled();
	});
});
