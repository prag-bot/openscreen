import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorEmptyState } from "./EditorEmptyState";

const setCurrentVideoPath = vi.hoisted(() => vi.fn());
const showError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: showError } }));
vi.mock("@/native", () => ({ nativeBridgeClient: { project: { setCurrentVideoPath } } }));
vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));

describe("canonical playback import", () => {
	const originalAPI = window.electronAPI;
	afterEach(() => {
		cleanup();
		window.electronAPI = originalAPI;
		vi.clearAllMocks();
	});
	it.each([
		"/screen-playback.mp4",
		undefined,
	])("imports the main-process prepared path %s, falling back for legacy APIs", async (preparedPath) => {
		window.electronAPI = {
			openVideoFilePicker: vi.fn().mockResolvedValue({ success: true, path: "/screen.mp4" }),
		} as unknown as Window["electronAPI"];
		setCurrentVideoPath.mockResolvedValue({ success: true, path: preparedPath });
		const onVideoImported = vi.fn();
		render(<EditorEmptyState onVideoImported={onVideoImported} onProjectOpened={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "emptyState.importVideoButton" }));
		await waitFor(() =>
			expect(onVideoImported).toHaveBeenCalledWith(preparedPath ?? "/screen.mp4"),
		);
		expect(setCurrentVideoPath).toHaveBeenCalledWith("/screen.mp4");
	});
	it.each([
		"message",
		"error",
	])("shows actionable preparation failure from %s without importing the original", async (field) => {
		const failure =
			"Could not prepare recording audio. Original recording retained at /screen.mp4. Disk is read-only.";
		window.electronAPI = {
			openVideoFilePicker: vi.fn().mockResolvedValue({ success: true, path: "/screen.mp4" }),
		} as unknown as Window["electronAPI"];
		setCurrentVideoPath.mockResolvedValue({ success: false, [field]: failure });
		const onVideoImported = vi.fn();
		render(<EditorEmptyState onVideoImported={onVideoImported} onProjectOpened={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "emptyState.importVideoButton" }));
		await waitFor(() => expect(showError).toHaveBeenCalledWith(failure));
		expect(onVideoImported).not.toHaveBeenCalled();
	});
});
