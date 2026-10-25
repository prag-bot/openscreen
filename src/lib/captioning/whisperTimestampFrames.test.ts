import { describe, expect, it, vi } from "vitest";
import { correctWhisperTimestampFrameCount } from "./whisperTimestampFrames";

describe("pinned Whisper encoder-frame compatibility", () => {
	it("converts mel to encoder frames for full and short final chunks while preserving callback context and arguments", () => {
		const original = vi.fn(function (this: unknown, ...args: unknown[]) {
			return { receiver: this, args };
		});
		const model = { config: { model_type: "whisper" }, _extract_token_timestamps: original };
		correctWhisperTimestampFrameCount(model, "2.17.2");
		const outputs = {},
			heads = [[2, 2]];
		for (const [mel, encoder] of [
			[3000, 1500],
			[1010, 505],
			[620, 310],
			[5, 2],
		]) {
			const result = model._extract_token_timestamps(outputs, heads, mel, 0.02, "extra");
			expect(result).toEqual({ receiver: model, args: [outputs, heads, encoder, 0.02, "extra"] });
		}
	});

	it("does not divide twice or alter an unspecified frame count", () => {
		const original = vi.fn((...args: unknown[]) => args);
		const model = { config: { model_type: "whisper" }, _extract_token_timestamps: original };
		correctWhisperTimestampFrameCount(model, "2.17.2");
		correctWhisperTimestampFrameCount(model, "2.17.2");
		expect(model._extract_token_timestamps({}, [], 1000)).toEqual([{}, [], 500]);
		expect(model._extract_token_timestamps({}, [])).toEqual([{}, []]);
		expect(model._extract_token_timestamps({}, [], null)).toEqual([{}, [], null]);
	});

	it("supports the callable model objects returned by the real Transformers pipeline", () => {
		const extract = vi.fn(function (this: unknown, ...args: unknown[]) {
			return { receiver: this, args };
		});
		const model = Object.assign(() => "callable", {
			config: { model_type: "whisper" },
			_extract_token_timestamps: extract,
		});
		correctWhisperTimestampFrameCount(model, "2.17.2");
		correctWhisperTimestampFrameCount(model, "2.17.2");
		expect(model()).toBe("callable");
		expect(model._extract_token_timestamps({}, [], 1010)).toEqual({
			receiver: model,
			args: [{}, [], 505],
		});
	});

	it("fails closed for another release, model implementation, or invalid frame count", () => {
		const model = { config: { model_type: "whisper" }, _extract_token_timestamps: vi.fn() };
		expect(() => correctWhisperTimestampFrameCount(model, "2.18.0")).toThrow(/pinned dependency/);
		expect(() => correctWhisperTimestampFrameCount({}, "2.17.2")).toThrow(
			/unsupported implementation/,
		);
		correctWhisperTimestampFrameCount(model, "2.17.2");
		for (const frames of [0, 1, -1, 1.5, NaN, Infinity, "1010"])
			expect(() => model._extract_token_timestamps({}, [], frames)).toThrow(
				/frame count is invalid/,
			);
		expect(model.config.model_type).toBe("whisper");
	});
});
