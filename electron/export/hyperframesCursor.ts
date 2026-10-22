import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import appStarting from "../../src/assets/cursors/Cursor=App-Starting.svg?raw";
import crosshair from "../../src/assets/cursors/Cursor=Cross.svg?raw";
import arrow from "../../src/assets/cursors/Cursor=Default.svg?raw";
import closedHand from "../../src/assets/cursors/Cursor=Hand-(Grabbing).svg?raw";
import openHand from "../../src/assets/cursors/Cursor=Hand-(Open).svg?raw";
import pointer from "../../src/assets/cursors/Cursor=Hand-(Pointing).svg?raw";
import help from "../../src/assets/cursors/Cursor=Help.svg?raw";
import move from "../../src/assets/cursors/Cursor=Move.svg?raw";
import notAllowed from "../../src/assets/cursors/Cursor=Not-Allowed.svg?raw";
import resizeNesw from "../../src/assets/cursors/Cursor=Resize-North-East-South-West.svg?raw";
import resizeNs from "../../src/assets/cursors/Cursor=Resize-North-South.svg?raw";
import resizeNwse from "../../src/assets/cursors/Cursor=Resize-North-West-South-East.svg?raw";
import resizeEw from "../../src/assets/cursors/Cursor=Resize-West-East.svg?raw";
import text from "../../src/assets/cursors/Cursor=Text-Cursor.svg?raw";
import upArrow from "../../src/assets/cursors/Cursor=Up-Arrow.svg?raw";
import wait from "../../src/assets/cursors/Cursor=Wait.svg?raw";
import type { HyperframesCursorData } from "../../src/lib/exporter/hyperframesExporter";
import type {
	CursorRecordingData,
	CursorRecordingSample,
	NativeCursorAsset,
	NativeCursorType,
} from "../../src/native/contracts";

// The same bundled shapes/metrics used by the editor's native cursor adapter for telemetry-only recordings.
const telemetryAssets: Record<NativeCursorType, [string, number, number, number, number]> = {
	arrow: [arrow, 32, 32, 16.25, 15.03],
	text: [text, 32, 32, 16, 16],
	pointer: [pointer, 32, 33, 16.65, 14.24],
	crosshair: [crosshair, 32, 32, 16, 16],
	"open-hand": [openHand, 32, 32, 16, 9],
	"closed-hand": [closedHand, 32, 32, 16, 9],
	"resize-ew": [resizeEw, 32, 32, 16, 16],
	"resize-ns": [resizeNs, 32, 32, 16, 16],
	"resize-nesw": [resizeNesw, 32, 32, 16, 16],
	"resize-nwse": [resizeNwse, 32, 32, 16, 16],
	move: [move, 32, 32, 16, 16],
	"not-allowed": [notAllowed, 32, 32, 16, 16],
	wait: [wait, 32, 32, 16, 16],
	"app-starting": [appStarting, 32, 32, 7.25, 4.03],
	help: [help, 32, 32, 7.25, 4.03],
	"up-arrow": [upArrow, 32, 32, 16, 3],
};
const nativeCursorTypes = new Set(Object.keys(telemetryAssets));
function bounded(value: unknown, min: number, max: number, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
		throw new Error(`Invalid cursor ${label}`);
	return value;
}
function id(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value) || value.includes(".."))
		throw new Error("Invalid cursor asset ID");
	return value;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid cursor telemetry");
	return value as Record<string, unknown>;
}
function type(value: unknown): NativeCursorType | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !nativeCursorTypes.has(value))
		throw new Error("Invalid native cursor type");
	return value as NativeCursorType;
}
function pngBytes(asset: NativeCursorAsset): Buffer {
	const prefix = "data:image/png;base64,";
	if (!asset.imageDataUrl.startsWith(prefix) || asset.imageDataUrl.length > 3_000_000)
		throw new Error("Cursor assets must be bounded embedded PNGs, not paths or SVG scripts");
	const encoded = asset.imageDataUrl.slice(prefix.length);
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid cursor PNG encoding");
	const bytes = Buffer.from(encoded, "base64");
	if (
		bytes.length < 33 ||
		!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		bytes.toString("ascii", 12, 16) !== "IHDR" ||
		bytes.readUInt32BE(16) !== asset.width ||
		bytes.readUInt32BE(20) !== asset.height
	)
		throw new Error("Cursor PNG dimensions/signature do not match its asset");
	return bytes;
}

/** Strict validation: export never silently discards malformed requested telemetry. */
export function validateHyperframesCursorRecording(value: unknown): CursorRecordingData {
	const raw = object(value);
	if (
		(raw.provider !== "native" && raw.provider !== "none") ||
		!Array.isArray(raw.samples) ||
		!raw.samples.length ||
		raw.samples.length > 1_000_000 ||
		!Array.isArray(raw.assets) ||
		raw.assets.length > 256
	)
		throw new Error("Invalid or empty editable cursor telemetry");
	const ids = new Set<string>();
	const assets: NativeCursorAsset[] = raw.assets.map((candidate) => {
		const asset = object(candidate),
			assetId = id(asset.id);
		if (ids.has(assetId)) throw new Error("Duplicate cursor asset ID");
		ids.add(assetId);
		const width = bounded(asset.width, 1, 1024, "width"),
			height = bounded(asset.height, 1, 1024, "height");
		if (!Number.isInteger(width) || !Number.isInteger(height))
			throw new Error("Invalid cursor bitmap dimensions");
		if (typeof asset.imageDataUrl !== "string") throw new Error("Missing cursor image");
		if (asset.platform !== "darwin" && asset.platform !== "win32" && asset.platform !== "linux")
			throw new Error("Invalid cursor platform");
		const result: NativeCursorAsset = {
			id: assetId,
			platform: asset.platform,
			imageDataUrl: asset.imageDataUrl,
			width,
			height,
			hotspotX: bounded(asset.hotspotX, 0, width, "hotspot x"),
			hotspotY: bounded(asset.hotspotY, 0, height, "hotspot y"),
			scaleFactor:
				asset.scaleFactor === undefined ? 1 : bounded(asset.scaleFactor, 0.1, 8, "scale"),
			cursorType: type(asset.cursorType),
		};
		pngBytes(result);
		return result;
	});
	let previousTime = -1;
	const samples: CursorRecordingSample[] = raw.samples.map((candidate) => {
		const sample = object(candidate);
		const timeMs = bounded(sample.timeMs, 0, 86_400_000, "sample time");
		if (timeMs < previousTime) throw new Error("Cursor telemetry is not sorted by source time");
		previousTime = timeMs;
		if (sample.visible !== undefined && typeof sample.visible !== "boolean")
			throw new Error("Invalid cursor visibility");
		const assetId =
			sample.assetId === undefined || sample.assetId === null ? null : id(sample.assetId);
		if (assetId && !ids.has(assetId)) throw new Error("Requested cursor asset is missing");
		return {
			timeMs,
			cx: bounded(sample.cx, 0, 1, "x position"),
			cy: bounded(sample.cy, 0, 1, "y position"),
			assetId,
			visible: sample.visible !== false,
			cursorType: type(sample.cursorType),
		};
	});
	return { version: 2, provider: raw.provider, assets, samples };
}

/** Called only after main-process media approval. Sidecar location is derived, never supplied by IPC. */
export async function prepareHyperframesCursor(
	approvedScreenPath: string,
	assetsDirectory: string,
): Promise<HyperframesCursorData> {
	const sidecar = `${approvedScreenPath}.cursor.json`;
	let handle: Awaited<ReturnType<typeof fs.open>>;
	try {
		const stat = await fs.lstat(sidecar);
		if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024 * 1024)
			throw new Error("Invalid cursor sidecar file");
		handle = await fs.open(sidecar, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		throw new Error(
			`Cannot read the requested editable cursor sidecar: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
	const recording = validateHyperframesCursorRecording(raw);
	const result: HyperframesCursorData = {
		samples: recording.samples.map((sample) => ({ ...sample })),
		assets: [],
	};
	for (const asset of recording.assets) {
		const file = `cursor-${result.assets.length + 1}.png`;
		await fs.writeFile(path.join(assetsDirectory, file), pngBytes(asset), { flag: "wx" });
		const { imageDataUrl: _image, platform: _platform, cursorType: _type, ...metrics } = asset;
		result.assets.push({ ...metrics, src: `assets/${file}` });
	}
	const fallback = new Set(
		result.samples
			.filter((sample) => !sample.assetId)
			.map((sample) => sample.cursorType ?? "arrow"),
	);
	for (const cursorType of fallback) {
		const [source, width, height, hotspotX, hotspotY] = telemetryAssets[cursorType];
		const file = `cursor-${result.assets.length + 1}.svg`,
			assetId = `telemetry-${cursorType}`;
		if (result.assets.some((asset) => asset.id === assetId))
			throw new Error("Cursor fallback asset ID collision");
		await fs.writeFile(path.join(assetsDirectory, file), source, { flag: "wx" });
		result.assets.push({
			id: assetId,
			src: `assets/${file}`,
			width,
			height,
			hotspotX,
			hotspotY,
			scaleFactor: 1,
		});
		for (const sample of result.samples)
			if (!sample.assetId && (sample.cursorType ?? "arrow") === cursorType)
				sample.assetId = assetId;
	}
	return result;
}
