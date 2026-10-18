# Openscreen Loom local development

- This is the user's custom Loom-style recorder and editable HyperFrames integration. Preserve the existing editor UI.
- The user's GitHub fork is `prag-bot/openscreen` (remote `fork`). `origin` is the read-only upstream `siddharthvaddem/openscreen`.
- Standing user request (October 18, 2026): commit and push every verified update we make to the user's fork. Push the current feature branch to `fork`; never push to upstream. Keep incomplete/untested changes local until verified, and report any push failure honestly.
- Stage explicit source/test/documentation paths. Never commit or push `.env*`, credentials, personal recordings/transcripts, app bundles, generated builds, or scratch assets.
- Run `/usr/bin/python3 /Users/p.sharma@opendoor.com/.codex/worktree-env/bootstrap.py --cwd <checkout>` before app commands and worktree lifecycle actions. Read its JSON status only. Environment files stay local and ignored; do not overwrite existing files or share credentials between repos.
- Keep original screen, camera and audio footage intact. AI edits must be validated, reviewable, undoable removal ranges, shared by the editor and HyperFrames export.
- Reuse the installed Codex CLI login/configuration for optional transcript-based editing; never extract or copy account tokens. Keep transcript processing and quota disclosure explicit.
