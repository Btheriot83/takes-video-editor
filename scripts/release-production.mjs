import { spawnSync } from 'node:child_process';

if (process.env.CONFIRM_PRODUCTION !== '1') {
  console.error(
    'Production deployment blocked. After explicit owner approval, run: ' +
      'CONFIRM_PRODUCTION=1 npm run release:production',
  );
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function read(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

const status = read('git', ['status', '--porcelain']);
if (status) {
  throw new Error('Production deployment requires a clean git worktree. Commit or remove pending files first.');
}

const head = read('git', ['rev-parse', 'HEAD']);
const upstream = read('git', ['rev-parse', '@{upstream}']);
if (head !== upstream) {
  throw new Error('Production deployment requires the current commit to be pushed to its upstream branch first.');
}

run('npm', ['run', 'release:verify']);
run('vercel', ['deploy', '.', '--prod', '--yes', '--no-wait']);

console.log('Production upload accepted. Inspect the returned Vercel URL until its status is Ready.');
