# Takes

A mobile-first, local-only video recorder and editor. Tap the record button to
start and stop, or press and hold then release—or import existing clips. The
default 16:9 selector produces a vertical 9:16 portrait frame; 4:3 produces 3:4
portrait, and square produces 1:1. Switch between front and rear cameras, use supported
torch and pinch-zoom controls, then trim, split, reorder, and export an MP4
without creating an account or uploading source media to a server.

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

For the browser interaction smoke test, start the preview server and run:

```sh
npm run preview -- --host 127.0.0.1
npm run smoke
```

The smoke test uses Chrome mobile/touch emulation, browser camera and microphone
permissions, and Chromium's synthetic camera. A physical mobile-device pass is
still the best final check for device-specific torch and optical zoom support.
