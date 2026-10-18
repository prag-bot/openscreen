import type { Rectangle } from "electron";
import type { CursorCaptureMode } from "./recordingSession";

export type NativeMacSourceType = "display" | "window";

export type NativeMacRecordingRequest = {
	schemaVersion: 1;
	recordingId?: number;
	source: {
		type: NativeMacSourceType;
		sourceId: string;
		displayId?: number;
		windowId?: number;
		bounds?: Rectangle;
	};
	video: {
		fps: number;
		width: number;
		height: number;
		bitrate?: number;
		hideSystemCursor: boolean;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			deviceId?: string;
			deviceName?: string;
			gain: number;
		};
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		width: number;
		height: number;
		fps: number;
	};
	cursor: {
		mode: CursorCaptureMode;
	};
	outputs: {
		screenPath: string;
		manifestPath?: string;
	};
};

/** Added only by the main process, never trusted from renderer IPC data. */
export type NativeMacHelperRecordingRequest = NativeMacRecordingRequest & {
	captureExclusion: {
		processId: number;
	};
};

export type NativeMacHelperReadyEvent = {
	event: "ready";
	schemaVersion: 1;
};

export type NativeMacHelperRecordingStartedEvent = {
	event: "recording-started";
	timestampMs: number;
	/** Wall clock of the source frame used as the file's zero, derived from host-clock PTS. */
	screenStartedAtUnixMs: number;
	excludedRecorderProcessId: number;
};

export type NativeMacHelperRecordingStoppedEvent = {
	event: "recording-stopped";
	screenPath: string;
};

export type NativeMacHelperWarningEvent = {
	event: "warning";
	code: string;
	message: string;
};

export type NativeMacHelperErrorEvent = {
	event: "error";
	code: string;
	message: string;
};

export type NativeMacHelperEvent =
	| NativeMacHelperReadyEvent
	| NativeMacHelperRecordingStartedEvent
	| NativeMacHelperRecordingStoppedEvent
	| NativeMacHelperWarningEvent
	| NativeMacHelperErrorEvent;

export type NativeMacRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	screenStartedAtUnixMs?: number;
	error?: string;
};

/** Fail closed with old helpers: IPC delivery time is not a recording clock. */
export function requireNativeMacScreenStartTime(event: {
	screenStartedAtUnixMs?: unknown;
}): number {
	const value = event.screenStartedAtUnixMs;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new Error(
			"Native macOS capture helper did not report a valid first-frame clock. Rebuild or update the capture helper.",
		);
	}
	return value;
}

export function measureNativeMacWebcamOffsetSeconds(
	cameraStartedAtUnixMs: number,
	screenStartedAtUnixMs: number,
): number {
	if (!Number.isFinite(cameraStartedAtUnixMs) || cameraStartedAtUnixMs <= 0) {
		throw new Error("Webcam recorder did not report a valid start clock.");
	}
	const offset =
		(cameraStartedAtUnixMs - requireNativeMacScreenStartTime({ screenStartedAtUnixMs })) / 1000;
	if (Math.abs(offset) > 86400)
		throw new Error("Webcam start clock is outside the recording range.");
	return offset;
}

export function parseMacWindowIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("window:")) {
		return null;
	}

	const windowIdPart = sourceId.split(":")[1];
	if (!windowIdPart || !/^\d+$/.test(windowIdPart)) {
		return null;
	}

	return Number(windowIdPart);
}

export function parseMacDisplayIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("screen:")) {
		return null;
	}

	const displayIdPart = sourceId.split(":")[1];
	if (!displayIdPart || !/^\d+$/.test(displayIdPart)) {
		return null;
	}

	return Number(displayIdPart);
}
