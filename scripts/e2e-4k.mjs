// Focused mobile smoke: one short capture → verified output mode + dimensions.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
const realCamera = process.env.REAL_CAMERA === '1';
const SLACK = Math.max(1, Number(process.env.E2E_TIME_SLACK || 1));
const exportQuality = process.env.EXPORT_QUALITY === '1080p' ? '1080p' : '4K';
const captureQuality = process.env.CAPTURE_QUALITY === '4K' ? '4K' : 'HD';
const aspectRatio = ['16:9', '4:3', '1:1'].includes(process.env.ASPECT_RATIO) ? process.env.ASPECT_RATIO : '16:9';
const cameraFacing = process.env.CAMERA_FACING === 'front' ? 'front' : 'rear';
const maxReadyMs = Number(process.env.EXPECT_MAX_READY_MS || 0);
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
if (cameraFacing === 'front') {
  await page.getByRole('button', { name: 'Switch to front camera' }).click();
  await page.waitForSelector('button[aria-label="Switch to rear camera"]:not([disabled])', { timeout: 15000 });
}
if (captureQuality === '4K') {
  await page.getByRole('button', { name: '4K', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('[data-camera-frame]')?.getAttribute('data-capture-width')) >= 2160, null, { timeout: 15000 });
}
if (aspectRatio !== '16:9') await page.getByRole('button', { name: aspectRatio, exact: true }).click();
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
await page.waitForFunction(() => {
  const editor = document.querySelector('[data-editor-active-slot]');
  const slot = editor?.getAttribute('data-editor-active-slot');
  const video = document.querySelector(`[data-editor-video-slot="${slot}"]`);
  return video instanceof HTMLVideoElement && video.videoWidth > 0 && video.videoHeight > 0;
});
const source = await page.locator('[data-editor-active-slot]').evaluate((editor) => {
  const slot = editor.getAttribute('data-editor-active-slot');
  const video = document.querySelector(`[data-editor-video-slot="${slot}"]`);
  return video instanceof HTMLVideoElement ? { width: video.videoWidth, height: video.videoHeight } : null;
});
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
const expectedHeight = aspectRatio === '1:1'
  ? expectedWidth
  : aspectRatio === '4:3'
    ? String(Math.round(Number(expectedWidth) * 4 / 3))
    : exportQuality === '4K' ? '3840' : '1920';
if (await frame.getAttribute('data-export-width') !== expectedWidth || await frame.getAttribute('data-export-height') !== expectedHeight) {
  throw new Error(`${exportQuality} ${aspectRatio} metadata is not ${expectedWidth}x${expectedHeight}`);
}
await dialog.getByText(new RegExp(`${exportQuality} · ${expectedWidth} × ${expectedHeight}`)).waitFor();
if (clipCount === 1 && encoderCoreRequests !== 0) {
  throw new Error('one-clip review downloaded the encoder before export started');
}
// Steering UX: choosing 4K over an HD-class source must surface the upscale
// hint; a genuine 4K-class capture and every 1080p export must not.
const hintCount = await dialog.locator('[data-upscale-hint]').count();
const expectUpscaleHint = exportQuality === '4K' && Math.min(source?.width ?? 0, source?.height ?? 0) < 2160;
if (expectUpscaleHint && hintCount !== 1) throw new Error('4K-over-HD upscale hint missing');
if (!expectUpscaleHint && hintCount !== 0) throw new Error('upscale hint shown for a source that already matches the export class');
const expectedMode = source?.width === Number(expectedWidth) && source?.height === Number(expectedHeight)
  ? clipCount === 1 ? 'native' : 'remuxed'
  : 'transcoded';
const expectedPreviewPath = expectedMode === 'native' ? 'native' : expectedMode === 'remuxed' ? 'join' : 'render';
const previewPath = await dialog.locator('[data-export-plan]').getAttribute('data-export-path');
if (previewPath !== expectedPreviewPath) {
  throw new Error(`expected ${expectedPreviewPath} preflight, got ${previewPath}`);
}
const exportStartedAt = performance.now();
await dialog.getByRole('button', { name: 'Start export' }).click();
await dialog.getByText('Video ready to share or download').waitFor({ timeout: 300000 });
const readyMs = Math.round(performance.now() - exportStartedAt);
const actualMode = await dialog.locator('[data-export-ready]').getAttribute('data-export-mode');
if (actualMode !== expectedMode) {
  const details = await dialog.locator('details pre').textContent();
  throw new Error(`expected ${expectedMode} export, got ${actualMode}: ${details}`);
}
if (actualMode === 'native' && encoderCoreRequests !== 0) {
  throw new Error(`native export fetched the encoder core ${encoderCoreRequests} time(s)`);
}
if (maxReadyMs > 0 && readyMs > maxReadyMs) {
  throw new Error(`${actualMode} export took ${readyMs}ms; limit is ${maxReadyMs}ms`);
}
const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await dialog.getByRole('button', { name: 'Download MP4' }).click();
const download = await downloadPromise;
const output = `${OUT}/exported-${exportQuality.toLowerCase()}-${aspectRatio.replace(':', 'x')}-${actualMode}.mp4`;
await download.saveAs(output);

// Steering UX: after an explicit 4K export choice, the Camera screen badges
// the 4K capture toggle while capture quality is still HD.
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Back to camera' }).click();
await page.waitForSelector('button[aria-label="Tap to record"]', { timeout: 15000 });
const nudgeCount = await page.locator('[data-capture-4k-nudge]').count();
const expectNudge = exportQuality === '4K' && captureQuality === 'HD';
if (expectNudge && nudgeCount !== 1) throw new Error('4K capture nudge missing after an HD-capture 4K export');
if (!expectNudge && nudgeCount !== 0) throw new Error('4K capture nudge shown when capture already matches the export choice');

console.log(JSON.stringify({ realCamera, cameraFacing, captureQuality, exportQuality, aspectRatio, clipCount, capture, source, expectedPreviewPath, previewPath, expectedMode, actualMode, readyMs, recorderEvidence, nudgeCount, output, bytes: fs.statSync(output).size, browserErrors: errors }, null, 2));
await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
