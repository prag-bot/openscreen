import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trimLeadingSilenceMono16k } from "@/lib/captioning/leadingSilence";
import { validateAutoEditRequest } from "../../electron/auto-edit/codexPlanner";
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
	it("restores leading silence and bounds a floating-point tail before one valid plan request", async () => {
		const samples = new Float32Array(799_001);
		samples.fill(0.1, 16_000);
		const durationSeconds = samples.length / 16_000;
		audio.extract.mockResolvedValue({ samples, truncated: false });
		audio.trim.mockImplementation(trimLeadingSilenceMono16k);
		audio.transcribe.mockImplementation(async (speech: Float32Array) => ({
			segments: [{ startSec: 0, endSec: speech.length / 16_000, text: "all narration" }],
			granularity: "phrase",
		}));
		propose.mockImplementation(async (request) => {
			validateAutoEditRequest(request);
			return { success: true, plan };
		});
		const { result } = renderHook(() => useAutoEdit("/source.mp4", durationSeconds, "source-a"));
		await act(async () => result.current.generate("Clean up", false));
		expect(propose).toHaveBeenCalledOnce();
		expect(propose.mock.calls[0][0].segments).toEqual([
			{ startSec: 0.88, endSec: durationSeconds, text: "all narration" },
		]);
		expect(result.current.error).toBeNull();
	});
	it("limits longer audio at the video edge while keeping every in-recording speech sample", async () => {
		const samples = new Float32Array(800_640).fill(0.1);
		audio.extract.mockResolvedValue({ samples, truncated: false });
		audio.trim.mockImplementation(trimLeadingSilenceMono16k);
		audio.transcribe.mockImplementation(async (speech: Float32Array) => ({
			segments: [{ startSec: 48, endSec: speech.length / 16_000, text: "last words" }],
			granularity: "phrase",
		}));
		propose.mockImplementation(async (request) => {
			validateAutoEditRequest(request);
			return { success: true, plan };
		});
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 50, "source-a"));
		await act(async () => result.current.generate("Clean up", false));
		expect(audio.transcribe.mock.calls[0][0].length).toBe(800_000);
		expect(samples.length).toBe(800_640);
		expect(propose).toHaveBeenCalledOnce();
		expect(propose.mock.calls[0][0].segments).toEqual([
			{ startSec: 48, endSec: 50, text: "last words" },
		]);
		expect(result.current.error).toBeNull();
	});
	it("reports malformed source-time speech locally without sending a plan request", async () => {
		audio.trim.mockReturnValue({ samples: new Float32Array(1600).fill(0.1), trimSec: 0.63 });
		audio.transcribe.mockResolvedValue({
			segments: [{ startSec: 80.89, endSec: 70.77331249999999, text: "model tail" }],
			granularity: "word",
		});
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 70.891667, "source-a"));
		await act(async () => result.current.generate("Clean up", false));
		expect(result.current.error).toMatch(/reversed or empty speech timing/);
		expect(propose).not.toHaveBeenCalled();
	});
	it("keeps an empty transcription local and sends no plan request", async () => {
		audio.transcribe.mockResolvedValue({ segments: [], granularity: "phrase" });
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		await act(async () => result.current.generate("Clean up", false));
		expect(result.current.error).toMatch(/No speech was transcribed/);
		expect(propose).not.toHaveBeenCalled();
	});
	it("retains successfully normalized speech for inspection if Codex planning fails", async () => {
		propose.mockResolvedValue({ success: false, error: "Codex unavailable" });
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		await act(async () => result.current.generate("Clean up", false));
		expect(result.current.transcript).toEqual([{ startSec: 61, endSec: 62, text: "hello" }]);
		expect(result.current.transcriptGranularity).toBe("phrase");
		expect(result.current.error).toBe("Codex unavailable");
		expect(result.current.plan).toBeNull();
	});
	it("preserves mixed timing when only part of the local transcript has precise word alignment", async () => {
		audio.transcribe.mockResolvedValue({
			segments: [
				{ startSec: 1, endSec: 1.2, text: "um" },
				{ startSec: 1.2, endSec: 3, text: "a coarser phrase" },
			],
			granularity: "mixed",
		});
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		await act(async () => result.current.generate("Clean up", false));
		expect(result.current.transcriptGranularity).toBe("mixed");
		expect(result.current.transcript).toEqual([
			{ startSec: 61, endSec: 61.2, text: "um" },
			{ startSec: 61.2, endSec: 63, text: "a coarser phrase" },
		]);
		expect(propose).toHaveBeenCalledOnce();
	});
	it("clears inspected speech on regeneration and cancellation, ignoring late transcription", async () => {
		propose.mockResolvedValue({ success: false, error: "Codex unavailable" });
		const { result } = renderHook(() => useAutoEdit("/source.mp4", 1800, "source-a"));
		await act(async () => result.current.generate("Clean up", false));
		expect(result.current.transcript).not.toBeNull();
		let complete!: (value: unknown) => void;
		audio.transcribe.mockReturnValueOnce(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		let pending!: Promise<void>;
		act(() => {
			pending = result.current.generate("Try again", false);
		});
		await waitFor(() => expect(audio.transcribe).toHaveBeenCalledTimes(2));
		expect(result.current.transcript).toBeNull();
		expect(result.current.transcriptGranularity).toBeNull();
		act(() => result.current.cancel());
		await act(async () => {
			complete({ segments: [{ startSec: 0, endSec: 1, text: "late" }], granularity: "word" });
			await pending;
		});
		expect(result.current.transcript).toBeNull();
		expect(result.current.transcriptGranularity).toBeNull();
		expect(propose).toHaveBeenCalledOnce();
	});
	it("never exposes a previous source's transcript or a late plan after an equal-duration source change", async () => {
		const { result, rerender } = renderHook(
			({ revision }) => useAutoEdit("/source.mp4", 1800, revision),
			{ initialProps: { revision: "source-a" } },
		);
		await act(async () => result.current.generate("Clean up", false));
		expect(result.current.transcript).not.toBeNull();
		rerender({ revision: "source-b" });
		expect(result.current.transcript).toBeNull();
		expect(result.current.transcriptGranularity).toBeNull();
		let complete!: (value: unknown) => void;
		propose.mockReturnValueOnce(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		let pending!: Promise<void>;
		act(() => {
			pending = result.current.generate("New source", false);
		});
		await waitFor(() => expect(propose).toHaveBeenCalledTimes(2));
		expect(result.current.transcript).not.toBeNull();
		rerender({ revision: "source-c" });
		expect(result.current.transcript).toBeNull();
		await act(async () => {
			complete({ success: true, plan });
			await pending;
		});
		expect(result.current.transcript).toBeNull();
		expect(result.current.transcriptGranularity).toBeNull();
		expect(result.current.plan).toBeNull();
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
