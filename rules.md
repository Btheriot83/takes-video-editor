# Project rules

- Keep the app local-first: recordings and edits stay in the browser unless the user explicitly exports or shares them.
- Preserve the mobile-first camera, editor, and offline PWA experience.
- Run `npm run lint`, `npm test`, and `npm run build` before release.
- Verify camera/import, editing, and export behavior in a real browser when those paths change.
- Never commit generated output, dependency folders, local logs, or Vercel metadata.

5. Every commit must use Conventional Commits format with one logical change, an imperative subject of at most 72 characters, and no trailing period.
6. Run `git commit` directly with a specific message before every push; never use vague subjects such as `update` or `wip`.
7. After pushing a branch, create or update its draft PR with what changed, key files, checks, UI evidence, related task, and review status.
8. Never auto-merge the PR; leave it open for human review unless the owner explicitly asks to merge it.
