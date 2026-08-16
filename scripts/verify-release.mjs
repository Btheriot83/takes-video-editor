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
  run('npm', ['run', 'smoke:4k', '--', baseURL]);
  // Deterministic fast-path gate. Chromium's 4K fake camera is 2160x2160, so
  // a 1:1 export is a true dimension match and must return the original MP4
  // without loading or running an encoder.
  run('node', ['scripts/e2e-4k.mjs', baseURL], {
    env: {
      ...process.env,
      CAPTURE_QUALITY: '4K',
      EXPORT_QUALITY: '4K',
      ASPECT_RATIO: '1:1',
      EXPECT_MAX_READY_MS: '2000',
    },
  });
} finally {
  preview.kill('SIGTERM');
}

console.log('Release verification passed.');
