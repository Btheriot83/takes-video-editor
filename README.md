# Takes

A mobile-first, local-only video recorder and editor. Record or import clips,
trim and reorder them, then export an MP4 without creating an account or
uploading source media to a server.

## Development

Requires a current Node.js release and npm.

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`. Camera and microphone access require browser
permission and a secure context (`localhost` or HTTPS).

## Checks

```sh
npm run lint
npm test
npm run build
```

The production output is written to `dist/`.
