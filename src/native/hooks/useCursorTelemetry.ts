import { useEffect, useState } from "react";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { nativeBridgeClient } from "../client";

interface UseCursorTelemetryResult {
	samples: CursorTelemetryPoint[];
	/** The current recording whose sidecar finished loading successfully. */
	sourcePath: string | null;
	loading: boolean;
	error: string | null;
}

export function useCursorTelemetry(videoPath: string | null): UseCursorTelemetryResult {
	const [state, setState] = useState<UseCursorTelemetryResult & { requestedPath: string | null }>({
		requestedPath: null,
		sourcePath: null,
		samples: [],
		loading: false,
		error: null,
	});

	useEffect(() => {
		let cancelled = false;

		async function loadCursorTelemetry() {
			if (!videoPath) {
				setState({
					requestedPath: null,
					sourcePath: null,
					samples: [],
					loading: false,
					error: null,
				});
				return;
			}

			setState({
				requestedPath: videoPath,
				sourcePath: null,
				samples: [],
				loading: true,
				error: null,
			});

			try {
				const nextSamples = await nativeBridgeClient.cursor.getTelemetry(videoPath);
				if (!cancelled) {
					setState({
						requestedPath: videoPath,
						sourcePath: videoPath,
						samples: nextSamples,
						loading: false,
						error: null,
					});
				}
			} catch (nextError) {
				if (!cancelled) {
					setState({
						requestedPath: videoPath,
						sourcePath: null,
						samples: [],
						loading: false,
						error:
							nextError instanceof Error ? nextError.message : "Failed to load cursor telemetry",
					});
				}
			}
		}

		loadCursorTelemetry();

		return () => {
			cancelled = true;
		};
	}, [videoPath]);

	// Mask the preceding source during the render before the replacement's effect runs.
	const current = state.requestedPath === videoPath;
	return {
		samples: current ? state.samples : [],
		sourcePath: current ? state.sourcePath : null,
		loading: !!videoPath && (!current || state.loading),
		error: current ? state.error : null,
	};
}
