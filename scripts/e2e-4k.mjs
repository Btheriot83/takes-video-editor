// Focused mobile smoke: one short capture → verified output mode + dimensions.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
const realCamera = process.env.REAL_CAMERA === '1';
const SLACK = Math.max(1, Number(process.env.E2E_TIME_SLACK || 1));
const exportQuality = process.env.EXPORT_QUALITY === '1080p' ? '1080p' : '4K';
const captureQuality = '4K';
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
if (await page.getByRole('button', { name: 'HD', exact: true }).count()) {
  throw new Error('retired HD recording control is still visible');
}
await page.getByLabel('4K recording only').waitFor();
if (cameraFacing === 'front') {
  await page.getByRole('button', { name: 'Switch to front camera' }).click();
  await page.waitForSelector('button[aria-label="Switch to rear camera"]:not([disabled])', { timeout: 15000 });
}
await page.waitForFunction(() => document.querySelector('[data-camera-frame]')?.getAttribute('data-capture-verified-4k') === 'true', null, { timeout: 15000 });
if (aspectRatio !== '16:9') await page.getByRole('button', { name: aspectRatio, exact: true }).click();
const record = page.getByRole('button', { name: 'Tap to record' });
const cameraFrame = page.locator('[data-camera-frame]');
const capture = {
  width: await cameraFrame.getAttribute('data-capture-width'),
  height: await cameraFrame.getAttribute('data-capture-height'),
  frameRate: await cameraFrame.getAttribute('data-capture-frame-rate'),
};
const recordingWallMs = [];
for (let index = 0; index < clipCount; index++) {
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: index + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
  const startedAt = performance.now();
  await page.waitForTimeout(1100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 2000 * SLACK });
  recordingWallMs.push(Math.round(performance.now() - startedAt));
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
  return video instanceof HTMLVideoElement
    ? { width: video.videoWidth, height: video.videoHeight, duration: video.duration }
    : null;
});
const firstWallSeconds = recordingWallMs[0] / 1000;
const playbackRateRatio = source?.duration / firstWallSeconds;
if (!Number.isFinite(playbackRateRatio) || playbackRateRatio < 0.85 || playbackRateRatio > 1.15) {
  throw new Error(`recorded duration drifted from wall time: media=${source?.duration}s wall=${firstWallSeconds}s ratio=${playbackRateRatio}`);
}
if (!recorderEvidence.some((line) => line.includes('capture mode=source-synced'))) {
  throw new Error(`recorder did not use source-synced frames: ${recorderEvidence.join(' | ')}`);
}
await page.getByText('Export video', { exact: true }).click();
const dialog = page.getByRole('dialog', { name: 'Export video' });
// Explicitly choose the export quality under test; 4K is the source-matched
// default and 1080p remains an optional downscaled export.
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
// A verified UHD camera capture must never show the legacy upscale warning.
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

// A fast multi-clip join is only successful when the copied video timestamps
// and normalized AAC sample grid stay continuous at the seam. Duration alone
// misses the field failure where one AAC packet stretched to ~50ms and made a
// tiny audible dropout between otherwise gapless 4K clips.
let continuity = null;
if (clipCount > 1 && actualMode === 'remuxed') {
  const videoRows = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=key_frame,best_effort_timestamp_time', '-of', 'csv=p=0', output,
  ]).toString().trim().split('\n').map((row) => {
    const [keyFrame, timestamp] = row.split(',');
    return { keyFrame: keyFrame === '1', timestamp: Number(timestamp) };
  }).filter((row) => Number.isFinite(row.timestamp));
  const joinFrameIndex = videoRows.findIndex((row, index) => index > 0 && row.keyFrame);
  if (joinFrameIndex < 1) throw new Error('joined MP4 has no second-clip keyframe');
  const videoJoinGapMs = (videoRows[joinFrameIndex].timestamp - videoRows[joinFrameIndex - 1].timestamp) * 1000;
  if (videoJoinGapMs > 75) throw new Error(`video timestamp gap at clip join is ${videoJoinGapMs.toFixed(1)}ms`);

  const audioPts = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', output,
  ]).toString().trim().split('\n').map(Number).filter(Number.isFinite);
  const audioIntervals = audioPts.slice(1).map((pts, index) => pts - audioPts[index]);
  const sortedAudioIntervals = [...audioIntervals].sort((a, b) => a - b);
  const medianAudioInterval = sortedAudioIntervals[Math.floor(sortedAudioIntervals.length / 2)] ?? 0;
  const maxAudioInterval = Math.max(0, ...audioIntervals);
  if (!medianAudioInterval || maxAudioInterval > medianAudioInterval * 1.5) {
    throw new Error(
      `audio timestamp discontinuity: median=${(medianAudioInterval * 1000).toFixed(1)}ms max=${(maxAudioInterval * 1000).toFixed(1)}ms`,
    );
  }
  continuity = {
    videoJoinGapMs: Number(videoJoinGapMs.toFixed(1)),
    audioPacketMs: Number((medianAudioInterval * 1000).toFixed(3)),
    maxAudioPacketGapMs: Number((maxAudioInterval * 1000).toFixed(3)),
  };
}

// Recording stays 4K-only after returning from the editor.
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Back to camera' }).click();
await page.waitForSelector('button[aria-label="Tap to record"]', { timeout: 15000 });
await page.getByLabel('4K recording only').waitFor();
if (await page.getByRole('button', { name: 'HD', exact: true }).count()) throw new Error('HD recording control returned after editing');

console.log(JSON.stringify({ realCamera, cameraFacing, captureQuality, exportQuality, aspectRatio, clipCount, capture, source, recordingWallMs, playbackRateRatio, expectedPreviewPath, previewPath, expectedMode, actualMode, readyMs, continuity, recorderEvidence, output, bytes: fs.statSync(output).size, browserErrors: errors }, null, 2));
await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
