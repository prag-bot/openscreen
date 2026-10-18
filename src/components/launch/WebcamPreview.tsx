import { FlipHorizontal2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export const DEFAULT_WEBCAM_PREVIEW_SIZE = 160;

type WebcamPreviewProps = {
	stream: MediaStream | null;
	recording: boolean;
	paused: boolean;
	size?: number;
};

/** Displays the recorder's camera feed; only the recorder owns its tracks. */
export function WebcamPreview({
	stream,
	recording,
	paused,
	size = DEFAULT_WEBCAM_PREVIEW_SIZE,
}: WebcamPreviewProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [mirrored, setMirrored] = useState(true);
	const diameter = Number.isFinite(size) && size > 0 ? size : DEFAULT_WEBCAM_PREVIEW_SIZE;

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = stream;
		return () => {
			// Detach the preview without stopping the recording's shared MediaStream.
			video.srcObject = null;
		};
	}, [stream]);

	return (
		<div
			className="pointer-events-none relative flex flex-col items-center gap-2"
			data-testid="launch-webcam-preview"
		>
			<div
				data-hud-interactive="true"
				data-hud-webcam-frame="true"
				className="pointer-events-auto relative shrink-0 overflow-hidden rounded-full border-2 border-white/20 bg-[#0b0c10] shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
				style={{ width: diameter, height: diameter, aspectRatio: "1 / 1", borderRadius: "50%" }}
			>
				<video
					ref={videoRef}
					aria-label="Live camera preview"
					autoPlay
					muted
					playsInline
					className="block h-full w-full object-cover"
					style={{ transform: mirrored ? "scaleX(-1)" : "none" }}
				/>
				{!stream && (
					<div
						role="status"
						className="absolute inset-0 grid place-items-center px-5 text-center text-xs text-white/80"
					>
						Connecting camera…
					</div>
				)}
			</div>
			<div
				data-hud-interactive="true"
				className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-[#0b0c10]/95 px-3 py-1 text-[11px] text-white shadow-lg"
			>
				<span
					className={`h-1.5 w-1.5 rounded-full ${recording && !paused ? "bg-red-400" : "bg-green-400"}`}
				/>
				<span>{recording ? (paused ? "Paused" : "Recording") : "Camera preview"}</span>
				<button
					type="button"
					aria-label={mirrored ? "Unmirror preview" : "Mirror preview"}
					aria-pressed={mirrored}
					title="Mirror preview only; recording layout is editable afterward"
					onClick={() => setMirrored((value) => !value)}
					className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
				>
					<FlipHorizontal2 size={12} />
				</button>
			</div>
		</div>
	);
}
