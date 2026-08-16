// Focused mobile smoke: one short capture → genuine 2160x3840 export.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
const realCamera = process.env.REAL_CAMERA === '1';
const SLACK = Math.max(1, Number(process.env.E2E_TIME_SLACK || 1));
const exportQuality = process.env.EXPORT_QUALITY === '1080p' ? '1080p' : '4K';
const clipCount = Number(process.env.CLIP_COUNT || 1);
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const recorderEvidence = [];
let encoderCoreRequests = 0;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    ...(!realCamera ? ['--use-fake-device-for-media-stream'] : []),
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
page.on('console', (message) => {
  if (message.text().startsWith('[rec]')) recorderEvidence.push(message.text());
  if (message.type() === 'error') errors.push(message.text());
});
page.on('request', (request) => {
  if (request.url().includes('/ffmpeg/ffmpeg-core.wasm')) encoderCoreRequests += 1;
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
const record = page.getByRole('button', { name: 'Tap to record' });
const cameraFrame = page.locator('[data-camera-frame]');
const capture = {
  width: await cameraFrame.getAttribute('data-capture-width'),
  height: await cameraFrame.getAttribute('data-capture-height'),
  frameRate: await cameraFrame.getAttribute('data-capture-frame-rate'),
};
for (let index = 0; index < clipCount; index++) {
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: index + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 2000 * SLACK });
}
await page.getByRole('button', { name: new RegExp(`Done recording\\. Review ${clipCount} clip`) }).click();

const frame = page.locator('[data-editor-frame]');
await frame.waitFor();
await page.getByText('Export video', { exact: true }).click();
const dialog = page.getByRole('dialog', { name: 'Export video' });
// The sheet defaults to the source class (1080p for HD fake-camera clips),
// so always click the quality under test explicitly.
if (exportQuality === '1080p') {
  await dialog.getByRole('button', { name: '1080p', exact: true }).click();
} else {
  await dialog.getByRole('button', { name: '4K', exact: true }).click();
}
const expectedWidth = exportQuality === '4K' ? '2160' : '1080';
const expectedHeight = exportQuality === '4K' ? '3840' : '1920';
if (await frame.getAttribute('data-export-width') !== expectedWidth || await frame.getAttribute('data-export-height') !== expectedHeight) {
  throw new Error(`${exportQuality} portrait metadata is not ${expectedWidth}x${expectedHeight}`);
}
await dialog.getByText(new RegExp(`${exportQuality} · ${expectedWidth} × ${expectedHeight}`)).waitFor();
if (clipCount === 1 && encoderCoreRequests !== 0) {
  throw new Error('one-clip review downloaded the encoder before export started');
}
// Steering UX: choosing 4K over HD-capture clips must surface the upscale
// hint (and 1080p must not) — fake-camera clips here are HD-class.
const hintCount = await dialog.locator('[data-upscale-hint]').count();
if (exportQuality === '4K' && hintCount !== 1) throw new Error('4K-over-HD upscale hint missing');
if (exportQuality === '1080p' && hintCount !== 0) throw new Error('upscale hint shown for 1080p export');
await dialog.getByRole('button', { name: 'Start export' }).click();
await dialog.getByText('Video ready to share or download').waitFor({ timeout: 300000 });
if (exportQuality === '1080p') {
  await dialog.getByText(clipCount === 1
    ? 'Camera original preserved without re-encoding.'
    : 'Clips joined without re-encoding.').waitFor();
}
const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await dialog.getByRole('button', { name: 'Download MP4' }).click();
const download = await downloadPromise;
const output = `${OUT}/${exportQuality === '4K' ? 'exported-4k.mp4' : clipCount === 1 ? 'exported-native.mp4' : 'exported-remuxed.mp4'}`;
await download.saveAs(output);

// Steering UX: after an explicit 4K export choice, the Camera screen badges
// the 4K capture toggle while capture quality is still HD.
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Back to camera' }).click();
await page.waitForSelector('button[aria-label="Tap to record"]', { timeout: 15000 });
const nudgeCount = await page.locator('[data-capture-4k-nudge]').count();
if (exportQuality === '4K' && nudgeCount !== 1) throw new Error('4K capture nudge missing after a 4K export choice');
if (exportQuality === '1080p' && nudgeCount !== 0) throw new Error('4K capture nudge shown without a 4K export choice');

console.log(JSON.stringify({ realCamera, exportQuality, clipCount, capture, recorderEvidence, nudgeCount, output, bytes: fs.statSync(output).size, browserErrors: errors }, null, 2));
await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
