import type { TrimRegion } from "../components/video-editor/types";
import type { AutoEditPlan } from "./autoEdit";
import { buildKeptClipSegments } from "./exporter/hyperframesExporter";

/** One undoable trim update; never rewrites media or loses manual cuts. */
export function buildAutoEditTrims(
	plan: AutoEditPlan,
	duration: number,
	existing: TrimRegion[],
	nextId: number,
): { trims: TrimRegion[]; nextId: number } {
	if (
		!Number.isFinite(plan.originalDurationSeconds) ||
		Math.abs(plan.originalDurationSeconds - duration) > 0.1 ||
		!Number.isFinite(duration) ||
		duration <= 0
	)
		throw new Error("Recording changed. Generate a new edit before applying cuts.");
	if (!Array.isArray(plan.cuts) || plan.cuts.length > 2000) throw new Error("Invalid cut plan.");
	const additions = plan.cuts.map((cut) => {
		if (
			!Number.isFinite(cut.startMs) ||
			!Number.isFinite(cut.endMs) ||
			cut.startMs < 0 ||
			cut.endMs > duration * 1000 + 1 ||
			cut.endMs <= cut.startMs
		)
			throw new Error("Cut is outside the source recording.");
		return {
			id: "trim-" + nextId++,
			startMs: cut.startMs,
			endMs: Math.min(duration * 1000, cut.endMs),
		};
	});
	const trims = [...existing, ...additions];
	if (!buildKeptClipSegments(duration, trims).some((clip) => clip.duration >= 0.1))
		throw new Error(
			"These cuts would remove the entire remaining demo. Keep at least one section.",
		);
	return { trims, nextId };
}
