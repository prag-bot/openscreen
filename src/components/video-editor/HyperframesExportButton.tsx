import { FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	HYPERFRAMES_RAW_FOOTAGE_NOTE,
	type HyperframesExportRequest,
} from "@/lib/exporter/hyperframesExporter";

export function HyperframesExportButton({
	getRequest,
	disabled = false,
}: {
	getRequest: () => HyperframesExportRequest;
	disabled?: boolean;
}) {
	const [exporting, setExporting] = useState(false);
	const [status, setStatus] = useState("");
	useEffect(() => window.electronAPI.onHyperframesExportProgress?.(setStatus), []);
	const busy = useRef(false);
	async function exportProject(renderVideo: boolean) {
		if (busy.current) return;
		busy.current = true;
		setExporting(true);
		setStatus(renderVideo ? "Preparing HyperFrames MP4…" : "Creating editable project…");
		try {
			const result = renderVideo
				? await window.electronAPI.exportHyperframesVideo(getRequest())
				: await window.electronAPI.exportHyperframesProject(getRequest());
			if (!result.success) {
				const recovery =
					"projectPath" in result && result.projectPath
						? ` Editable project retained at ${result.projectPath}`
						: "";
				if (result.canceled) toast.info(`HyperFrames export canceled.${recovery}`);
				else toast.error(`HyperFrames export failed: ${result.error}${recovery}`);
				return;
			}
			if (
				renderVideo &&
				(!("videoPath" in result) ||
					typeof result.videoPath !== "string" ||
					!result.videoPath.toLowerCase().endsWith(".mp4"))
			)
				throw new Error("No finished MP4 was returned. The editable folder is not a video.");
			toast.success(
				renderVideo ? "HyperFrames MP4 ready" : "HyperFrames project created (no video render)",
				{
					description: result.path,
					duration: 10000,
				},
			);
			try {
				const reveal = await window.electronAPI.revealInFolder(result.path);
				if (!reveal.success) {
					toast.warning("Project was saved, but its folder could not be shown", {
						description: `${result.path}: ${reveal.error ?? reveal.message ?? "Unknown folder error"}`,
					});
				}
			} catch {
				toast.warning("Project was saved, but its folder could not be shown", {
					description: result.path,
				});
			}
		} catch (error) {
			toast.error(
				`HyperFrames export failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		} finally {
			busy.current = false;
			setExporting(false);
		}
	}
	return (
		<div className="mt-3 space-y-2">
			<Button
				type="button"
				variant="outline"
				disabled={disabled || exporting}
				onClick={() => void exportProject(true)}
				className="w-full border-[#34B27B]/40 bg-[#34B27B]/10 text-[#34B27B] hover:bg-[#34B27B]/20 hover:text-[#34B27B]"
				title={HYPERFRAMES_RAW_FOOTAGE_NOTE}
			>
				{exporting ? (
					<Loader2 className="mr-2 h-4 w-4 animate-spin" />
				) : (
					<FolderOpen className="mr-2 h-4 w-4" />
				)}
				{exporting ? "Exporting HyperFrames…" : "Render HyperFrames MP4"}
			</Button>
			<Button
				type="button"
				variant="outline"
				disabled={disabled || exporting}
				onClick={() => void exportProject(false)}
				className="w-full"
				title="Create the editable HTML project only; does not render a finished video."
			>
				HyperFrames project only
			</Button>
			{exporting && (
				<div className="space-y-1">
					<p role="status" className="text-xs text-slate-400">
						{status}
					</p>
					<Button
						type="button"
						variant="outline"
						className="w-full"
						onClick={() => void window.electronAPI.cancelHyperframesExport()}
					>
						Cancel HyperFrames export
					</Button>
				</div>
			)}
			<p className="text-[10px] leading-relaxed text-slate-400">
				MP4 renders locally with reviewed cuts, camera, native cursor and mixed audio; the editable
				project is retained. Zooms, speed changes, crops, wallpapers, annotations and styled cursor
				effects are not exported. Use Auto edit with Codex first to propose cuts. Requires an
				already-installed HyperFrames, FFmpeg and browser; nothing is downloaded by OpenScreen.
			</p>
		</div>
	);
}
