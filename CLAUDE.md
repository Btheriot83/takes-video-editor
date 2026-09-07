# Takes camera app — Claude Code handoff

Read and follow `rules.md` before changing code. The working project is
`/Users/brandontheriot/projects/camera-app` and the public repository is
`https://github.com/Btheriot83/takes-video-editor`.

## Verification

Run `npm run release:verify` before proposing or deploying a release. It runs
lint, unit tests, the production build, the full mobile capture/edit/export
smoke, and the dedicated 4K export smoke sequentially. Do not bypass a failed
check or run the two browser export smokes concurrently.

## Production deployment

Production deployment requires Brandon's explicit approval for that release.
Commit and push the verified release branch first. After approval, run:

```bash
CONFIRM_PRODUCTION=1 npm run release:production
```

This checkout is locally linked (through ignored `.vercel/project.json`) to the
existing `takes-video-editor` Vercel project. The command verifies the release
and refuses dirty or unpushed revisions before uploading it. Inspect the
returned deployment URL with `vercel inspect` until its status is `Ready`, then
report the live alias:
`https://takes-video-editor.vercel.app`.

Never commit `.vercel`, credentials, generated output, or test media. If Vercel
authentication is missing, stop and let Brandon complete `vercel login`; never
ask him to paste a token into chat.
