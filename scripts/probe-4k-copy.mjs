// Probe: 4K-capture untrimmed clips must hit the instant COPY paths.
//
// The fake camera's portrait request first resolves to 2160x2160, which is not
// a complete UHD raster; the production retry upgrades it to 3840x2160. The
// recorder then normalizes that verified source to the selected output frame.
//  - pass 1 (CLIP_COUNT=1): expects "Camera original preserved" (mode=native)
//  - pass 2 (CLIP_COUNT=2): expects copied video with gapless normalized audio
//    (mode=remuxed) — this also exercises the mp4box codec-uniformity probe,
//    because Chrome reports the parameterless-unhelpful "video/mp4" family
//    rather than an avc1-parameterized type.
// A portrait 16:9 capture is also normalized during recording and must keep
// the same instant native path.
// Run: node scripts/probe-4k-copy.mjs [base-url]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
fs.mkdirSync(OUT, { recursive: true });
const results = [];

async function run({ clipCount, aspect, expectCopy }) {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--use-fake-device-for-media-stream',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'microphone'],
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.text().startsWith('[export]') || m.text().startsWith('[ffmpeg]')) console.log(m.text().slice(0,160)); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
  await page.getByRole('button', { name: aspect, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-camera-frame]')?.getAttribute('data-capture-verified-4k') === 'true', null, { timeout: 15000 });
  const frame = page.locator('[data-camera-frame]');
  const capture = {
    width: await frame.getAttribute('data-capture-width'),
    height: await frame.getAttribute('data-capture-height'),
  };

  const record = page.getByRole('button', { name: 'Tap to record' });
  for (let i = 0; i < clipCount; i++) {
    const box = await record.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: i + 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
    await page.waitForTimeout(1200);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 20000 });
  }

  await page.getByRole('button', { name: /Done recording\. Review \d+ clips?/ }).click();
  await page.locator('[data-editor-frame]').waitFor();
  await page.getByText('Export video', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export video' });
  // 4K-class sources must default the sheet to 4K — no manual selection.
  if (await dialog.getByRole('button', { name: '4K', exact: true }).getAttribute('aria-pressed') !== 'true') {
    throw new Error('4K-class sources did not default the export sheet to 4K');
  }
  // 4K-capture clips must NOT see the "recorded in 1080p" upscale hint.
  if (await dialog.locator('[data-upscale-hint]').count() !== 0) {
    throw new Error('upscale hint shown for 4K-capture clips');
  }
  await dialog.getByRole('button', { name: 'Start export' }).click();
  await dialog.getByText('Video ready to share or download').waitFor({ timeout: 300000 });
  const modeText = expectCopy
    ? (clipCount === 1 ? 'Camera original preserved without re-encoding.' : 'Video copied without re-encoding; audio joined seamlessly.')
    : `Rendered at 4K output resolution.`;
  await dialog.getByText(modeText).waitFor({ timeout: 5000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await dialog.getByRole('button', { name: 'Download MP4' }).click();
  const download = await downloadPromise;
  const output = `${OUT}/probe-4k-copy-${aspect.replace(':', 'x')}-${clipCount}clip.mp4`;
  await download.saveAs(output);
  const ffprobe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height', '-of', 'json', output,
  ]).toString()).streams[0];
  await browser.close();
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
  results.push({ clipCount, aspect, capture, expectCopy, modeText, output, bytes: fs.statSync(output).size, ffprobe });
}

await run({ clipCount: 1, aspect: '1:1', expectCopy: true });
await run({ clipCount: 2, aspect: '1:1', expectCopy: true });
await run({ clipCount: 1, aspect: '16:9', expectCopy: true });
console.log(JSON.stringify(results, null, 2));
console.log('PROBE-4K-COPY PASS');
