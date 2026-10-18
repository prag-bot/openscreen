import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoEditDialog } from "./AutoEditDialog";

const editor = vi.hoisted(() => ({
	phase: null as string | null,
	error: null,
	plan: {
		cuts: [{ startMs: 2000, endMs: 4000, reason: "Repeated explanation", source: "codex" }],
		summary: "One repetition removed",
		originalDurationSeconds: 10,
		removedSeconds: 2,
	},
	generate: vi.fn(),
	cancel: vi.fn(),
	clearPlan: vi.fn(),
}));
vi.mock("@/hooks/useAutoEdit", () => ({ useAutoEdit: () => editor }));
describe("auto edit review dialog", () => {
	const originalAPI = window.electronAPI;
	beforeEach(() => {
		vi.clearAllMocks();
		editor.phase = null;
		editor.plan.cuts = [
			{ startMs: 2000, endMs: 4000, reason: "Repeated explanation", source: "codex" },
		];
		editor.plan.removedSeconds = 2;
		window.electronAPI = {
			getAutoEditStatus: async () => ({ available: true, message: "Codex ready" }),
		} as unknown as Window["electronAPI"];
	});
	afterEach(() => {
		window.electronAPI = originalAPI;
	});
	it("discloses transcript processing and keeps apply separate from generation", async () => {
		const apply = vi.fn().mockResolvedValue(undefined);
		render(
			<AutoEditDialog
				open
				onOpenChange={vi.fn()}
				videoPath="/demo.mp4"
				durationSeconds={10}
				trimRegions={[]}
				revision="source-a"
				onApply={apply}
			/>,
		);
		await screen.findByText("Codex ready");
		expect(screen.getByText(/Only the transcript and your instructions/)).toBeTruthy();
		expect(screen.getByText("Source 0:10 · Current 0:10 → Result 0:08")).toBeTruthy();
		expect(apply).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Apply cuts" }));
		await waitFor(() => expect(apply).toHaveBeenCalledWith(editor.plan, false));
	});
	it("exports the editable project only through its explicit apply-and-export action", async () => {
		const apply = vi.fn().mockResolvedValue(undefined);
		render(
			<AutoEditDialog
				open
				onOpenChange={vi.fn()}
				videoPath="/demo.mp4"
				durationSeconds={10}
				trimRegions={[]}
				revision="source-a"
				onApply={apply}
			/>,
		);
		await screen.findByText("Codex ready");
		fireEvent.click(screen.getByRole("button", { name: "Apply + export HyperFrames" }));
		await waitFor(() => expect(apply).toHaveBeenCalledWith(editor.plan, true));
	});
	it.each([
		{ startMs: 6000, endMs: 8000, result: "0:06" },
		{ startMs: 3000, endMs: 5000, result: "0:07" },
	])("previews the union with manual cuts ending at $endMs", async ({ startMs, endMs, result }) => {
		const existing = [{ id: "manual", startMs, endMs }];
		editor.plan.removedSeconds = 9; // Planner metadata must not invent saved time.
		render(
			<AutoEditDialog
				open
				onOpenChange={vi.fn()}
				videoPath="/demo.mp4"
				durationSeconds={10}
				trimRegions={existing}
				revision="source-a"
				onApply={vi.fn()}
			/>,
		);
		await screen.findByText("Codex ready");
		expect(screen.getByText(`Source 0:10 · Current 0:08 → Result ${result}`)).toBeTruthy();
		expect(existing).toEqual([{ id: "manual", startMs, endMs }]);
	});
	it("blocks applying cuts that remove all remaining footage and shows no result-duration claim", async () => {
		const apply = vi.fn();
		const existing = [
			{ id: "manual-1", startMs: 0, endMs: 2000 },
			{ id: "manual-2", startMs: 4000, endMs: 10000 },
		];
		render(
			<AutoEditDialog
				open
				onOpenChange={vi.fn()}
				videoPath="/demo.mp4"
				durationSeconds={10}
				trimRegions={existing}
				revision="source-a"
				onApply={apply}
			/>,
		);
		await screen.findByText("Codex ready");
		expect(screen.getByRole("alert").textContent).toMatch(/removed|entire/);
		expect(screen.queryByText(/→ Result/)).toBeNull();
		const applyButton = screen.getByRole("button", { name: "Apply cuts" });
		expect(applyButton.hasAttribute("disabled")).toBe(true);
		expect(
			screen.getByRole("button", { name: "Apply + export HyperFrames" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.click(applyButton);
		expect(apply).not.toHaveBeenCalled();
		expect(existing).toHaveLength(2);
	});
});
