# camera-app

## Codex routing and continuity

Takes: local-first browser camera, editor and 4K export PWA.

Read `rules.md`, `CLAUDE.md`, `README.md`, selecting only the task-relevant sections after the current scope.

Reuse `SESSION-HANDOFF.md` for handoff. Before ending long sessions or switching tasks/models, update your own entry with date, session, checkout/branch/HEAD, authorized scope, evidence/checks, failures, next step and owner gates. Do not overwrite another session’s status. Reverify dated claims before acting.

Verified command entrypoints (run only checks relevant to the change): `npm run lint`, `npm test`. Inspect script side effects and dependencies before execution.

Preserve camera/import/edit/export and local-only recordings. Release verification includes heavy browser export smokes: serialize them and run only in an authorized release task. Routine software delivery follows the global default through the established pipeline after required checks; explicit task release holds remain binding.
