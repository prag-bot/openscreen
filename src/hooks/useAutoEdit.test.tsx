import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoEdit } from "./useAutoEdit";

const audio = vi.hoisted(() => ({ extract: vi.fn(), transcribe: vi.fn(), trim: vi.fn() }));
vi.mock("@/lib/captioning", () => ({
	extractMono16kFromVideoUrl: audio.extract,
	transcribeMono16kToSegments: audio.transcribe,
	trimLeadingSilenceMono16k: audio.trim,
}));
const plan = {
	cuts: [{ startMs: 5000, endMs: 6000, reason: "filler", source: "codex" as const }],
	summary: "One cut",
	originalDurationSeconds: 1800,
	removedSeconds: 1,
};
describe("auto edit lifecycle", () => {
	const originalAPI = window.electronAPI;
	const prepare = vi.fn();
	const propose = vi.fn();
	const cancel = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		prepare.mockResolvedValue({ success: true, path: "/narration.wav" });
		cancel.mockResolvedValue({ success: true });
		propose.mockResolvedValue({ success: true, plan });
		const samples = new Float32Array(1600).fill(0.1);
		audio.extract.mockResolvedValue({ samples, truncated: false });
		audio.trim.mockReturnValue({ samples, trimSec: 60 });
		audio.transcribe.mockResolvedValue({
			segments: [{ startSec: 1, endSec: 2, text: "hello" }],
			granularity: "phrase",
		});
		window.electronAPI = {
			prepareAutoEditAudio: prepare,
			planAutoEdit: propose,
			cancelAutoEdit: cancel,
		} as unknown as Window["electronAPI"];
	});
	afterEach(() => {
		window.electronAPI = originalAPI;
	});
	it("transcribes locally and preserves source offsets for a 30-minute demo", async () => {
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		await act(async () => {
			await result.current.generate("Keep meaningful steps", false);
		});
		expect(audio.extract).toHaveBeenCalledWith(
			"/narration.wav",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(propose).toHaveBeenCalledWith(
			expect.objectContaining({
				durationSeconds: 1800,
				segments: [{ startSec: 61, endSec: 62, text: "hello" }],
				tightenPauses: false,
			}),
		);
		expect(result.current.plan).toEqual(plan);
	});
	it("normalizes local overlapping words before sending their source-time transcript", async () => {
		audio.transcribe.mockResolvedValue({
			segments: [
				{ startSec: 0, endSec: 0.08, text: "a" },
				{ startSec: 0.04, endSec: 0.4, text: "test" },
				{ startSec: 0.4, endSec: 1, text: "sentence" },
			],
		});
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		await act(async () => {
			await result.current.generate("Clean up", false);
		});
		expect(propose).toHaveBeenCalledWith(
			expect.objectContaining({
				segments: [
					{ startSec: 60, endSec: 60.4, text: "a test" },
					{ startSec: 60.4, endSec: 61, text: "sentence" },
				],
			}),
		);
	});
	it("sends no transcript for silent audio or truncated recordings", async () => {
		audio.extract.mockResolvedValue({ samples: new Float32Array(1600), truncated: false });
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		await act(async () => {
			await result.current.generate("Clean up", false);
		});
		expect(result.current.error).toMatch(/No audible/);
		expect(propose).not.toHaveBeenCalled();
		audio.extract.mockResolvedValue({ samples: new Float32Array(1600).fill(0.1), truncated: true });
		await act(async () => {
			await result.current.generate("Clean up", false);
		});
		expect(result.current.error).toMatch(/no partial edit/);
		expect(propose).not.toHaveBeenCalled();
	});
	it("discards a delayed plan after switching projects, even with equal durations", async () => {
		let resolvePlan!: (value: unknown) => void;
		propose.mockReturnValue(
			new Promise((resolve) => {
				resolvePlan = resolve;
			}),
		);
		const { result, rerender } = renderHook(
			({ revision }) => useAutoEdit("/source.mp4", 1800, revision),
			{ initialProps: { revision: "source-a" } },
		);
		let pending!: Promise<void>;
		act(() => {
			pending = result.current.generate("Clean up", false);
		});
		await waitFor(() => expect(propose).toHaveBeenCalledOnce());
		rerender({ revision: "source-b" });
		await act(async () => {
			resolvePlan({ success: true, plan });
			await pending;
		});
		expect(result.current.plan).toBeNull();
		expect(cancel).toHaveBeenCalled();
	});
	it("cancel kills the job and prevents a completed result resurfacing", async () => {
		let resolvePlan!: (value: unknown) => void;
		propose.mockReturnValue(
			new Promise((resolve) => {
				resolvePlan = resolve;
			}),
		);
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		let pending!: Promise<void>;
		act(() => {
			pending = result.current.generate("Clean up", false);
		});
		await waitFor(() => expect(propose).toHaveBeenCalledOnce());
		act(() => result.current.cancel());
		await act(async () => {
			resolvePlan({ success: true, plan });
			await pending;
		});
		expect(result.current.plan).toBeNull();
		expect(result.current.phase).toBeNull();
	});
});
