import { Loader2, Scissors, Sparkles } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useAutoEdit } from "@/hooks/useAutoEdit";
import { buildAutoEditTrims } from "@/lib/applyAutoEdit";
import type { AutoEditPlan, AutoEditStatus } from "@/lib/autoEdit";
import { buildKeptClipSegments } from "@/lib/exporter/hyperframesExporter";
import type { TrimRegion } from "./types";

export function formatEditTime(seconds: number): string {
	const whole = Math.max(0, Math.round(seconds));
	return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	videoPath: string | null;
	durationSeconds: number;
	trimRegions: TrimRegion[];
	revision: string;
	onApply: (plan: AutoEditPlan, exportHyperframes: boolean) => Promise<void>;
}

export function AutoEditDialog({
	open,
	onOpenChange,
	videoPath,
	durationSeconds,
	trimRegions,
	revision,
	onApply,
}: Props) {
	const [instructions, setInstructions] = useState(
		"Remove filler words, false starts and repeated explanations. Keep every meaningful demo step in its original order. Preserve pauses needed to understand on-screen actions.",
	);
	const [tightenPauses, setTightenPauses] = useState(false);
	const [status, setStatus] = useState<AutoEditStatus | null>(null);
	const [applying, setApplying] = useState(false);
	const [applyError, setApplyError] = useState<string | null>(null);
	const editor = useAutoEdit(videoPath, durationSeconds, revision);
	const preview = useMemo(() => {
		if (!editor.plan) return null;
		try {
			// Apply and both exports consume this same source-clock trim list, including manual cuts.
			const next = buildAutoEditTrims(editor.plan, durationSeconds, trimRegions, 0);
			const keptDuration = (trims: TrimRegion[]) =>
				buildKeptClipSegments(durationSeconds, trims).reduce((sum, clip) => sum + clip.duration, 0);
			return {
				current: keptDuration(trimRegions),
				result: keptDuration(next.trims),
				error: null,
			};
		} catch (cause) {
			return {
				current: null,
				result: null,
				error: cause instanceof Error ? cause.message : "Cannot apply these cuts to this timeline.",
			};
		}
	}, [editor.plan, durationSeconds, trimRegions]);
	useEffect(() => {
		if (!open) {
			editor.cancel();
			return;
		}
		let disposed = false;
		void window.electronAPI.getAutoEditStatus().then(
			(value) => {
				if (!disposed) setStatus(value);
			},
			() => {
				if (!disposed)
					setStatus({
						available: false,
						message: "Cannot check Codex. Restart the app and try again.",
					});
			},
		);
		return () => {
			disposed = true;
		};
	}, [open, editor.cancel]);
	const busy = !!editor.phase || applying;
	async function apply(exportHyperframes: boolean) {
		if (!editor.plan || !preview || preview.error || applying) return;
		setApplying(true);
		setApplyError(null);
		try {
			await onApply(editor.plan, exportHyperframes);
			onOpenChange(false);
		} catch (cause) {
			setApplyError(cause instanceof Error ? cause.message : "Could not apply edits.");
		} finally {
			setApplying(false);
		}
	}
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) editor.cancel();
				onOpenChange(value);
			}}
		>
			<DialogContent
				className="max-h-[85vh] overflow-y-auto border-white/10 bg-[#09090b] sm:max-w-xl"
				style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Sparkles className="h-4 w-4 text-[#34B27B]" />
						Auto edit with Codex
					</DialogTitle>
					<DialogDescription>
						Clean up a long demo, then keep editing in this timeline or HyperFrames.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<p className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-slate-300">
						Speech is transcribed on this Mac. Only the transcript and your instructions are sent
						through your installed Codex CLI, using its signed-in account, configured model/provider
						and quota. This feature does not upload video or camera footage, or extract account
						tokens.
					</p>
					<p className={status?.available ? "text-xs text-slate-400" : "text-xs text-amber-300"}>
						{status?.message || "Checking installed Codex…"}
					</p>
					<label className="block space-y-2 text-xs text-slate-300">
						<span>What should the edit do?</span>
						<textarea
							aria-label="Editing instructions"
							value={instructions}
							maxLength={4000}
							disabled={busy}
							onChange={(event) => {
								setInstructions(event.target.value);
								editor.clearPlan();
							}}
							rows={4}
							className="w-full resize-y rounded-lg border border-white/10 bg-white/5 p-3 text-sm leading-relaxed text-white outline-none focus:border-[#34B27B] disabled:opacity-50"
						/>
					</label>
					<label className="flex items-start gap-2 text-xs leading-relaxed text-slate-300">
						<input
							type="checkbox"
							checked={tightenPauses}
							disabled={busy}
							onChange={(event) => {
								setTightenPauses(event.target.checked);
								editor.clearPlan();
							}}
							className="mt-0.5 accent-[#34B27B]"
						/>
						Also tighten long speech gaps. Leave off when silent on-screen actions matter.
					</label>
					{editor.phase && (
						<p role="status" className="flex items-center gap-2 text-sm text-[#34B27B]">
							<Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
							{editor.phase}
						</p>
					)}
					{(editor.error || applyError || preview?.error) && (
						<p
							role="alert"
							className="rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-sm text-red-300"
						>
							{editor.error || applyError || preview?.error}
						</p>
					)}
					{editor.plan && (
						<div className="space-y-3 rounded-lg border border-[#34B27B]/30 bg-[#34B27B]/5 p-3">
							<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
								<span className="flex items-center gap-2 text-white">
									<Scissors className="h-4 w-4" />
									{editor.plan.cuts.length} proposed cuts
								</span>
								{preview && preview.current !== null && preview.result !== null && (
									<span className="font-mono tabular-nums text-[#34B27B]">
										Source {formatEditTime(durationSeconds)} · Current{" "}
										{formatEditTime(preview.current)} → Result {formatEditTime(preview.result)}
									</span>
								)}
							</div>
							<p className="text-xs leading-relaxed text-slate-300">{editor.plan.summary}</p>
							{editor.plan.cuts.length > 0 && (
								<ul className="max-h-44 space-y-2 overflow-y-auto border-t border-white/10 pt-3 text-xs text-slate-300">
									{editor.plan.cuts.map((cut, index) => (
										<li key={index} className="grid grid-cols-[7rem_1fr] gap-2">
											<span className="font-mono tabular-nums text-slate-400">
												{formatEditTime(cut.startMs / 1000)}–{formatEditTime(cut.endMs / 1000)}
											</span>
											<span>{cut.reason}</span>
										</li>
									))}
								</ul>
							)}
							<p className="text-xs text-slate-400">
								Review before applying. Cuts are undoable; originals stay unchanged. MP4 and
								HyperFrames exports use these same cuts.
							</p>
						</div>
					)}
				</div>
				<DialogFooter className="flex-wrap gap-2">
					{editor.phase ? (
						<Button variant="outline" onClick={editor.cancel}>
							Cancel auto edit
						</Button>
					) : (
						<Button
							variant="outline"
							disabled={
								!status?.available ||
								!videoPath ||
								durationSeconds <= 0 ||
								!instructions.trim() ||
								applying
							}
							onClick={() => {
								setApplyError(null);
								void editor.generate(instructions, tightenPauses);
							}}
						>
							{editor.plan ? "Generate again" : "Propose cuts"}
						</Button>
					)}
					{editor.plan && editor.plan.cuts.length > 0 && (
						<>
							<Button
								variant="outline"
								disabled={busy || !preview || !!preview.error}
								onClick={() => void apply(false)}
							>
								Apply cuts
							</Button>
							<Button
								className="bg-[#34B27B] text-white hover:bg-[#34B27B]/90"
								disabled={busy || !preview || !!preview.error}
								onClick={() => void apply(true)}
							>
								{applying ? "Applying…" : "Apply + export HyperFrames"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
