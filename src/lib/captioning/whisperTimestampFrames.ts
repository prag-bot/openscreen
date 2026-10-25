/** This adapter depends on the private Whisper implementation in this exact release. */
export const WHISPER_TIMESTAMP_COMPAT_VERSION = "2.17.2";
const correctedModels = new WeakSet<object>();

/**
 * Transformers 2.17.2 passes 100Hz mel-frame counts from pipelines.js into
 * Whisper's 50Hz cross-attention crop in models.js. Crop to encoder frames so
 * dynamic time warping cannot align final words to padded, nonexistent audio.
 * This is the same stride-two conversion as Whisper's encoder; source clocks,
 * decoded text, chunk strides, and returned timestamp precision stay unchanged.
 */
export function correctWhisperTimestampFrameCount(
	model: unknown,
	transformersVersion: string,
): void {
	if (transformersVersion !== WHISPER_TIMESTAMP_COMPAT_VERSION)
		throw new Error(
			"The local speech timing adapter requires Transformers 2.17.2. Restore the pinned dependency before transcribing.",
		);
	if (!model || (typeof model !== "object" && typeof model !== "function"))
		throw new Error("The local Whisper timestamp model is unavailable.");
	const whisper = model as {
		config?: { model_type?: unknown };
		_extract_token_timestamps?: (...args: unknown[]) => unknown;
	};
	const original = whisper._extract_token_timestamps;
	if (whisper.config?.model_type !== "whisper" || typeof original !== "function")
		throw new Error("The local Whisper timestamp model has an unsupported implementation.");
	if (correctedModels.has(model)) return;
	whisper._extract_token_timestamps = function (...args: unknown[]) {
		const melFrames = args[2];
		if (melFrames !== undefined && melFrames !== null) {
			if (typeof melFrames !== "number" || !Number.isInteger(melFrames) || melFrames < 2)
				throw new Error("The local Whisper audio frame count is invalid.");
			args[2] = Math.floor(melFrames / 2);
		}
		return original.apply(this, args);
	};
	correctedModels.add(model);
}
