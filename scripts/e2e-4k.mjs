// Focused mobile smoke: one short capture → genuine 2160x3840 export.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
const realCamera = process.env.REAL_CAMERA === '1';
const exportQuality = process.env.EXPORT_QUALITY === '1080p' ? '1080p' : '4K';
const clipCount = Number(process.env.CLIP_COUNT || 1);
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const recorderEvidence = [];
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
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 15000 });
const record = page.getByRole('button', { name: 'Hold to record' });
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
  await page.waitForSelector('button[aria-label="Release to stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 2000 });
}
await page.getByText('Edit', { exact: true }).click();

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

console.log(JSON.stringify({ realCamera, exportQuality, clipCount, capture, recorderEvidence, output, bytes: fs.statSync(output).size, browserErrors: errors }, null, 2));
await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
