import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoEditPlan } from "@/lib/autoEdit";
import { normalizeLocalAutoEditTranscript } from "@/lib/autoEditTranscript";
import {
	extractMono16kFromVideoUrl,
	transcribeMono16kToSegments,
	trimLeadingSilenceMono16k,
} from "@/lib/captioning";
import type { CaptionSegment, CaptionTimestampGranularity } from "@/lib/captioning/transcribe";

export function useAutoEdit(videoPath: string | null, durationSeconds: number, revision: string) {
	const [phase, setPhase] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [plan, setPlan] = useState<AutoEditPlan | null>(null);
	const [planRevision, setPlanRevision] = useState<string | null>(null);
	const [transcript, setTranscript] = useState<CaptionSegment[] | null>(null);
	const [transcriptGranularity, setTranscriptGranularity] =
		useState<CaptionTimestampGranularity | null>(null);
	const [transcriptRevision, setTranscriptRevision] = useState<string | null>(null);
	const active = useRef<{ id: string; controller: AbortController } | null>(null);
	const revisionRef = useRef(revision);
	const lastRevisionRef = useRef(revision);
	revisionRef.current = revision;
	const cancel = useCallback(() => {
		const job = active.current;
		active.current = null;
		job?.controller.abort();
		if (job) void window.electronAPI.cancelAutoEdit(job.id).catch(() => undefined);
		setPhase(null);
		setTranscript(null);
		setTranscriptGranularity(null);
		setTranscriptRevision(null);
	}, []);
	useEffect(() => {
		if (lastRevisionRef.current === revision) return;
		lastRevisionRef.current = revision;
		cancel();
		setPlan(null);
		setError(null);
	}, [revision, cancel]);
	useEffect(
		() => () => {
			const job = active.current;
			active.current = null;
			job?.controller.abort();
			if (job) void window.electronAPI.cancelAutoEdit(job.id).catch(() => undefined);
		},
		[],
	);

	async function generate(instructions: string, tightenPauses: boolean) {
		if (!videoPath || active.current) return;
		const job = { id: crypto.randomUUID(), controller: new AbortController() };
		const sourceRevision = revision;
		active.current = job;
		setPlan(null);
		setError(null);
		setTranscript(null);
		setTranscriptGranularity(null);
		setTranscriptRevision(null);
		setPhase("Extracting narration locally…");
		const isCurrent = () =>
			active.current === job &&
			revisionRef.current === sourceRevision &&
			!job.controller.signal.aborted;
		try {
			if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 14_400)
				throw new Error(
					"The recording duration is invalid. Reload the recording before using Auto edit.",
				);
			const audio = await window.electronAPI.prepareAutoEditAudio({ jobId: job.id, videoPath });
			if (!isCurrent()) return;
			if (!audio.success || !audio.path)
				throw new Error(audio.error || "Cannot read recording audio.");
			const { samples, truncated } = await extractMono16kFromVideoUrl(audio.path, {
				signal: job.controller.signal,
			});
			if (!isCurrent()) return;
			if (truncated)
				throw new Error(
					"This recording exceeds the transcription limit. Split it first; no partial edit was made.",
				);
			// AAC can extend past the final video frame. Transcribe only the source video
			// intersection; ceil retains the final partial sample inside that recording.
			const recordingSamples = samples.subarray(0, Math.ceil(durationSeconds * 16_000));
			if (
				recordingSamples.length < 800 ||
				!recordingSamples.some((sample) => Math.abs(sample) > 0.012)
			)
				throw new Error(
					"No audible narration found. Enable the microphone when recording, or import a video with speech.",
				);
			const { samples: speechSamples, trimSec } = trimLeadingSilenceMono16k(recordingSamples);
			const transcription = await transcribeMono16kToSegments(speechSamples, {
				signal: job.controller.signal,
				onStatus: (value) => {
					if (isCurrent())
						setPhase(
							value === "model"
								? "Loading local speech model…"
								: "Transcribing locally — long demos can take several minutes…",
						);
				},
			});
			if (!isCurrent()) return;
			const segments = normalizeLocalAutoEditTranscript(
				transcription.segments.map((segment) => ({
					...segment,
					startSec: segment.startSec + trimSec,
					endSec: segment.endSec + trimSec,
				})),
				{ durationSeconds },
			);
			if (!segments.length)
				throw new Error(
					"No speech was transcribed. Nothing was sent to Codex and no edits were made.",
				);
			setTranscript(segments.map((segment) => ({ ...segment })));
			setTranscriptGranularity(transcription.granularity === "word" ? "word" : "phrase");
			setTranscriptRevision(sourceRevision);
			setPhase("Codex is proposing cuts. Your original recording stays untouched…");
			const result = await window.electronAPI.planAutoEdit({
				jobId: job.id,
				durationSeconds,
				instructions,
				segments,
				tightenPauses,
			});
			if (!isCurrent()) return;
			if (!result.success) throw new Error(result.error);
			setPlan(result.plan);
			setPlanRevision(sourceRevision);
		} catch (cause) {
			if (isCurrent())
				setError(
					cause instanceof Error ? cause.message : "Auto edit failed. Your timeline is unchanged.",
				);
		} finally {
			if (active.current === job) {
				active.current = null;
				setPhase(null);
				void window.electronAPI.cancelAutoEdit(job.id).catch(() => undefined);
			}
		}
	}
	return {
		phase,
		error,
		plan: planRevision === revision ? plan : null,
		transcript: transcriptRevision === revision ? transcript : null,
		transcriptGranularity: transcriptRevision === revision ? transcriptGranularity : null,
		generate,
		cancel,
		clearPlan: () => setPlan(null),
	};
}
