import type { CaptionSegment } from "./captioning/transcribe";

export interface AutoEditCut {
	startMs: number;
	endMs: number;
	reason: string;
	source: "codex" | "silence";
}

export interface AutoEditRequest {
	jobId: string;
	durationSeconds: number;
	instructions: string;
	segments: CaptionSegment[];
	tightenPauses: boolean;
}

export interface AutoEditPlan {
	cuts: AutoEditCut[];
	summary: string;
	originalDurationSeconds: number;
	removedSeconds: number;
}

export type AutoEditResult =
	| { success: true; plan: AutoEditPlan }
	| { success: false; error: string; canceled?: boolean };

export interface AutoEditStatus {
	available: boolean;
	message: string;
}
