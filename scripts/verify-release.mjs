import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const baseURL = 'http://127.0.0.1:4175/';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

async function waitForPreview() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseURL, { method: 'HEAD' });
      if (response.ok) return;
    } catch {
      // The preview process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview did not become ready at ${baseURL}`);
}

run('npm', ['run', 'lint']);
run('npm', ['test']);
run('npm', ['run', 'build']);

const vite = path.resolve('node_modules/.bin/vite');
const preview = spawn(vite, ['preview', '--host', '127.0.0.1', '--port', '4175'], {
  stdio: 'inherit',
});

try {
  await waitForPreview();
  run('npm', ['run', 'smoke', '--', baseURL]);
  // iPhone WebKit can return zero bytes on the second and later MediaRecorder
  // attempts. Exercise six native 4K takes under a guard that rejects reused
  // track identities and verify the stop path uses one orderly flush per take.
  run('node', ['scripts/probe-multiclip-recorder.mjs', baseURL]);
  // A lower-resolution camera must never unlock recording or be mislabeled as
  // 4K merely because the output canvas has 4K dimensions.
  run('node', ['scripts/probe-4k-fallback.mjs', baseURL]);
  run('npm', ['run', 'smoke:4k', '--', baseURL]);
  // Deterministic fast-path gate. The verified full-UHD fake-camera stream is
  // normalized to a 2160x2160 square recording, which must return unchanged
  // without loading or running an encoder.
  run('node', ['scripts/e2e-4k.mjs', baseURL], {
    env: {
      ...process.env,
      EXPORT_QUALITY: '4K',
      ASPECT_RATIO: '1:1',
      EXPECT_MAX_READY_MS: '2000',
    },
  });
  // The field regression was specific to the selfie camera: the preview was
  // portrait while MediaRecorder persisted landscape pixels. Require two
  // saved 2160x3840 selfie clips and a zero-render fast join under two seconds.
  run('node', ['scripts/e2e-4k.mjs', baseURL], {
    env: {
      ...process.env,
      CAMERA_FACING: 'front',
      EXPORT_QUALITY: '4K',
      ASPECT_RATIO: '16:9',
      CLIP_COUNT: '2',
      EXPECT_MAX_READY_MS: '2000',
    },
  });
} finally {
  preview.kill('SIGTERM');
}

console.log('Release verification passed.');
