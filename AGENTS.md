# Openscreen Loom local development

- This is the user's custom Loom-style recorder and editable HyperFrames integration. Preserve the existing editor UI.
- The user's GitHub fork is `prag-bot/openscreen`. In the original checkout, remote `fork` points there and `origin` points to upstream `siddharthvaddem/openscreen`. In another clone, verify remotes and use the one pointing to the user's fork.
- Standing user request (October 18, 2026): commit and push every verified update we make to the user's fork. Push the current feature branch there; never push to upstream. Keep incomplete/untested changes local until verified, and report any push failure honestly.
- Stage explicit source/test/documentation paths. Never commit or push `.env*`, credentials, personal recordings/transcripts, app bundles, generated builds, or scratch assets.
- When available, run `/usr/bin/python3 "$HOME/.codex/worktree-env/bootstrap.py" --cwd <checkout>` before app commands and worktree lifecycle actions. Read its JSON status only. Environment files stay local and ignored; do not overwrite existing files or share credentials between repos.
- Keep original screen, camera and audio footage intact. AI edits must be validated, reviewable, undoable removal ranges, shared by the editor and HyperFrames export.
- Reuse the installed Codex CLI login/configuration for optional transcript-based editing; never extract or copy account tokens. Keep transcript processing and quota disclosure explicit.
- The canonical local app is the Projects copy. Ad-hoc rebuilds change its permission identity: stage and verify updates first, retain the working build, and coordinate app-specific reauthorization before replacing it. Never globally reset privacy permissions or weaken signing requirements to bypass a denial.
- Keep build staging in a `.noindex` directory and retain rollback builds as verified archives, not additional searchable app bundles. The Projects app is the only user-facing installation; do not create new registered copies when packaging updates.
