import { FolderOpen, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
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
	const busy = useRef(false);
	async function exportProject() {
		if (busy.current) return;
		busy.current = true;
		setExporting(true);
		try {
			const result = await window.electronAPI.exportHyperframesProject(getRequest());
			if (!result.success) {
				if (result.canceled) toast.info("HyperFrames export canceled. No project was created.");
				else toast.error(`HyperFrames export failed: ${result.error}`);
				return;
			}
			toast.success("HyperFrames project created", {
				description: result.path,
				duration: 10000,
			});
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
				onClick={() => void exportProject()}
				className="w-full border-[#34B27B]/40 bg-[#34B27B]/10 text-[#34B27B] hover:bg-[#34B27B]/20 hover:text-[#34B27B]"
				title={HYPERFRAMES_RAW_FOOTAGE_NOTE}
			>
				{exporting ? (
					<Loader2 className="mr-2 h-4 w-4 animate-spin" />
				) : (
					<FolderOpen className="mr-2 h-4 w-4" />
				)}
				{exporting ? "Creating HyperFrames project…" : "Edit in HyperFrames"}
			</Button>
			<p className="text-[10px] leading-relaxed text-slate-400">
				Creates a new local project with editable raw footage, removal trims and camera layout.
				OpenScreen effects and speed changes are not exported. Use Auto edit with Codex first to
				propose cuts; this export stays local.
			</p>
		</div>
	);
}
