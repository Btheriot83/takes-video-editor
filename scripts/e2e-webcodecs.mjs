// Proves the WebCodecs export path end-to-end when a VideoEncoder IS available.
// Headless Chromium ships no H.264 encoder, so this run forces the test-only
// codec override (vp9, which it can encode) through the exact same pipeline:
// <video> decode -> rVFC capture -> OffscreenCanvas -> VideoEncoder ->
// mp4-muxer -> wasm AAC audio -> "-c copy" faststart remux.
// Run: node scripts/e2e-webcodecs.mjs http://localhost:PORT/
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
const clipCount = Number(process.env.CLIP_COUNT || 2);
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const exportLogs = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
await context.addInitScript(() => {
  localStorage.setItem('takes:webcodecs-codec', 'vp09.00.51.08');
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('[export]')) exportLogs.push(text);
  if (message.type() === 'error') errors.push(text);
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 15000 });
const record = page.getByRole('button', { name: 'Hold to record' });
for (let index = 0; index < clipCount; index++) {
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: index + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Release to stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 2000 });
}
await page.getByText('Edit', { exact: true }).click();
await page.locator('[data-editor-frame]').waitFor();

await page.getByText('Export video', { exact: true }).click();
const dialog = page.getByRole('dialog', { name: 'Export video' });
await dialog.getByText(/4K · 2160 × 3840/).waitFor();
await dialog.getByText('Video ready to share or download').waitFor({ timeout: 300000 });
const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await dialog.getByRole('button', { name: 'Download MP4' }).click();
const download = await downloadPromise;
const output = `${OUT}/exported-webcodecs.mp4`;
await download.saveAs(output);

const usedWebCodecs = exportLogs.some((l) => l.includes('using webcodecs encoder'));
const fellBack = exportLogs.some((l) => l.includes('webcodecs path failed'));
console.log(JSON.stringify({ clipCount, output, bytes: fs.statSync(output).size, usedWebCodecs, fellBack, exportLogs, browserErrors: errors }, null, 2));
await browser.close();
if (!usedWebCodecs || fellBack) throw new Error('export did not complete through the WebCodecs path');
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
