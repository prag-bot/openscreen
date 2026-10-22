// @vitest-environment node
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareHyperframesCursor, validateHyperframesCursorRecording } from "./hyperframesCursor";

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
export const cursorRecording = {
	version: 2,
	provider: "native",
	samples: [
		{ timeMs: 0, cx: 0.1, cy: 0.2, visible: true, assetId: "native-arrow" },
		{ timeMs: 700, cx: 0.7, cy: 0.8, visible: false, assetId: "native-arrow" },
		{ timeMs: 1200, cx: 0.8, cy: 0.9, visible: true, assetId: "native-arrow" },
	],
	assets: [
		{
			id: "native-arrow",
			platform: "darwin",
			imageDataUrl: `data:image/png;base64,${png}`,
			width: 1,
			height: 1,
			hotspotX: 0,
			hotspotY: 0,
		},
	],
};
describe("approved native editable cursor export", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "openscreen-cursor-test-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	it("copies validated native PNGs using generated names, not asset IDs as paths", async () => {
		const screen = path.join(directory, "screen.mp4");
		await writeFile(`${screen}.cursor.json`, JSON.stringify(cursorRecording));
		const cursor = await prepareHyperframesCursor(screen, directory);
		expect(cursor.samples).toHaveLength(3);
		expect(cursor.assets[0].src).toBe("assets/cursor-1.png");
		expect(await readFile(path.join(directory, "cursor-1.png"))).toEqual(
			Buffer.from(png, "base64"),
		);
	});
	it.each([
		{ samples: [{ ...cursorRecording.samples[0], cx: Infinity }] },
		{ samples: [{ ...cursorRecording.samples[0], visible: "false" }] },
		{ samples: [{ ...cursorRecording.samples[0], assetId: "missing" }] },
		{ assets: [{ ...cursorRecording.assets[0], id: "../../outside" }] },
		{
			assets: [
				{
					...cursorRecording.assets[0],
					imageDataUrl: 'data:image/svg+xml,<svg onload="alert(1)"/>',
				},
			],
		},
		{ assets: [{ ...cursorRecording.assets[0], imageDataUrl: "file:///etc/passwd" }] },
		{ assets: [{ ...cursorRecording.assets[0], width: 4 }] },
	])("fails malformed or injectable cursor data, instead of silently dropping it", (patch) => {
		expect(() => validateHyperframesCursorRecording({ ...cursorRecording, ...patch })).toThrow();
	});
	it("refuses symlinked cursor sidecars and missing requested telemetry", async () => {
		const sidecar = path.join(directory, "screen.mp4.cursor.json");
		const other = path.join(directory, "other.json");
		await writeFile(other, JSON.stringify(cursorRecording));
		await symlink(other, sidecar);
		await expect(
			prepareHyperframesCursor(path.join(directory, "screen.mp4"), directory),
		).rejects.toThrow(/sidecar/i);
		await expect(
			prepareHyperframesCursor(path.join(directory, "missing.mp4"), directory),
		).rejects.toThrow(/cursor/i);
	});
	it("reuses trusted editor shapes for recorded telemetry without native bitmaps", async () => {
		const screen = path.join(directory, "screen.mp4");
		await writeFile(
			`${screen}.cursor.json`,
			JSON.stringify({
				version: 2,
				provider: "none",
				samples: [{ timeMs: 0, cx: 0.3, cy: 0.4, visible: true, cursorType: "arrow" }],
				assets: [],
			}),
		);
		const cursor = await prepareHyperframesCursor(screen, directory);
		expect(cursor.samples[0].assetId).toBe("telemetry-arrow");
		expect(cursor.assets[0].src).toBe("assets/cursor-1.svg");
		expect(await readFile(path.join(directory, "cursor-1.svg"), "utf8")).toContain("<svg");
	});
});
