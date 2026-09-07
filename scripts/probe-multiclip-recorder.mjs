// Deterministic regression for the iPhone/WebKit "second take is empty" bug.
// The browser shim rejects any attempt to attach two MediaRecorder instances
// to the same video-track object. A passing run therefore proves that every
// take gets isolated tracks while the live preview camera stays open.
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://localhost:4173/';
const CLIP_COUNT = 6;
const errors = [];
const captureModes = [];

function installRecorderHarness({ emptyRecorderNumber }) {
  // Chromium's fake 4K camera exposes landscape intrinsic dimensions. Make
  // only the camera preview report the display-oriented portrait dimensions
  // an iPhone supplies so this probe exercises the direct native-track path
  // implicated by the field failure (not the already-isolated canvas path).
  const videoWidth = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth');
  const videoHeight = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoHeight');
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    get() {
      return this.hasAttribute('data-camera-preview') ? 2160 : videoWidth?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    get() {
      return this.hasAttribute('data-camera-preview') ? 3840 : videoHeight?.get?.call(this) ?? 0;
    },
  });

  const NativeMediaRecorder = window.MediaRecorder;
  const nativeRequestData = NativeMediaRecorder.prototype.requestData;
  const usedVideoTracks = new WeakSet();
  const stats = {
    recorderTrackIds: [],
    requestDataCalls: 0,
    recorderCount: 0,
  };

  NativeMediaRecorder.prototype.requestData = function requestData(...args) {
    stats.requestDataCalls += 1;
    return nativeRequestData.apply(this, args);
  };

  const GuardedMediaRecorder = new Proxy(NativeMediaRecorder, {
    construct(target, args) {
      const stream = args[0];
      const videoTrack = stream?.getVideoTracks?.()[0];
      if (videoTrack && usedVideoTracks.has(videoTrack)) {
        throw new DOMException('Synthetic WebKit repeat-track failure', 'NotSupportedError');
      }
      if (videoTrack) {
        usedVideoTracks.add(videoTrack);
        stats.recorderTrackIds.push(videoTrack.id);
      }
      stats.recorderCount += 1;
      const recorder = Reflect.construct(target, args);
      if (stats.recorderCount === emptyRecorderNumber) {
        // WebKit's field failure still fires stop but delivers no usable data.
        // Capture first so the app's later dataavailable listener never sees it.
        recorder.addEventListener('dataavailable', (event) => event.stopImmediatePropagation());
      }
      return recorder;
    },
  });

  Object.defineProperty(window, 'MediaRecorder', {
    configurable: true,
    value: GuardedMediaRecorder,
  });
  Object.defineProperty(window, '__takesRecorderStats', {
    configurable: true,
    value: stats,
  });
}

async function recordTake(page, cdp, id) {
  const record = page.getByRole('button', { name: 'Tap to record' });
  const box = await record.boundingBox();
  if (!box) throw new Error(`record control missing before take ${id}`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5_000 });
  await page.waitForTimeout(1_200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'microphone'],
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  });

  await context.addInitScript(installRecorderHarness, { emptyRecorderNumber: 0 });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.on('console', (message) => {
    const value = message.text();
    if (value.startsWith('[rec] capture mode=')) captureModes.push(value);
    if (message.type() === 'error') errors.push(value);
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Switch to front camera' }).click();
  await page.waitForSelector('button[aria-label="Switch to rear camera"]:not([disabled])', { timeout: 15_000 });

  const previewTrackBefore = await page.locator('[data-camera-preview]').evaluate((video) =>
    video.srcObject?.getVideoTracks?.()[0]?.id ?? null);
  if (!previewTrackBefore) throw new Error('preview camera has no video track');

  for (let index = 0; index < CLIP_COUNT; index += 1) {
    await recordTake(page, cdp, index + 1);
    await page.getByRole('button', {
      name: `Done recording. Review ${index + 1} clip${index === 0 ? '' : 's'}`,
    }).waitFor({ timeout: 10_000 });
    await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 10_000 });
    if (await page.getByText(/The recording could not be saved/).count()) {
      throw new Error(`clip ${index + 1} hit the empty-recording alert`);
    }
  }

  const previewTrackAfter = await page.locator('[data-camera-preview]').evaluate((video) =>
    video.srcObject?.getVideoTracks?.()[0]?.id ?? null);
  const stats = await page.evaluate(() => window.__takesRecorderStats);

  if (previewTrackAfter !== previewTrackBefore) {
    throw new Error('the live camera was unnecessarily reopened between healthy takes');
  }
  if (stats.recorderTrackIds.length !== CLIP_COUNT) {
    throw new Error(`expected ${CLIP_COUNT} recorder tracks, got ${stats.recorderTrackIds.length}`);
  }
  if (new Set(stats.recorderTrackIds).size !== CLIP_COUNT) {
    throw new Error(`recorder track identities were reused: ${stats.recorderTrackIds.join(', ')}`);
  }
  if (stats.recorderTrackIds.includes(previewTrackBefore)) {
    throw new Error('a recorder was attached directly to the reusable preview track');
  }
  if (stats.requestDataCalls !== CLIP_COUNT) {
    throw new Error(`expected one orderly flush per take, got ${stats.requestDataCalls}`);
  }
  if (captureModes.filter((line) => line.includes('camera-native')).length !== CLIP_COUNT) {
    throw new Error(`native 4K path was not retained for every take: ${captureModes.join(' | ')}`);
  }
  if (errors.length) throw new Error(`browser reported errors: ${errors.join(' | ')}`);

  console.log(JSON.stringify({
    clips: CLIP_COUNT,
    previewTrackStable: true,
    isolatedRecorderTracks: stats.recorderTrackIds.length,
    orderlyFlushes: stats.requestDataCalls,
    captureMode: 'camera-native',
  }, null, 2));
  await context.close();

  // Now force the exact field shape once: take 1 succeeds, take 2 stops with
  // no data, then take 3 succeeds. The empty attempt must reset the camera
  // automatically, preserve take 1, and never trap recording behind an alert.
  const recoveryErrors = [];
  const recoveryContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'microphone'],
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  });
  await recoveryContext.addInitScript(installRecorderHarness, { emptyRecorderNumber: 2 });
  const recoveryPage = await recoveryContext.newPage();
  const recoveryCdp = await recoveryContext.newCDPSession(recoveryPage);
  recoveryPage.on('console', (message) => {
    const value = message.text();
    if (message.type() === 'error' && !value.startsWith('[cam] stop recording failed')) {
      recoveryErrors.push(value);
    }
  });
  recoveryPage.on('pageerror', (error) => recoveryErrors.push(String(error)));

  await recoveryPage.goto(BASE, { waitUntil: 'load' });
  await recoveryPage.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15_000 });
  await recoveryPage.getByRole('button', { name: 'Switch to front camera' }).click();
  await recoveryPage.waitForSelector('button[aria-label="Switch to rear camera"]:not([disabled])', { timeout: 15_000 });

  await recordTake(recoveryPage, recoveryCdp, 21);
  await recoveryPage.getByRole('button', { name: 'Done recording. Review 1 clip' }).waitFor({ timeout: 10_000 });
  await recoveryPage.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 10_000 });

  await recordTake(recoveryPage, recoveryCdp, 22);
  await recoveryPage.getByText('That take did not save. Camera reset — record it again.').waitFor({ timeout: 15_000 });
  await recoveryPage.getByRole('button', { name: 'Done recording. Review 1 clip' }).waitFor();
  await recoveryPage.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15_000 });
  if (await recoveryPage.getByText(/The recording could not be saved/).count()) {
    throw new Error('empty take still left the blocking save alert visible');
  }

  await recordTake(recoveryPage, recoveryCdp, 23);
  await recoveryPage.getByRole('button', { name: 'Done recording. Review 2 clips' }).waitFor({ timeout: 10_000 });
  await recoveryPage.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 10_000 });
  if (recoveryErrors.length) throw new Error(`recovery browser errors: ${recoveryErrors.join(' | ')}`);
  console.log(JSON.stringify({
    injectedEmptyTake: 2,
    preservedClipsAfterFailure: 1,
    clipsAfterRetry: 2,
    blockingAlert: false,
  }, null, 2));
  await recoveryContext.close();

  console.log('PROBE MULTICLIP RECORDER PASS');
} finally {
  await browser.close();
}
