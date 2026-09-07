// Repro/verify: import a VIDEO-ONLY webm via the app's Import control, export,
// and report whether the export succeeds and what streams the MP4 contains.
// Run: CHROME_PATH=... node scripts/probe-noaudio.mjs http://localhost:PORT/ /tmp/video-only.webm
// WCODEC=vp09.00.51.08 adds the test-only ?wcodec= override so the silent-clip
// export exercises the WebCodecs direct-mux pipeline (worker render + mp4-muxer
// audio/video) instead of the wasm encoder.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://localhost:4173/';
const FILE = process.argv[3] || '/tmp/video-only.webm';
const OUT = 'scripts/e2e-out';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const exportLogs = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[export]') || t.includes('matches no streams') || t.includes('Stream specifier')) exportLogs.push(t);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push(String(e)));

const url = new URL(BASE);
if (process.env.WCODEC) url.searchParams.set('wcodec', process.env.WCODEC);
await page.goto(url.toString(), { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
await page.setInputFiles('input[type="file"]', FILE);
await page.waitForSelector('[data-editor-frame], [data-clip]', { timeout: 20000 }).catch(() => {});
// Import may land on camera or editor; go to editor if needed.
if (!(await page.locator('[data-editor-frame]').count())) {
  await page.getByText('Timeline', { exact: true }).click().catch(() => {});
}
await page.locator('[data-editor-frame]').waitFor({ timeout: 10000 });
await page.getByText('Export video', { exact: true }).click();
const dialog = page.getByRole('dialog', { name: 'Export video' });
await dialog.getByRole('button', { name: '1080p', exact: true }).click();
await dialog.getByRole('button', { name: 'Start export' }).click();
const outcome = await Promise.race([
  dialog.getByText('Video ready to share or download').waitFor({ timeout: 240000 }).then(() => 'ready'),
  dialog.locator('.text-red-400').waitFor({ timeout: 240000 }).then(async () => 'error: ' + (await dialog.locator('.text-red-400').textContent())),
]);

let probe = null;
if (outcome === 'ready') {
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await dialog.getByRole('button', { name: 'Download MP4' }).click();
  const download = await downloadPromise;
  const output = `${OUT}/exported-noaudio.mp4`;
  await download.saveAs(output);
  probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', output]).toString();
}
console.log(JSON.stringify({ outcome, probe: probe && JSON.parse(probe), exportLogs, errors: errors.slice(0, 10) }, null, 2));
await browser.close();
