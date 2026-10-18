export interface SourceTimeRange {
	startMs: number;
	endMs: number;
}

/**
 * One removal union for all export consumers. Clamp to the source, ignore empty
 * ranges and merge overlapping/touching cuts. Never mutate editor regions/IDs.
 * Already-canonical input is returned read-only without sorting or allocating.
 */
export function canonicalRemovalRanges(
	durationMs: number,
	ranges: readonly SourceTimeRange[] = [],
): readonly SourceTimeRange[] {
	if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("Invalid source duration");
	let canonical = true;
	let previousEnd = -1;
	for (const range of ranges) {
		if (
			!Number.isFinite(range.startMs) ||
			!Number.isFinite(range.endMs) ||
			range.endMs < range.startMs
		) {
			throw new Error("Invalid removal trim timing");
		}
		if (
			range.startMs < 0 ||
			range.endMs > durationMs ||
			range.endMs === range.startMs ||
			range.startMs <= previousEnd
		)
			canonical = false;
		previousEnd = range.endMs;
	}
	if (canonical) return ranges;
	const clamp = (value: number) => Math.max(0, Math.min(durationMs, value));
	const merged: SourceTimeRange[] = [];
	for (const range of ranges
		.map(({ startMs, endMs }) => ({ startMs: clamp(startMs), endMs: clamp(endMs) }))
		.filter(({ startMs, endMs }) => endMs > startMs)
		.sort((a, b) => a.startMs - b.startMs)) {
		const previous = merged[merged.length - 1];
		if (previous && range.startMs <= previous.endMs)
			previous.endMs = Math.max(previous.endMs, range.endMs);
		else merged.push(range);
	}
	return merged;
}

/** Complement of the canonical removal union, on the original source clock. */
export function keptSourceRanges(
	durationMs: number,
	trims: readonly SourceTimeRange[] = [],
): SourceTimeRange[] {
	const kept: SourceTimeRange[] = [];
	let cursor = 0;
	for (const range of canonicalRemovalRanges(durationMs, trims)) {
		if (range.startMs > cursor) kept.push({ startMs: cursor, endMs: range.startMs });
		cursor = range.endMs;
	}
	if (cursor < durationMs) kept.push({ startMs: cursor, endMs: durationMs });
	return kept;
}

/** Removed elapsed time before a source timestamp, counted once even for nested cuts. */
export function removedDurationBefore(
	timestampMs: number,
	trims: readonly SourceTimeRange[],
): number {
	let removedMs = 0;
	for (const range of canonicalRemovalRanges(Number.MAX_VALUE, trims)) {
		if (range.startMs >= timestampMs) break;
		removedMs += Math.min(timestampMs, range.endMs) - range.startMs;
	}
	return removedMs;
}
