import { useEffect, useState } from "react";
import type { CursorRecordingData } from "@/native/contracts";
import { nativeBridgeClient } from "../client";

interface UseCursorRecordingDataResult {
	data: CursorRecordingData | null;
	/** The current recording whose sidecar finished loading successfully. */
	sourcePath: string | null;
	loading: boolean;
	error: string | null;
}

export function useCursorRecordingData(videoPath: string | null): UseCursorRecordingDataResult {
	const [state, setState] = useState<
		UseCursorRecordingDataResult & { requestedPath: string | null }
	>({
		requestedPath: null,
		sourcePath: null,
		data: null,
		loading: false,
		error: null,
	});

	useEffect(() => {
		let cancelled = false;

		async function loadCursorRecordingData() {
			if (!videoPath) {
				setState({
					requestedPath: null,
					sourcePath: null,
					data: null,
					loading: false,
					error: null,
				});
				return;
			}

			setState({
				requestedPath: videoPath,
				sourcePath: null,
				data: null,
				loading: true,
				error: null,
			});

			try {
				const nextData = await nativeBridgeClient.cursor.getRecordingData(videoPath);
				if (!cancelled) {
					setState({
						requestedPath: videoPath,
						sourcePath: videoPath,
						data: nextData,
						loading: false,
						error: null,
					});
				}
			} catch (nextError) {
				if (!cancelled) {
					setState({
						requestedPath: videoPath,
						sourcePath: null,
						data: null,
						loading: false,
						error:
							nextError instanceof Error
								? nextError.message
								: "Failed to load cursor recording data",
					});
				}
			}
		}

		loadCursorRecordingData();

		return () => {
			cancelled = true;
		};
	}, [videoPath]);

	// Mask the preceding source during the render before the replacement's effect runs.
	const current = state.requestedPath === videoPath;
	return {
		data: current ? state.data : null,
		sourcePath: current ? state.sourcePath : null,
		loading: !!videoPath && (!current || state.loading),
		error: current ? state.error : null,
	};
}
