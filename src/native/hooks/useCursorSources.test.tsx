import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorRecordingData, CursorTelemetryPoint } from "@/native/contracts";
import { useCursorRecordingData } from "./useCursorRecordingData";
import { useCursorTelemetry } from "./useCursorTelemetry";

const bridge = vi.hoisted(() => ({ recording: vi.fn(), telemetry: vi.fn() }));
vi.mock("../client", () => ({
	nativeBridgeClient: {
		cursor: { getRecordingData: bridge.recording, getTelemetry: bridge.telemetry },
	},
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function sidecars(cx: number) {
	const samples: CursorTelemetryPoint[] = [{ timeMs: 0, cx, cy: 0.5 }];
	const recording: CursorRecordingData = { version: 2, provider: "none", samples, assets: [] };
	return { recording, samples };
}

function queueLoad() {
	const recording = deferred<CursorRecordingData | null>();
	const telemetry = deferred<CursorTelemetryPoint[]>();
	bridge.recording.mockReturnValueOnce(recording.promise);
	bridge.telemetry.mockReturnValueOnce(telemetry.promise);
	return {
		recording,
		telemetry,
		complete(value: ReturnType<typeof sidecars>) {
			recording.resolve(value.recording);
			telemetry.resolve(value.samples);
		},
	};
}

function useSources(path: string | null) {
	return { recording: useCursorRecordingData(path), telemetry: useCursorTelemetry(path) };
}

function expectPending(value: ReturnType<typeof useSources>) {
	expect(value.recording).toEqual({ data: null, sourcePath: null, loading: true, error: null });
	expect(value.telemetry).toEqual({ samples: [], sourcePath: null, loading: true, error: null });
}

describe("cursor sidecar source identity", () => {
	beforeEach(() => vi.resetAllMocks());
	afterEach(cleanup);

	it("does not request sidecars without a recording", () => {
		const { result } = renderHook(() => useSources(null));
		expect(result.current.recording).toEqual({
			data: null,
			sourcePath: null,
			loading: false,
			error: null,
		});
		expect(result.current.telemetry).toEqual({
			samples: [],
			sourcePath: null,
			loading: false,
			error: null,
		});
		expect(bridge.recording).not.toHaveBeenCalled();
		expect(bridge.telemetry).not.toHaveBeenCalled();
	});

	it("never exposes old sidecars while replacing a recording of the same duration", async () => {
		const first = queueLoad();
		const second = queueLoad();
		const oldData = sidecars(0.1);
		const newData = sidecars(0.9);
		const observations: Array<{ path: string; value: ReturnType<typeof useSources> }> = [];
		const { result, rerender } = renderHook(
			({ path }) => {
				const value = useSources(path);
				observations.push({ path, value });
				return value;
			},
			{ initialProps: { path: "/first.mp4", durationSeconds: 20 } },
		);
		expectPending(result.current);
		await act(async () => first.complete(oldData));
		expect(result.current.recording.sourcePath).toBe("/first.mp4");
		expect(result.current.recording.data).toBe(oldData.recording);
		rerender({ path: "/second.mp4", durationSeconds: 20 });
		expectPending(result.current);
		for (const observation of observations.filter(({ path }) => path === "/second.mp4"))
			expectPending(observation.value);
		await act(async () => second.complete(newData));
		expect(result.current.recording).toEqual({
			data: newData.recording,
			sourcePath: "/second.mp4",
			loading: false,
			error: null,
		});
		expect(result.current.telemetry).toEqual({
			samples: newData.samples,
			sourcePath: "/second.mp4",
			loading: false,
			error: null,
		});
	});

	it("ignores an old source completion after a replacement request begins", async () => {
		const first = queueLoad();
		const second = queueLoad();
		const { result, rerender } = renderHook(({ path }) => useSources(path), {
			initialProps: { path: "/first.mp4" },
		});
		rerender({ path: "/second.mp4" });
		await act(async () => first.complete(sidecars(0.1)));
		expectPending(result.current);
		const currentData = sidecars(0.9);
		await act(async () => second.complete(currentData));
		expect(result.current.recording.data).toBe(currentData.recording);
		expect(result.current.telemetry.samples).toBe(currentData.samples);
		expect(result.current.recording.sourcePath).toBe("/second.mp4");
		expect(result.current.telemetry.sourcePath).toBe("/second.mp4");
	});

	it("ignores old errors and does not let their completion stop current loading", async () => {
		const first = queueLoad();
		const second = queueLoad();
		const { result, rerender } = renderHook(({ path }) => useSources(path), {
			initialProps: { path: "/first.mp4" },
		});
		rerender({ path: "/second.mp4" });
		await act(async () => {
			first.recording.reject(new Error("Old recording failed"));
			first.telemetry.reject(new Error("Old telemetry failed"));
		});
		expectPending(result.current);
		await act(async () => second.complete(sidecars(0.9)));
		expect(result.current.recording.error).toBeNull();
		expect(result.current.telemetry.error).toBeNull();
	});

	it("retains errors and stopped loading for failures, then clears them for a new source", async () => {
		const first = queueLoad();
		queueLoad();
		const { result, rerender } = renderHook(({ path }) => useSources(path), {
			initialProps: { path: "/first.mp4" },
		});
		await act(async () => {
			first.recording.reject(new Error("Cannot read recording"));
			first.telemetry.reject("unreadable");
		});
		expect(result.current.recording).toEqual({
			data: null,
			sourcePath: null,
			loading: false,
			error: "Cannot read recording",
		});
		expect(result.current.telemetry).toEqual({
			samples: [],
			sourcePath: null,
			loading: false,
			error: "Failed to load cursor telemetry",
		});
		rerender({ path: "/second.mp4" });
		expectPending(result.current);
	});

	it("marks successful empty sidecars as loaded for the current source", async () => {
		const pending = queueLoad();
		const { result } = renderHook(() => useSources("/empty.mp4"));
		await act(async () => {
			pending.recording.resolve(null);
			pending.telemetry.resolve([]);
		});
		expect(result.current.recording).toEqual({
			data: null,
			sourcePath: "/empty.mp4",
			loading: false,
			error: null,
		});
		expect(result.current.telemetry).toEqual({
			samples: [],
			sourcePath: "/empty.mp4",
			loading: false,
			error: null,
		});
	});

	it("clears the source immediately and ignores late results after removing media", async () => {
		const pending = queueLoad();
		const { result, rerender } = renderHook(({ path }) => useSources(path), {
			initialProps: { path: "/first.mp4" as string | null },
		});
		rerender({ path: null });
		await act(async () => pending.complete(sidecars(0.1)));
		expect(result.current.recording).toEqual({
			data: null,
			sourcePath: null,
			loading: false,
			error: null,
		});
		expect(result.current.telemetry).toEqual({
			samples: [],
			sourcePath: null,
			loading: false,
			error: null,
		});
	});
});
