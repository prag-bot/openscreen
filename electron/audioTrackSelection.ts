/** afinfo lists tracks in the same zero-based order used by afconvert --read-track. */
export function parseAfinfoAudioTrackBitrates(output: string): number[] {
	// afinfo prints separators around tracks AND after its final track. Only a section
	// containing an actual Data format header represents a track; headers/footers do not.
	const trackSections = output
		.split(/^[\t ]*-{4,}[\t ]*\r?$/m)
		.filter((section) => /^[\t ]*Data format:/im.test(section));
	return trackSections.map((section) => {
		const match = section.match(/\bbit rate:\s*([0-9]+)\s*bits per second/i);
		return match ? Number(match[1]) : 0;
	});
}

/** Native recordings put narration after the main track; prefer its best-quality track. */
export function selectSupplementalAudioTrack(output: string): number | null {
	const bitrates = parseAfinfoAudioTrackBitrates(output);
	if (bitrates.length <= 1) return null;
	let selected = 1;
	for (let index = 2; index < bitrates.length; index += 1) {
		if (bitrates[index] > bitrates[selected]) selected = index;
	}
	return selected;
}
