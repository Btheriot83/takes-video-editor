// Probe: mixed-rotation clips must NOT concat-remux (critic repro), while
// uniform-rotation clips still hit the copy path.
//
// Two VP9-in-MP4 clips coded 1920x1080, one rotation=90 and one rotation=270,
// both DISPLAY 1080x1920 — so they pass the display-dimension match. A concat
// "-c copy" would keep only the first tkhd matrix and play the second clip
// 180° wrong; the tkhd-matrix uniformity gate must force a transcode instead.
// Control pass: two identical rotation=90 clips must still remux.
//
// Fixtures are generated with the local ffmpeg CLI (VP9 so codec-restricted
// Chromium builds can decode them on import).
// Run: CHROME_PATH=... node scripts/probe-mixed-rotation.mjs [base-url]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4173/';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takes-rot-'));
const base = path.join(dir, 'base.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=1.0',
  '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', '-y', base]);
const rotated = (name, degrees) => {
  const out = path.join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-display_rotation', String(degrees), '-i', base, '-c', 'copy', '-y', out]);
  return out;
};
const r90 = rotated('r90.mp4', 90);
const r90b = rotated('r90b.mp4', 90);
const r270 = rotated('r270.mp4', 270);

async function run(files, expectText, label) {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'], hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
  await page.setInputFiles('input[type="file"]', files);
  await page.locator('[data-editor-frame]').waitFor({ timeout: 20000 });
  await page.getByText('Export video', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export video' });
  await dialog.getByRole('button', { name: '1080p', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start export' }).click();
  await dialog.getByText('Video ready to share or download').waitFor({ timeout: 300000 });
  await dialog.getByText(expectText).waitFor({ timeout: 5000 });
  await browser.close();
  if (errors.length) throw new Error(`${label}: browser errors: ${errors.join(' | ')}`);
  console.log(`${label} OK -> ${expectText}`);
}

await run([r90, r270], 'Rendered at 1080p output resolution.', 'MIXED-ROTATION (90+270 must transcode)');
await run([r90, r90b], 'Video copied without re-encoding; audio joined seamlessly.', 'UNIFORM-ROTATION (90+90 must remux)');
fs.rmSync(dir, { recursive: true, force: true });
console.log('PROBE-MIXED-ROTATION PASS');
