import { describe, expect, it } from "vitest";
import {
	createProjectSnapshot,
	resolveProjectMedia,
} from "../components/video-editor/projectPersistence";
import {
	normalizeProjectMedia,
	normalizeRecordingSession,
	normalizeWebcamOffsetSeconds,
} from "./recordingSession";

describe("webcam clock persistence", () => {
	it("retains the immutable capture across session and project round trips", () => {
		const media = {
			screenVideoPath: "/screen-playback.mp4",
			originalScreenVideoPath: " /screen.mp4 ",
			webcamVideoPath: "/camera.webm",
			webcamOffsetSeconds: -0.125,
			cursorCaptureMode: "editable-overlay",
		};
		const session = normalizeRecordingSession({ ...media, createdAt: 1234 })!;
		expect(session).toMatchObject({ ...media, originalScreenVideoPath: "/screen.mp4" });
		expect(resolveProjectMedia(JSON.parse(createProjectSnapshot(session, {})))).toEqual({
			...media,
			originalScreenVideoPath: "/screen.mp4",
		});
		expect(
			normalizeProjectMedia({ screenVideoPath: "/screen.mp4", originalScreenVideoPath: " " }),
		).toEqual({ screenVideoPath: "/screen.mp4" });
	});
	it.each([
		-1.25, 1.25, 0,
	])("round trips signed offset %s through session and project JSON", (webcamOffsetSeconds) => {
		const session = normalizeRecordingSession(
			JSON.parse(
				JSON.stringify({
					screenVideoPath: "/screen.mp4",
					webcamVideoPath: "/camera.webm",
					webcamOffsetSeconds,
					createdAt: 1234,
				}),
			),
		)!;
		expect(session.webcamOffsetSeconds).toBe(webcamOffsetSeconds);
		const project = JSON.parse(createProjectSnapshot(session, {}));
		expect(resolveProjectMedia(project)?.webcamOffsetSeconds).toBe(webcamOffsetSeconds);
	});
	it("defaults legacy camera sessions/projects to zero without rewriting them", () => {
		const media = { screenVideoPath: "/screen.mp4", webcamVideoPath: "/camera.webm" };
		const session = normalizeRecordingSession({ ...media, createdAt: 1234 })!;
		expect(session).toEqual({ ...media, createdAt: 1234 });
		expect(normalizeWebcamOffsetSeconds(session.webcamOffsetSeconds)).toBe(0);
		expect(
			normalizeWebcamOffsetSeconds(
				resolveProjectMedia(JSON.parse(createProjectSnapshot(media, {})))?.webcamOffsetSeconds,
			),
		).toBe(0);
	});
	it("does not retain a stale offset when the next media has no camera", () => {
		expect(normalizeProjectMedia({ screenVideoPath: "/new.mp4", webcamOffsetSeconds: -2 })).toEqual(
			{ screenVideoPath: "/new.mp4" },
		);
		expect(
			normalizeWebcamOffsetSeconds(
				normalizeProjectMedia({
					screenVideoPath: "/legacy.mp4",
					webcamVideoPath: "/new-camera.webm",
				})?.webcamOffsetSeconds,
			),
		).toBe(0);
	});
	it.each([NaN, Infinity, "1", 86401, null])("safely defaults invalid saved offset %s", (value) => {
		expect(normalizeWebcamOffsetSeconds(value)).toBe(0);
	});
});
