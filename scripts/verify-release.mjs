import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const baseURL = 'http://127.0.0.1:4175/';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
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
} finally {
  preview.kill('SIGTERM');
}

console.log('Release verification passed.');
