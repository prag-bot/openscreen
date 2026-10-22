import type { RecordingSession } from "../../src/lib/recordingSession";

interface RestorationOptions {
	/** Absence/nonmatch may return null; a valid session must retain its full metadata. */
	read: () => Promise<RecordingSession | null>;
	prepare: (session: RecordingSession) => Promise<RecordingSession>;
	persist: (session: RecordingSession) => Promise<void>;
}

/** Read fallbacks must never hide a preparation or persistence failure. */
export async function restoreRecordingSession(
	options: RestorationOptions,
): Promise<RecordingSession | null> {
	const session = await options.read();
	if (!session) return null;
	const prepared = await options.prepare(session);
	try {
		await options.persist(prepared);
	} catch (error) {
		throw new Error(
			`Could not update recording session metadata for ${prepared.screenVideoPath}. Original recording retained at ${prepared.originalScreenVideoPath ?? prepared.screenVideoPath}. Session metadata was not discarded. Check that the recording folder is writable and retry. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return prepared;
}
