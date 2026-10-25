import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionSegment, CaptionTimestampGranularity } from "@/lib/captioning/transcribe";
import { AutoEditDialog } from "./AutoEditDialog";

const editor = vi.hoisted(() => ({
	phase: null as string | null,
	error: null as string | null,
	transcript: null as CaptionSegment[] | null,
	transcriptGranularity: null as CaptionTimestampGranularity | null,
	hidePlan: false,
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
vi.mock("@/hooks/useAutoEdit", () => ({
	useAutoEdit: () => ({ ...editor, plan: editor.hidePlan ? null : editor.plan }),
}));
describe("auto edit review dialog", () => {
	const originalAPI = window.electronAPI;
	beforeEach(() => {
		vi.clearAllMocks();
		editor.phase = null;
		editor.error = null;
		editor.transcript = null;
		editor.transcriptGranularity = null;
		editor.hidePlan = false;
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
		fireEvent.click(screen.getByRole("button", { name: "Apply + render HyperFrames MP4" }));
		await waitFor(() => expect(apply).toHaveBeenCalledWith(editor.plan, true));
	});
	it("shows actual locally recognized words with precise source times even when planning fails", async () => {
		editor.transcript = [
			{ startSec: 1.21, endSec: 1.45, text: "uh" },
			{ startSec: 2, endSec: 3.25, text: "Here is the screen demo." },
		];
		editor.transcriptGranularity = "phrase";
		editor.error = "Codex could not return a cut plan.";
		editor.hidePlan = true;
		const apply = vi.fn();
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
		expect(screen.getByRole("alert").textContent).toBe("Codex could not return a cut plan.");
		const summary = screen.getByText("Transcript").closest("summary");
		expect(summary).not.toBeNull();
		fireEvent.click(summary!);
		expect(summary!.closest("details")!.open).toBe(true);
		expect(screen.getByText("2 timed segments · phrase timing")).toBeTruthy();
		expect(screen.getByText("0:01.210–0:01.450")).toBeTruthy();
		expect(screen.getByText("Here is the screen demo.")).toBeTruthy();
		expect(screen.getByText(/These words were recognized on this Mac/)).toBeTruthy();
		expect(apply).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Apply cuts" })).toBeNull();
	});
	it("does not invent a transcript when recognition has not supplied one", async () => {
		editor.transcript = null;
		editor.error = "No speech was transcribed.";
		render(
			<AutoEditDialog
				open
				onOpenChange={vi.fn()}
				videoPath="/demo.mp4"
				durationSeconds={10}
				trimRegions={[]}
				revision="source-a"
				onApply={vi.fn()}
			/>,
		);
		await screen.findByText("Codex ready");
		expect(screen.queryByText("Transcript")).toBeNull();
		expect(screen.queryByLabelText("Recognized transcript")).toBeNull();
	});
	it("renders quoted markup as speech text rather than executable HTML", async () => {
		const speech = '<img src=x onerror="alert(1)"> <script>alert(2)</script>';
		editor.transcript = [{ startSec: 0, endSec: 1, text: speech }];
		editor.transcriptGranularity = "word";
		render(
			<AutoEditDialog
				open
				onOpenChange={vi.fn()}
				videoPath="/demo.mp4"
				durationSeconds={10}
				trimRegions={[]}
				revision="source-a"
				onApply={vi.fn()}
			/>,
		);
		await screen.findByText("Codex ready");
		expect(screen.getByText(speech)).toBeTruthy();
		expect(screen.getByText("1 timed segment · word timing")).toBeTruthy();
		const transcript = screen.getByLabelText("Recognized transcript");
		expect(transcript.querySelector("img")).toBeNull();
		expect(transcript.querySelector("script")).toBeNull();
	});
	it("identifies long-transcript pagination and exposes the remaining recognized text on request", async () => {
		editor.transcript = Array.from({ length: 201 }, (_, index) => ({
			startSec: index * 0.04,
			endSec: (index + 1) * 0.04,
			text: `Recognized segment ${index + 1}`,
		}));
		editor.transcriptGranularity = "word";
		render(
			<AutoEditDialog
				open
				onOpenChange={vi.fn()}
				videoPath="/demo.mp4"
				durationSeconds={10}
				trimRegions={[]}
				revision="source-a"
				onApply={vi.fn()}
			/>,
		);
		await screen.findByText("Codex ready");
		fireEvent.click(screen.getByText("Transcript").closest("summary")!);
		expect(screen.getByText("Showing 200 of 201 timed segments")).toBeTruthy();
		expect(screen.queryByText("Recognized segment 201")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Show more transcript" }));
		expect(screen.getByText("Recognized segment 201")).toBeTruthy();
		expect(screen.queryByText("Showing 200 of 201 timed segments")).toBeNull();
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
			screen
				.getByRole("button", { name: "Apply + render HyperFrames MP4" })
				.hasAttribute("disabled"),
		).toBe(true);
		fireEvent.click(applyButton);
		expect(apply).not.toHaveBeenCalled();
		expect(existing).toHaveLength(2);
	});
});
