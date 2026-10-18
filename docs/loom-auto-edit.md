# Openscreen Loom: camera and auto edit

This custom build keeps the existing Openscreen editor and adds a live round camera preview, separate editable camera footage, a transcript-driven Codex cut planner, and an editable HyperFrames handoff.

## Record once, keep the camera editable

Enable the camera and microphone before recording. On macOS, ScreenCaptureKit excludes recorder-owned windows from the screen track, so the live HUD and its preview are visible to you but are not burned into the video. The editor adds exactly one separate camera layer. Change its position, size, mask, or visibility afterward.

Recordings made with older builds can already contain a face/HUD in the screen pixels. Hiding the editable camera layer does not remove that burned-in copy. This build does not erase or pretend to repair those originals; make a new recording for clean separation.

New macOS sessions also retain the measured camera/screen start difference. The camera can start while the native helper is preparing the screen track; that lead-in stays in the original sidecar but is skipped consistently in preview, MP4/GIF, and HyperFrames. A positive `webcamOffsetSeconds` means the camera starts later; camera source time is screen source time minus that offset. Saved projects retain this clock, while older sessions/projects without an offset keep their original zero alignment.

## Auto edit with your Codex account

1. Open a recording in the editor and click **Auto edit** in the top bar (also available in Export).
2. Describe what to remove. Long silent on-screen actions are preserved unless you explicitly enable speech-gap tightening.
3. Click **Propose cuts**. The app extracts narration to a small local audio file and transcribes it with the bundled local Whisper model. Long transcripts are planned in bounded batches; oversized/truncated input fails explicitly rather than producing a partial edit.
4. Review the source-time ranges, reasons, and proposed duration. Click **Apply cuts** to add an undoable trim update, or **Apply + export HyperFrames** to create the editable project immediately.
5. You can adjust or undo cuts in the existing timeline. MP4 export and **Edit in HyperFrames** use the same removal trims. Save the Openscreen project to retain your timeline edits.

Codex CLI must already be installed and signed in (`codex login`). The app reuses that installation's configured account, model, provider, and quota. It never extracts or copies tokens. It sends transcript text and your edit instructions through the configured Codex service; this is not local-only model inference. Raw screen/camera footage is not uploaded by this feature. Use a microphone when recording; a silent recording cannot be intelligently transcript-edited.

The planner runs with per-invocation read-only/approval restrictions, feature and MCP isolation checks, structured output, timeout/output bounds, and validated source segment IDs. A tool action, unsupported safety option, malformed plan, canceled operation, or changed project is rejected without applying cuts. Managed policies that prevent isolation disable the feature rather than weakening the checks. CLI settings are not permanently changed.

## HyperFrames project

The export creates a NEW folder containing original media, separate screen/camera/audio tracks, source offsets, current camera layout, removal trims, and a README. Existing target folders are never overwritten. HyperFrames does the editable composition; Codex proposes the cut decisions. The export does not itself invoke an unrestricted coding agent or automatically upload footage.

Openscreen-only zooms, wallpaper, crop, annotations, blur, speed changes and editable cursor effects are not transferred to HyperFrames. Continue using the normal MP4 export to bake those effects into a finished video. AI suggestions can be wrong: review and preview cuts before sharing.

## Development and publishing

On a Mac with a working Xcode/Node toolchain, `npm run build:loom` compiles the native capture helpers and packages the custom arm64 app into `release/loom/`. The stock app identity is not used. All build outputs remain ignored.

The user fork is `prag-bot/openscreen`, branch `feat/loom-camera-hyperframes`. Verified source/tests/docs updates are committed and pushed to remote `fork`. Environment files, account data, personal recordings/transcripts, generated native/app binaries and build outputs stay local.
