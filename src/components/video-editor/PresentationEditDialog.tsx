import { Loader2, Monitor, UserRound } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { type PresentationRegion, validatePresentationRegions } from "@/lib/presentation";

export interface PresentationEditDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	durationSeconds: number;
	screenVideoPath: string | null;
	webcamVideoPath?: string;
	webcamOffsetSeconds?: number;
	regions: PresentationRegion[];
	onSuggest: () => Promise<PresentationRegion[]>;
	onApply: (regions: PresentationRegion[]) => void;
}

function cloneRegions(regions: PresentationRegion[]): PresentationRegion[] {
	return regions.map((region) => ({ ...region }));
}

function sourceTime(seconds: number): string {
	const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	const whole = Math.floor(safe);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${String(
		Math.floor((safe - whole) * 10),
	)}`;
}

/** A frame-only UI preview. This is not a HyperFrames composition or media player. */
function seekPreviewFrame(video: HTMLVideoElement | null, seconds: number) {
	if (!video || video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) {
		return;
	}
	try {
		video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, video.duration - 0.001));
	} catch {
		// A source can be replaced while its metadata event is being delivered.
	}
}

export function PresentationEditDialog({
	open,
	onOpenChange,
	durationSeconds,
	screenVideoPath,
	webcamVideoPath,
	webcamOffsetSeconds = 0,
	regions,
	onSuggest,
	onApply,
}: PresentationEditDialogProps) {
	const [draft, setDraft] = useState<PresentationRegion[]>(() => cloneRegions(regions));
	const [hasDraft, setHasDraft] = useState(regions.length > 0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [previewSeconds, setPreviewSeconds] = useState(0);
	const [cameraDuration, setCameraDuration] = useState<number | null>(null);
	const [cameraError, setCameraError] = useState(false);
	const [screenError, setScreenError] = useState(false);
	const screenRef = useRef<HTMLVideoElement>(null);
	const cameraRef = useRef<HTMLVideoElement>(null);
	const requestRef = useRef(0);
	const nextManualIdRef = useRef(1);
	const regionsRef = useRef(regions);
	regionsRef.current = regions;
	const identity = `${screenVideoPath ?? ""}\0${webcamVideoPath ?? ""}\0${durationSeconds}\0${webcamOffsetSeconds}`;
	const identityRef = useRef(identity);
	identityRef.current = identity;
	const openRef = useRef(open);
	openRef.current = open;
	const durationMs = durationSeconds * 1000;
	const validDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;

	useEffect(() => {
		requestRef.current += 1;
		setBusy(false);
		if (!open || identity !== identityRef.current) return;
		setDraft(cloneRegions(regionsRef.current));
		setHasDraft(regionsRef.current.length > 0);
		setError(null);
		setPreviewSeconds(0);
		setCameraDuration(null);
		setCameraError(false);
		setScreenError(false);
		return () => {
			requestRef.current += 1;
		};
	}, [open, identity]);

	const validation = useMemo(() => {
		if (!validDuration) return { regions: null, error: "Load a recording with a valid duration." };
		try {
			return { regions: validatePresentationRegions(draft, durationMs), error: null };
		} catch (cause) {
			return {
				regions: null,
				error: cause instanceof Error ? cause.message : "Check the switch times before applying.",
			};
		}
	}, [draft, durationMs, validDuration]);
	const previewMs = Math.min(previewSeconds * 1000, Math.max(0, durationMs - 1));
	const previewRegion = draft.find(
		(region) => previewMs >= region.startMs && previewMs < region.endMs,
	);
	const cameraSeconds = previewMs / 1000 - webcamOffsetSeconds;
	const cameraAvailable =
		!!webcamVideoPath &&
		!cameraError &&
		cameraDuration !== null &&
		cameraSeconds >= 0 &&
		cameraSeconds < cameraDuration;
	const unavailableFace =
		previewRegion?.mode === "face-only" &&
		(!webcamVideoPath || ((cameraError || cameraDuration !== null) && !cameraAvailable));
	const faceOnly = previewRegion?.mode === "face-only" && !unavailableFace;

	useEffect(() => {
		if (!open) return;
		seekPreviewFrame(screenRef.current, previewMs / 1000);
		if (cameraAvailable) seekPreviewFrame(cameraRef.current, cameraSeconds);
	}, [open, previewMs, cameraAvailable, cameraSeconds]);

	function close(value: boolean) {
		if (!value) {
			requestRef.current += 1;
			setBusy(false);
		}
		onOpenChange(value);
	}

	async function suggest() {
		if (busy || !webcamVideoPath || !screenVideoPath || !validDuration) return;
		const request = ++requestRef.current;
		const source = identity;
		const isCurrent = () =>
			requestRef.current === request && identityRef.current === source && openRef.current;
		setBusy(true);
		setError(null);
		try {
			const proposed = await onSuggest();
			if (!isCurrent()) return;
			const valid = validatePresentationRegions(proposed, durationMs);
			setDraft(cloneRegions(valid));
			setHasDraft(true);
			setPreviewSeconds((valid[0]?.startMs ?? 0) / 1000);
		} catch (cause) {
			if (isCurrent())
				setError(
					cause instanceof Error ? cause.message : "Could not suggest presentation switches.",
				);
		} finally {
			if (isCurrent()) setBusy(false);
		}
	}

	function updateRegion(index: number, changes: Partial<PresentationRegion>) {
		setDraft((current) =>
			current.map((region, item) =>
				item === index ? { ...region, ...changes, reason: "Adjusted during review." } : region,
			),
		);
		setHasDraft(true);
		setError(null);
	}

	function manualId(current: PresentationRegion[]): string {
		const ids = new Set(current.map((region) => region.id));
		let id: string;
		do {
			id = `presentation-review-${nextManualIdRef.current++}`;
		} while (ids.has(id));
		return id;
	}

	function splitRegion(index: number) {
		setDraft((current) => {
			const region = current[index];
			if (!region || current.length >= 2000) return current;
			const middle = (region.startMs + region.endMs) / 2;
			if (!Number.isFinite(middle) || middle <= region.startMs || middle >= region.endMs) {
				return current;
			}
			return [
				...current.slice(0, index),
				{ ...region, endMs: middle, reason: "Adjusted during review." },
				{ ...region, id: manualId(current), startMs: middle, reason: "Adjusted during review." },
				...current.slice(index + 1),
			];
		});
		setHasDraft(true);
		setError(null);
	}

	function apply() {
		if (
			busy ||
			!hasDraft ||
			!validation.regions ||
			!screenVideoPath ||
			(!webcamVideoPath && draft.length > 0)
		)
			return;
		try {
			onApply(cloneRegions(validation.regions));
			close(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not apply presentation switches.");
		}
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent
				className="max-h-[85vh] overflow-y-auto border-white/10 bg-[#09090b] sm:max-w-3xl"
				style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Monitor className="h-4 w-4 text-[#34B27B]" />
						Review presentation switches
					</DialogTitle>
					<DialogDescription>
						Suggest where to show just your face and where to show the demo. Review the source times
						before applying them to the HyperFrames edit.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
						<p className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
							<UserRound className="mr-1 inline h-3 w-3" /> <strong>Face only:</strong> your camera
							fills the frame. Hide the screen and cursor.
						</p>
						<p className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
							<Monitor className="mr-1 inline h-3 w-3" /> <strong>Demo:</strong> screen, your face
							at the bottom right, and the cursor.
						</p>
					</div>
					<p className="text-xs leading-relaxed text-slate-400">
						Suggestions use audio levels and mouse activity. A quiet loading screen can need
						correction. Nothing changes until you apply the switches.
					</p>
					{!webcamVideoPath && (
						<p className="rounded-lg border border-amber-300/20 p-3 text-xs text-amber-200">
							A camera recording is needed for face-only suggestions. You can still clear existing
							switches.
						</p>
					)}
					{busy && (
						<p role="status" className="flex items-center gap-2 text-sm text-[#34B27B]">
							<Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
							Checking audio levels and mouse activity locally…
						</p>
					)}
					{(error || validation.error) && (
						<p
							role="alert"
							className="rounded-lg border border-red-400/20 p-3 text-sm text-red-300"
						>
							{error || validation.error}
						</p>
					)}
					{draft.length > 0 ? (
						<div className="space-y-2">
							<p className="text-xs text-slate-400">
								Times refer to the original recording. Gaps keep the current project layout.
							</p>
							{draft.map((region, index) => (
								<div key={region.id} className="rounded-lg border border-white/10 p-3">
									<div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_1.5fr_auto]">
										<label className="space-y-1 text-xs text-slate-300">
											<span>Start (seconds)</span>
											<input
												aria-label={`Switch ${index + 1} start seconds`}
												type="number"
												min={0}
												max={durationSeconds}
												step={0.1}
												value={Number.isFinite(region.startMs) ? region.startMs / 1000 : ""}
												disabled={busy}
												onChange={(event) =>
													updateRegion(index, { startMs: event.currentTarget.valueAsNumber * 1000 })
												}
												className="w-full rounded border border-white/10 bg-white/5 p-2"
											/>
										</label>
										<label className="space-y-1 text-xs text-slate-300">
											<span>End (seconds)</span>
											<input
												aria-label={`Switch ${index + 1} end seconds`}
												type="number"
												min={0}
												max={durationSeconds}
												step={0.1}
												value={Number.isFinite(region.endMs) ? region.endMs / 1000 : ""}
												disabled={busy}
												onChange={(event) =>
													updateRegion(index, { endMs: event.currentTarget.valueAsNumber * 1000 })
												}
												className="w-full rounded border border-white/10 bg-white/5 p-2"
											/>
										</label>
										<label className="col-span-2 space-y-1 text-xs text-slate-300 sm:col-span-1">
											<span>View</span>
											<select
												aria-label={`Switch ${index + 1} view`}
												value={region.mode}
												disabled={busy}
												onChange={(event) =>
													updateRegion(index, {
														mode: event.currentTarget.value as PresentationRegion["mode"],
													})
												}
												className="w-full rounded border border-white/10 bg-[#151519] p-2"
											>
												<option value="face-only">Face only</option>
												<option value="demo">Demo</option>
											</select>
										</label>
										<Button
											variant="outline"
											disabled={busy || !Number.isFinite(region.startMs)}
											onClick={() => setPreviewSeconds(Math.max(0, region.startMs / 1000))}
										>
											Preview {index + 1}
										</Button>
										<Button
											variant="outline"
											disabled={
												busy ||
												!Number.isFinite(region.startMs) ||
												!Number.isFinite(region.endMs) ||
												region.endMs <= region.startMs ||
												draft.length >= 2000
											}
											onClick={() => splitRegion(index)}
										>
											Split {index + 1}
										</Button>
										<Button
											variant="ghost"
											disabled={busy}
											onClick={() => {
												setDraft((current) => current.filter((_, item) => item !== index));
												setHasDraft(true);
												setError(null);
											}}
										>
											Remove {index + 1}
										</Button>
									</div>
									{region.reason && <p className="mt-2 text-xs text-slate-400">{region.reason}</p>}
								</div>
							))}
						</div>
					) : (
						<div className="space-y-2 rounded-lg border border-dashed border-white/15 p-3 text-xs text-slate-400">
							<p>
								{hasDraft
									? "No switches. Applying this clears the current presentation switches."
									: "Generate suggestions or add a demo section, then split it to mark switch times."}
							</p>
							<Button
								variant="outline"
								disabled={busy || !validDuration || !screenVideoPath}
								onClick={() => {
									setDraft([
										{
											id: manualId([]),
											startMs: 0,
											endMs: durationMs,
											mode: "demo",
											reason: "Added during review. Split this section to mark switch times.",
										},
									]);
									setHasDraft(true);
									setError(null);
								}}
							>
								Add a demo section
							</Button>
						</div>
					)}
					{draft.length > 0 && screenVideoPath && validDuration && (
						<figure className="space-y-2 rounded-lg border border-white/10 p-3">
							<figcaption className="flex justify-between gap-2 text-xs text-slate-300">
								<span>Source frame preview · {sourceTime(previewSeconds)}</span>
								<span>{!previewRegion ? "Current layout" : faceOnly ? "Face only" : "Demo"}</span>
							</figcaption>
							<div className="relative aspect-video overflow-hidden rounded-md bg-black">
								{faceOnly && cameraDuration === null && !cameraError && (
									<p className="absolute inset-0 z-10 grid place-items-center text-xs text-slate-400">
										Loading camera preview…
									</p>
								)}
								{!previewRegion && (
									<p className="absolute inset-0 z-10 grid place-items-center bg-black p-4 text-center text-xs text-slate-400">
										No switch at this time. The current project layout will be used.
									</p>
								)}
								<video
									ref={screenRef}
									src={screenVideoPath}
									aria-label="Screen source frame"
									muted
									playsInline
									preload="metadata"
									onLoadedMetadata={() => seekPreviewFrame(screenRef.current, previewMs / 1000)}
									onError={() => setScreenError(true)}
									className={`absolute inset-0 h-full w-full object-contain ${faceOnly ? "opacity-0" : ""}`}
								/>
								{webcamVideoPath && (
									<video
										ref={cameraRef}
										src={webcamVideoPath}
										aria-label="Camera source frame"
										muted
										playsInline
										preload="metadata"
										onLoadedMetadata={(event) => {
											setCameraDuration(event.currentTarget.duration);
											seekPreviewFrame(cameraRef.current, cameraSeconds);
										}}
										onError={() => setCameraError(true)}
										className={`absolute object-cover ${faceOnly ? "inset-0 h-full w-full" : "bottom-[4%] right-[4%] h-[28%] w-[25%] rounded-lg"} ${cameraAvailable ? "" : "opacity-0"}`}
									/>
								)}
							</div>
							<label className="block text-xs text-slate-400">
								<span className="sr-only">Preview source time</span>
								<input
									aria-label="Preview source time"
									type="range"
									min={0}
									max={durationSeconds}
									step={0.1}
									value={previewSeconds}
									onChange={(event) => setPreviewSeconds(event.currentTarget.valueAsNumber)}
									className="w-full accent-[#34B27B]"
								/>
							</label>
							<p className="text-xs text-slate-400">
								Frame preview only. The editable cursor is added in the HyperFrames export.
							</p>
							{unavailableFace && (
								<p className="text-xs text-amber-200">
									No camera frame is available here. The export keeps the demo view for this gap.
								</p>
							)}
							{screenError && (
								<p className="text-xs text-amber-200">Cannot load this screen frame.</p>
							)}
						</figure>
					)}
				</div>
				<DialogFooter className="flex-wrap gap-2">
					<Button variant="outline" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button
						variant="outline"
						disabled={busy || !webcamVideoPath || !screenVideoPath || !validDuration}
						onClick={() => void suggest()}
					>
						{hasDraft ? "Suggest again" : "Suggest switches"}
					</Button>
					<Button
						className="bg-[#34B27B] text-white hover:bg-[#34B27B]/90"
						disabled={
							busy ||
							!hasDraft ||
							!validation.regions ||
							!screenVideoPath ||
							(!webcamVideoPath && draft.length > 0)
						}
						onClick={apply}
					>
						Apply switches
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
