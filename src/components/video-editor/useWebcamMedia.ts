import { useCallback, useState } from "react";
import { normalizeWebcamOffsetSeconds } from "@/lib/recordingSession";
import { toFileUrl } from "./projectPersistence";

/** Camera identity and its source clock change together on every media load. */
export function useWebcamMedia() {
	const [media, setMedia] = useState<{ sourcePath: string | null; offsetSeconds: number }>({
		sourcePath: null,
		offsetSeconds: 0,
	});
	const setWebcamMedia = useCallback((sourcePath: string | null, offsetSeconds?: number) => {
		setMedia({
			sourcePath,
			offsetSeconds: sourcePath ? normalizeWebcamOffsetSeconds(offsetSeconds) : 0,
		});
	}, []);
	return {
		webcamVideoSourcePath: media.sourcePath,
		webcamVideoPath: media.sourcePath ? toFileUrl(media.sourcePath) : null,
		webcamOffsetSeconds: media.offsetSeconds,
		setWebcamMedia,
	};
}
