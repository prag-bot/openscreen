import { gsap } from "gsap";
import { describe, expect, it } from "vitest";
import {
	buildHyperframesCursorKeyframes,
	buildKeptClipSegments,
	createHyperframesComposition,
	type HyperframesExportRequest,
	mapKeptClipsToMedia,
	validateHyperframesExportRequest,
} from "./hyperframesExporter";

export const hyperframesRequest: HyperframesExportRequest = {
	screenVideoPath: "/recording.webm",
	durationSeconds: 2,
	width: 640,
	height: 480,
	trimRegions: [{ id: "trim-1", startMs: 500, endMs: 1000 }],
	webcamLayoutPreset: "picture-in-picture",
	webcamSizePreset: 25,
	webcamPosition: { cx: 0.8, cy: 0.8 },
	webcamMaskShape: "circle",
	webcamMirrored: true,
};

const screen = { src: "assets/screen.webm", width: 640, height: 480, durationSeconds: 2 };

describe("HyperFrames cursor cut clock", () => {
	const samples = [
		{ timeMs: 0, cx: 0, cy: 0.2, assetId: "arrow", visible: true },
		{ timeMs: 700, cx: 0.7, cy: 0.8, assetId: "arrow", visible: false },
		{ timeMs: 1200, cx: 0.8, cy: 0.9, assetId: "arrow", visible: true },
	];
	it("seeks to state inside removed footage at a join, without replaying the removed motion", () => {
		const frames = buildHyperframesCursorKeyframes(
			samples,
			buildKeptClipSegments(2, hyperframesRequest.trimRegions),
		);
		expect(frames.map((frame) => [frame.timeSeconds, frame.sample.visible])).toEqual([
			[0, true],
			[0.5, true],
			[0.5, false],
			[0.7, true],
			[1.5, true],
		]);
		expect(frames[2].sample.cx).toBe(0.7);
		expect(frames[2].cut).toBe(true);
	});
	it("emits native assets as editable, escaped images with seek-safe opacity states", () => {
		const { html } = createHyperframesComposition(
			{
				...hyperframesRequest,
				cursorCaptureMode: "editable-overlay",
				showCursor: true,
				cursorSize: 1,
			},
			{
				screen,
				audio: [],
				cursor: {
					samples,
					assets: [
						{
							id: "arrow",
							src: "assets/cursor-1.png",
							width: 32,
							height: 32,
							hotspotX: 2,
							hotspotY: 3,
						},
					],
				},
			},
		);
		expect(html).toContain('src="assets/cursor-1.png"');
		expect(html).toContain('class="cursor-layer"');
		expect(html).toContain('tl.set("#cursor-1", {opacity:0}, 0.5)');
		expect(html).not.toMatch(/requestAnimationFrame|\.play\(|currentTime\s*=/);
	});
	it("never renders an overlay over a burned-in system cursor or when hidden", () => {
		for (const patch of [
			{ cursorCaptureMode: "system" as const, showCursor: true },
			{ cursorCaptureMode: "editable-overlay" as const, showCursor: false },
		]) {
			const { html } = createHyperframesComposition(
				{ ...hyperframesRequest, ...patch },
				{
					screen,
					audio: [],
					cursor: {
						samples,
						assets: [
							{
								id: "arrow",
								src: "assets/cursor-1.png",
								width: 32,
								height: 32,
								hotspotX: 2,
								hotspotY: 3,
							},
						],
					},
				},
			);
			expect(html).not.toContain('class="cursor-layer"');
		}
	});
	it("reproduces visibility and position after arbitrary forward/backward GSAP seeks", () => {
		const { html } = createHyperframesComposition(
			{
				...hyperframesRequest,
				cursorCaptureMode: "editable-overlay",
				showCursor: true,
				cursorSize: 1,
			},
			{
				screen,
				audio: [],
				cursor: {
					samples,
					assets: [
						{
							id: "arrow",
							src: "assets/cursor-1.png",
							width: 32,
							height: 32,
							hotspotX: 2,
							hotspotY: 3,
						},
					],
				},
			},
		);
		const previousBody = document.body.innerHTML;
		const parsed = new DOMParser().parseFromString(html, "text/html");
		document.body.innerHTML = parsed.body.innerHTML;
		const script = parsed.querySelectorAll("script")[1].textContent;
		const timeline = new Function("gsap", `${script}; return window.__timelines.openscreen;`)(
			gsap,
		) as gsap.core.Timeline;
		try {
			for (const [time, visible] of [
				[0.8, true],
				[0.5, false],
				[0.3, true],
				[0.65, false],
				[0.1, true],
			] as const) {
				timeline.seek(time, false);
				expect(document.getElementById("cursor-1")?.style.opacity, `at ${time}`).toBe(
					visible ? "1" : "0",
				);
			}
			timeline.seek(0.8, false);
			const position = document.getElementById("cursor-1")?.style.transform;
			timeline.seek(0.1, false);
			timeline.seek(0.8, false);
			expect(document.getElementById("cursor-1")?.style.transform).toBe(position);
		} finally {
			timeline.kill();
			document.body.innerHTML = previousBody;
		}
	});
	it("jumps to the new source position at a visible cut, including backward seeks to the exact boundary", () => {
		const { html } = createHyperframesComposition(
			{
				...hyperframesRequest,
				cursorCaptureMode: "editable-overlay",
				showCursor: true,
				cursorSize: 1,
			},
			{
				screen,
				audio: [],
				cursor: {
					samples: samples.map((sample) => ({ ...sample, visible: true })),
					assets: [
						{
							id: "arrow",
							src: "assets/cursor-1.png",
							width: 32,
							height: 32,
							hotspotX: 2,
							hotspotY: 3,
						},
					],
				},
			},
		);
		const previousBody = document.body.innerHTML;
		const parsed = new DOMParser().parseFromString(html, "text/html");
		document.body.innerHTML = parsed.body.innerHTML;
		const timeline = new Function(
			"gsap",
			`${parsed.querySelectorAll("script")[1].textContent}; return window.__timelines.openscreen;`,
		)(gsap) as gsap.core.Timeline;
		try {
			for (const from of [0.8, 0.1, 1.4]) {
				timeline.seek(from, false);
				timeline.seek(0.5, false);
				expect(Number(gsap.getProperty(document.getElementById("cursor-1"), "x"))).toBeCloseTo(
					484.4,
					2,
				);
			}
		} finally {
			timeline.kill();
			document.body.innerHTML = previousBody;
		}
	});
});

describe("HyperFrames segment mapping", () => {
	it("converts millisecond REMOVALS into second-based kept clips", () => {
		expect(buildKeptClipSegments(2, hyperframesRequest.trimRegions)).toEqual([
			{ sourceStart: 0, timelineStart: 0, duration: 0.5 },
			{ sourceStart: 1, timelineStart: 0.5, duration: 1 },
		]);
	});

	it("merges unsorted, nested, overlapping and touching removals without resurrecting footage", () => {
		const ranges = [
			[7000, 8000],
			[3000, 5000],
			[2000, 4000],
			[2500, 2800],
			[5000, 6000],
		];
		expect(
			buildKeptClipSegments(
				10,
				ranges.map(([startMs, endMs]) => ({ id: "", startMs, endMs })),
			),
		).toEqual([
			{ sourceStart: 0, timelineStart: 0, duration: 2 },
			{ sourceStart: 6, timelineStart: 2, duration: 1 },
			{ sourceStart: 8, timelineStart: 3, duration: 2 },
		]);
	});

	it("clamps out-of-bounds removals and ignores empty ranges", () => {
		expect(
			buildKeptClipSegments(2, [
				{ id: "", startMs: -200, endMs: 300 },
				{ id: "", startMs: 500, endMs: 500 },
				{ id: "", startMs: 1800, endMs: 9000 },
			]),
		).toEqual([{ sourceStart: 0.3, timelineStart: 0, duration: 1.5 }]);
	});

	it("keeps the full recording without trims and does not mutate trim state", () => {
		expect(buildKeptClipSegments(2, [])).toEqual([
			{ sourceStart: 0, timelineStart: 0, duration: 2 },
		]);
		const input = structuredClone(hyperframesRequest.trimRegions);
		buildKeptClipSegments(2, input);
		expect(input).toEqual(hyperframesRequest.trimRegions);
	});

	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		86401,
	])("rejects invalid duration %s", (duration) => {
		expect(() => buildKeptClipSegments(duration, [])).toThrow(/duration/i);
	});

	it("rejects invalid ranges and a completely removed recording", () => {
		expect(() => buildKeptClipSegments(2, [{ id: "", startMs: 500, endMs: 200 }])).toThrow();
		expect(() => buildKeptClipSegments(2, [{ id: "", startMs: 0, endMs: 2000 }])).toThrow(
			/All footage/,
		);
		expect(() =>
			buildKeptClipSegments(2, [{ id: "", startMs: Number.NaN, endMs: 2000 }]),
		).toThrow();
	});

	it("applies delayed camera source offsets after trimming while retaining gaps", () => {
		const kept = buildKeptClipSegments(2, hyperframesRequest.trimRegions);
		expect(mapKeptClipsToMedia(kept, 0.2, 1.5)).toEqual([
			{ sourceStart: 0, timelineStart: 0.2, duration: 0.3 },
			{ sourceStart: 0.8, timelineStart: 0.5, duration: 0.7 },
		]);
	});

	it("handles a camera starting earlier and one starting inside a removed region", () => {
		const kept = buildKeptClipSegments(2, hyperframesRequest.trimRegions);
		expect(mapKeptClipsToMedia(kept, -0.25, 2.25)).toEqual([
			{ sourceStart: 0.25, timelineStart: 0, duration: 0.5 },
			{ sourceStart: 1.25, timelineStart: 0.5, duration: 1 },
		]);
		expect(mapKeptClipsToMedia(kept, 0.75, 1.25)).toEqual([
			{ sourceStart: 0.25, timelineStart: 0.5, duration: 1 },
		]);
		expect(mapKeptClipsToMedia(kept, 4, 2)).toEqual([]);
	});
});

describe("HyperFrames HTML contract", () => {
	it("counts surviving audio tracks once even across multiple retained clips", () => {
		const composition = createHyperframesComposition(hyperframesRequest, {
			screen,
			audio: [
				{ src: "assets/full-audio.webm", offsetSeconds: 0, durationSeconds: 2 },
				{ src: "assets/removed-audio.webm", offsetSeconds: 0.5, durationSeconds: 0.5 },
			],
		});
		const document = new DOMParser().parseFromString(composition.html, "text/html");
		expect(composition.audioTrackCount).toBe(1);
		expect(document.querySelectorAll("audio")).toHaveLength(2);
		expect(document.querySelectorAll('audio[src="assets/removed-audio.webm"]')).toHaveLength(0);
	});

	it("sizes the root and synchronously registers its exact paused timeline with local GSAP", () => {
		const { html, durationSeconds } = createHyperframesComposition(hyperframesRequest, {
			screen,
			audio: [],
		});
		const document = new DOMParser().parseFromString(html, "text/html");
		const root = document.querySelector("[data-composition-id]");
		expect(root?.parentElement?.tagName).toBe("BODY");
		expect(root?.getAttribute("data-duration")).toBe("1.5");
		expect(root?.getAttribute("data-start")).toBe("0");
		expect(root?.getAttribute("data-width")).toBe("640");
		expect(root?.getAttribute("data-height")).toBe("480");
		expect(html).toContain("width:640px; height:480px");
		expect(html).toContain('window.__timelines["openscreen"] = gsap.timeline({ paused: true })');
		expect(html).toContain('src="vendor/gsap.min.js"');
		expect(html).not.toMatch(/\.play\(|\.pause\(|currentTime\s*=|https?:\/\//);
		expect(durationSeconds).toBe(1.5);
		expect(root?.querySelectorAll("video")).toHaveLength(2);
		expect(root?.querySelector(".webcam")).toBeNull();
	});

	it("keeps all timed media as direct root children with matching screen/audio offsets", () => {
		const { html } = createHyperframesComposition(hyperframesRequest, {
			screen,
			webcam: { ...screen, src: "assets/webcam.webm" },
			audio: [{ src: "assets/screen-audio-1.webm", offsetSeconds: 0, durationSeconds: 2 }],
		});
		const document = new DOMParser().parseFromString(html, "text/html");
		const root = document.getElementById("openscreen");
		for (const element of document.querySelectorAll("video,audio")) {
			expect(element.parentElement).toBe(root);
			for (const key of [
				"id",
				"data-start",
				"data-duration",
				"data-track-index",
				"data-media-start",
			]) {
				expect(element.hasAttribute(key)).toBe(true);
			}
			if (element.tagName === "VIDEO") {
				expect(element.hasAttribute("muted")).toBe(true);
				expect(element.hasAttribute("playsinline")).toBe(true);
			}
		}
		expect(root?.querySelectorAll("video")).toHaveLength(4);
		expect(root?.querySelectorAll("audio")).toHaveLength(2);
		expect(document.getElementById("screen-2")?.getAttribute("data-media-start")).toBe("1");
		expect(document.getElementById("audio-1-2")?.getAttribute("data-media-start")).toBe("1");
		expect(html).toContain("clip-path:circle(50% at 50% 50%)");
		expect(html).toContain("transform:scaleX(-1)");
	});

	it("omits hidden camera clips entirely instead of relying on opacity", () => {
		const { html } = createHyperframesComposition(
			{ ...hyperframesRequest, webcamLayoutPreset: "no-webcam" },
			{
				screen,
				webcam: { ...screen, src: "assets/webcam.webm" },
				audio: [],
			},
		);
		expect(html).not.toContain('id="webcam-');
		expect(html).not.toContain('src="assets/webcam.webm"');
	});

	it("escapes media names and prevents HTML/script injection", () => {
		const malicious = 'assets/a" onerror="alert(1)<script>&\'.webm';
		const { html } = createHyperframesComposition(hyperframesRequest, {
			screen: { ...screen, src: malicious },
			audio: [],
		});
		const document = new DOMParser().parseFromString(html, "text/html");
		expect(document.querySelector("video")?.getAttribute("src")).toBe(malicious);
		expect(document.querySelector("video")?.hasAttribute("onerror")).toBe(false);
		expect(document.querySelectorAll("script")).toHaveLength(2);
	});
});

describe("reviewed presentation switches", () => {
	const webcam = { ...screen, src: "assets/webcam.webm", durationSeconds: 4 };
	const face = { id: "face", startMs: 500, endMs: 2500, mode: "face-only" as const };
	const demo = { id: "demo", startMs: 2500, endMs: 3500, mode: "demo" as const };

	it("splits visuals on source-time switches across a removed range without splitting audio", () => {
		const composition = createHyperframesComposition(
			{
				...hyperframesRequest,
				durationSeconds: 4,
				trimRegions: [{ id: "cut", startMs: 1000, endMs: 2000 }],
				presentationRegions: [face, demo],
			},
			{
				screen: { ...screen, durationSeconds: 4 },
				webcam,
				audio: [{ src: "assets/voice.webm", offsetSeconds: 0, durationSeconds: 4 }],
			},
		);
		expect(composition.durationSeconds).toBe(3);
		expect(composition.visualSegments).toEqual([
			{ sourceStart: 0, timelineStart: 0, duration: 0.5, mode: "legacy" },
			{
				sourceStart: 0.5,
				timelineStart: 0.5,
				duration: 0.5,
				mode: "face-only",
				requestedMode: "face-only",
			},
			{
				sourceStart: 2,
				timelineStart: 1,
				duration: 0.5,
				mode: "face-only",
				requestedMode: "face-only",
			},
			{ sourceStart: 2.5, timelineStart: 1.5, duration: 1, mode: "demo", requestedMode: "demo" },
			{ sourceStart: 3.5, timelineStart: 2.5, duration: 0.5, mode: "legacy" },
		]);
		const doc = new DOMParser().parseFromString(composition.html, "text/html");
		expect(doc.querySelectorAll("video.screen")).toHaveLength(3);
		expect(doc.querySelectorAll("video.webcam-face-only")).toHaveLength(2);
		expect(doc.querySelectorAll("audio")).toHaveLength(2);
		expect(doc.getElementById("audio-1-2")?.getAttribute("data-media-start")).toBe("2");
		for (const element of doc.querySelectorAll("video,audio"))
			expect(element.parentElement?.id).toBe("openscreen");
		expect(composition.html).toContain(
			".webcam-face-only { left:0;top:0;width:640px;height:480px;opacity:1;border-radius:0;clip-path:none;",
		);
	});

	it("explicit demo restores a bottom-right camera even when the legacy layout hides it", () => {
		const { html } = createHyperframesComposition(
			{
				...hyperframesRequest,
				webcamLayoutPreset: "no-webcam",
				webcamPosition: { cx: 0.1, cy: 0.1 },
				presentationRegions: [{ ...demo, startMs: 0, endMs: 2000 }],
			},
			{ screen, webcam, audio: [] },
		);
		const doc = new DOMParser().parseFromString(html, "text/html");
		expect(doc.querySelectorAll(".webcam-demo")).toHaveLength(2);
		expect(html).toContain(".webcam-demo { left:526px;top:366px;width:104px;height:104px");
	});

	it.each([
		{
			offset: 1,
			cameraDuration: 2,
			expected: [
				[0, 1, "demo"],
				[1, 2, "face-only"],
				[3, 1, "demo"],
			],
		},
		{
			offset: -1,
			cameraDuration: 3,
			expected: [
				[0, 2, "face-only"],
				[2, 2, "demo"],
			],
		},
	])("falls back to demo only outside camera availability at offset $offset", ({
		offset,
		cameraDuration,
		expected,
	}) => {
		const composition = createHyperframesComposition(
			{
				...hyperframesRequest,
				durationSeconds: 4,
				trimRegions: [],
				webcamOffsetSeconds: offset,
				presentationRegions: [{ ...face, startMs: 0, endMs: 4000 }],
			},
			{
				screen: { ...screen, durationSeconds: 4 },
				webcam: { ...webcam, durationSeconds: cameraDuration },
				audio: [],
			},
		);
		expect(
			composition.visualSegments.map((segment) => [
				segment.sourceStart,
				segment.duration,
				segment.mode,
			]),
		).toEqual(expected);
		expect(composition.warnings).toHaveLength(1);
		expect(composition.warnings[0]).toMatch(/2 seconds.*demo layout/);
		const doc = new DOMParser().parseFromString(composition.html, "text/html");
		expect(doc.querySelectorAll(".webcam-face-only")).toHaveLength(1);
		expect(doc.querySelectorAll(".screen-demo")).toHaveLength(offset === 1 ? 2 : 1);
		expect(Number(doc.querySelector(".webcam-face-only")?.getAttribute("data-media-start"))).toBe(
			offset === 1 ? 0 : 1,
		);
	});

	it("rejects face-only without a camera, and needs no cursor telemetry when every kept visual is face-only", () => {
		const request = {
			...hyperframesRequest,
			cursorCaptureMode: "editable-overlay" as const,
			showCursor: true,
			presentationRegions: [{ ...face, startMs: 0, endMs: 2000 }],
		};
		expect(() => createHyperframesComposition(request, { screen, audio: [] })).toThrow(
			/requires recorded webcam/,
		);
		const composition = createHyperframesComposition(request, { screen, webcam, audio: [] });
		const doc = new DOMParser().parseFromString(composition.html, "text/html");
		expect(doc.querySelector(".screen")).toBeNull();
		expect(doc.querySelector(".cursor-layer")).toBeNull();
		expect(doc.querySelectorAll(".webcam-face-only")).toHaveLength(2);
	});

	it("restores the correct cursor layer after arbitrary backward seeks and exact mode/cut boundaries", () => {
		const { html } = createHyperframesComposition(
			{
				...hyperframesRequest,
				cursorCaptureMode: "editable-overlay",
				showCursor: true,
				presentationRegions: [
					{ ...face, startMs: 250, endMs: 1250 },
					{ ...demo, startMs: 1250, endMs: 1750 },
				],
			},
			{
				screen,
				webcam,
				audio: [],
				cursor: {
					samples: [
						{ timeMs: 0, cx: 0.1, cy: 0.2, assetId: "arrow", visible: true },
						{ timeMs: 2000, cx: 0.9, cy: 0.8, assetId: "arrow", visible: true },
					],
					assets: [
						{
							id: "arrow",
							src: "assets/cursor.png",
							width: 32,
							height: 32,
							hotspotX: 0,
							hotspotY: 0,
						},
					],
				},
			},
		);
		const previousBody = document.body.innerHTML;
		const parsed = new DOMParser().parseFromString(html, "text/html");
		document.body.innerHTML = parsed.body.innerHTML;
		const timeline = new Function(
			"gsap",
			`${parsed.querySelectorAll("script")[1].textContent}; return window.__timelines.openscreen;`,
		)(gsap) as gsap.core.Timeline;
		try {
			for (const [time, legacy, demoVisible] of [
				[0.8, 0, 1],
				[0.25, 0, 0],
				[0.2, 1, 0],
				[0.75, 0, 1],
				[1.25, 1, 0],
				[0.5, 0, 0],
				[0.1, 1, 0],
			] as const) {
				timeline.seek(time, false);
				expect(document.getElementById("cursor-layer")?.style.opacity, `legacy at ${time}`).toBe(
					String(legacy),
				);
				expect(document.getElementById("cursor-demo-layer")?.style.opacity, `demo at ${time}`).toBe(
					String(demoVisible),
				);
			}
		} finally {
			timeline.kill();
			document.body.innerHTML = previousBody;
		}
	});

	it("forces an editable cursor only in reviewed demo intervals when the global cursor is hidden", () => {
		const request = {
			...hyperframesRequest,
			cursorCaptureMode: "editable-overlay" as const,
			showCursor: false,
			presentationRegions: [
				{ ...face, startMs: 250, endMs: 1250 },
				{ ...demo, startMs: 1250, endMs: 1750 },
			],
		};
		const media = {
			screen,
			webcam,
			audio: [],
			cursor: {
				samples: [{ timeMs: 0, cx: 0.2, cy: 0.3, assetId: "arrow", visible: true }],
				assets: [
					{
						id: "arrow",
						src: "assets/cursor.png",
						width: 32,
						height: 32,
						hotspotX: 0,
						hotspotY: 0,
					},
				],
			},
		};
		const { html } = createHyperframesComposition(request, media);
		const previousBody = document.body.innerHTML;
		const parsed = new DOMParser().parseFromString(html, "text/html");
		expect(parsed.getElementById("cursor-layer")).toBeNull();
		document.body.innerHTML = parsed.body.innerHTML;
		const timeline = new Function(
			"gsap",
			`${parsed.querySelectorAll("script")[1].textContent}; return window.__timelines.openscreen;`,
		)(gsap) as gsap.core.Timeline;
		try {
			for (const [time, visible] of [
				[0.8, 1],
				[0.1, 0],
				[0.75, 1],
				[1.25, 0],
				[0.5, 0],
				[0.9, 1],
				[0.2, 0],
			] as const) {
				timeline.seek(time, false);
				expect(document.getElementById("cursor-demo-layer")?.style.opacity, `demo at ${time}`).toBe(
					String(visible),
				);
			}
		} finally {
			timeline.kill();
			document.body.innerHTML = previousBody;
		}
		expect(() => createHyperframesComposition(request, { ...media, cursor: undefined })).toThrow(
			/telemetry is missing/,
		);
		const system = createHyperframesComposition(
			{ ...request, cursorCaptureMode: "system" },
			{ ...media, cursor: undefined },
		);
		expect(
			new DOMParser().parseFromString(system.html, "text/html").querySelector(".cursor-layer"),
		).toBeNull();
	});

	it("drops only floating-point boundary dust without creating a legacy tail or changing audio", () => {
		const request = {
			...hyperframesRequest,
			durationSeconds: 10.930000000000001,
			trimRegions: [],
			cursorCaptureMode: "editable-overlay" as const,
			showCursor: true,
			presentationRegions: [{ ...demo, startMs: 0, endMs: 10930 }],
		};
		const media = {
			screen: { ...screen, durationSeconds: request.durationSeconds },
			webcam: { ...webcam, durationSeconds: 11 },
			audio: [
				{ src: "assets/voice.webm", offsetSeconds: 0, durationSeconds: request.durationSeconds },
			],
			cursor: {
				samples: [{ timeMs: 0, cx: 0.2, cy: 0.3, assetId: "arrow", visible: true }],
				assets: [
					{
						id: "arrow",
						src: "assets/cursor.png",
						width: 32,
						height: 32,
						hotspotX: 0,
						hotspotY: 0,
					},
				],
			},
		};
		const composition = createHyperframesComposition(request, media);
		expect(composition.visualSegments).toEqual([
			{ sourceStart: 0, timelineStart: 0, duration: 10.93, mode: "demo", requestedMode: "demo" },
		]);
		expect(composition.segments).toEqual([
			{ sourceStart: 0, timelineStart: 0, duration: request.durationSeconds },
		]);
		const doc = new DOMParser().parseFromString(composition.html, "text/html");
		expect(doc.getElementById("cursor-layer")).toBeNull();
		expect(doc.getElementById("cursor-demo-layer")).not.toBeNull();
		expect(doc.querySelector('[data-duration="0"]')).toBeNull();
		expect(doc.querySelectorAll("audio")).toHaveLength(1);
		const short = createHyperframesComposition(
			{
				...request,
				presentationRegions: [
					{ ...demo, startMs: 0, endMs: 0.001 },
					{ ...face, startMs: 0.001, endMs: 10930 },
				],
			},
			media,
		);
		expect(short.visualSegments).toHaveLength(2);
		expect(short.visualSegments[0].duration).toBe(0.000001);
	});

	it("preserves legacy clip behavior when presentation choices are absent or empty", () => {
		const media = { screen, webcam, audio: [] };
		expect(createHyperframesComposition(hyperframesRequest, media)).toEqual(
			createHyperframesComposition({ ...hyperframesRequest, presentationRegions: [] }, media),
		);
	});
});

describe("HyperFrames IPC payload validation", () => {
	it("accepts a screen-only request and validates each layout/mask", () => {
		expect(validateHyperframesExportRequest(hyperframesRequest).screenVideoPath).toBe(
			"/recording.webm",
		);
		for (const layout of ["no-webcam", "dual-frame", "vertical-stack", "picture-in-picture"]) {
			expect(
				validateHyperframesExportRequest({ ...hyperframesRequest, webcamLayoutPreset: layout })
					.webcamLayoutPreset,
			).toBe(layout);
		}
	});

	it.each([
		{ width: Number.NaN },
		{ height: -1 },
		{ width: 99999 },
		{ width: 3.5 },
		{ webcamSizePreset: 100 },
		{ webcamOffsetSeconds: Number.NaN },
		{ webcamPosition: { cx: 2, cy: 0 } },
		{ webcamPosition: {} },
		{ webcamMirrored: "true" },
		{ webcamLayoutPreset: "injected" },
		{ webcamMaskShape: "injected" },
		{ trimRegions: null },
		{ screenVideoPath: "" },
		{ screenVideoPath: "\0" },
		{ webcamVideoPath: "" },
		{ originalScreenVideoPath: "\0" },
		{ cursorCaptureMode: "made-up" },
		{ showCursor: "true" },
		{ cursorSize: 0 },
		{ cursorSize: Infinity },
		{ cursorClipToBounds: "true" },
		{ durationSeconds: 0 },
		{ presentationRegions: null },
		{ presentationRegions: [{ id: "bad", startMs: -1, endMs: 500, mode: "face-only" }] },
		{ presentationRegions: [{ id: "bad", startMs: 0, endMs: 2001, mode: "face-only" }] },
		{ presentationRegions: [{ id: "bad", startMs: 0, endMs: 500, mode: "injected" }] },
		{
			presentationRegions: [
				{ id: "bad", startMs: 0, endMs: 1500, mode: "demo" },
				{ id: "overlap", startMs: 1000, endMs: 2000, mode: "face-only" },
			],
		},
	])("rejects malformed values %s", (patch) => {
		expect(() => validateHyperframesExportRequest({ ...hyperframesRequest, ...patch })).toThrow();
	});
});
