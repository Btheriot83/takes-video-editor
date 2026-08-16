// Headless end-to-end: fake camera → record 3 clips → edit → export → verify MP4.
// Run: npm run smoke -- [baseURL]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
// Timing-assertion multiplier for slow CI/sandbox machines (default 1 keeps
// the strict local-dev budgets). Only stretches timeouts; asserts unchanged.
const SLACK = Math.max(1, Number(process.env.E2E_TIME_SLACK || 1));
const OUT = 'scripts/e2e-out';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
let mediaRecorderStarts = 0;
let encoderPrefetchRequestAt = null;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone 14-ish
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[rec] started, state=')) mediaRecorderStarts += 1;
  if (t.includes('[ffmpeg]') || t.includes('[export]')) fs.appendFileSync(OUT + '/ffmpeg.log', t + '\n');
  if (m.type() === 'error') errors.push(`${t} (${m.location().url || 'unknown URL'})`);
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (request) => {
  if (!encoderPrefetchRequestAt && request.url().includes('/ffmpeg/ffmpeg-core.wasm')) {
    encoderPrefetchRequestAt = Date.now();
  }
});
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`);
});

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
await page.screenshot({ path: `${OUT}/1-camera.png` });
log('camera open');

// A fresh/empty project must visibly default to vertical 9:16 output.
const defaultFrame = page.locator('[data-camera-frame]');
const defaultBox = await defaultFrame.boundingBox();
if (Math.abs(defaultBox.width / defaultBox.height - 9 / 16) > 0.03) {
  throw new Error(`default frame is not portrait 9:16: ${(defaultBox.width / defaultBox.height).toFixed(2)}`);
}
const captureFps = Number(await defaultFrame.getAttribute('data-capture-frame-rate'));
if (captureFps && captureFps > 30.1) throw new Error(`camera exceeded the requested 30fps ceiling: ${captureFps}`);
if (!(await page.getByRole('button', { name: '16:9', exact: true }).getAttribute('aria-pressed') === 'true')) {
  throw new Error('16:9 selector is not the default');
}
await page.getByText('9:16 portrait', { exact: true }).waitFor();
log('default portrait 9:16 frame verified');

// The selector must be fully visible and finger-sized on the mobile viewport.
await page.setViewportSize({ width: 320, height: 568 });
await page.screenshot({ path: `${OUT}/1-camera-compact.png` });
const viewport = page.viewportSize();
for (const ratio of ['16:9', '4:3', '1:1', 'HD', '4K']) {
  const box = await page.getByRole('button', { name: ratio, exact: true }).boundingBox();
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) {
    throw new Error(`${ratio} selector is clipped on the mobile viewport`);
  }
  if (box.width < 44 || box.height < 44) throw new Error(`${ratio} selector hitbox is ${box.width}x${box.height}, expected at least 44x44`);
}
log('mobile ratio + quality selector visibility and hitboxes verified at 320x568');
await page.setViewportSize({ width: 390, height: 844 });

// Capture quality: HD must be the default, and choosing 4K must reopen the
// stream. The fake camera cannot promise 4K, so either the badge reports a
// true >=2160 capture or the graceful "not available" notice must appear.
if (await page.getByRole('button', { name: 'HD', exact: true }).getAttribute('aria-pressed') !== 'true') {
  throw new Error('HD capture quality is not the default');
}
await page.getByRole('button', { name: '4K', exact: true }).click();
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
const qualityFrame = page.locator('[data-camera-frame]');
if (await qualityFrame.getAttribute('data-capture-quality') !== '4K') throw new Error('frame did not reflect the 4K capture setting');
// The 4K request may need up to three sequential getUserMedia attempts
// (portrait ideal -> landscape retry -> portrait reopen), and the
// "not available" notice auto-dismisses after ~2.2s — so poll until either
// a true 4K-class capture is reported or the notice is seen, rather than
// reading the state once and racing both.
{
  const deadline = Date.now() + 12000;
  let capW = 0; let capH = 0; let outcome = null;
  while (Date.now() < deadline && !outcome) {
    capW = Number(await qualityFrame.getAttribute('data-capture-width')) || 0;
    capH = Number(await qualityFrame.getAttribute('data-capture-height')) || 0;
    if (Math.min(capW, capH) >= 2160) outcome = 'delivered';
    else if (await page.getByText('4K not available on this camera').isVisible().catch(() => false)) outcome = 'notice';
    else await page.waitForTimeout(150);
  }
  if (outcome === 'delivered') {
    log(`4K capture delivered (${capW}x${capH})`);
  } else if (outcome === 'notice') {
    const badge = await page.locator('[data-capture-badge]').textContent();
    if (capW && capH && !badge.includes(`${capW}×${capH}`)) throw new Error(`capture badge "${badge}" does not reflect actual ${capW}x${capH}`);
    log(`4K unavailable fallback verified (actual ${capW || '?'}x${capH || '?'} shown honestly)`);
  } else {
    // Notice may have flashed and expired between polls; the honest badge is
    // the durable affordance — accept it as the fallback evidence.
    const badge = await page.locator('[data-capture-badge]').textContent();
    if (!(capW && capH) || !badge.includes(`${capW}×${capH}`)) {
      throw new Error(`4K selection settled neither on 4K capture nor an honest fallback (got ${capW}x${capH}, badge "${badge}")`);
    }
    log(`4K unavailable fallback verified via badge (actual ${capW}x${capH}; notice expired between polls)`);
  }
}
await page.getByRole('button', { name: 'HD', exact: true }).click();
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
if (await qualityFrame.getAttribute('data-capture-quality') !== 'HD') throw new Error('switching back to HD capture failed');
log('capture quality toggle verified (back on HD)');

// verify every project frame option changes the actual capture viewport
for (const ratio of ['16:9', '4:3', '1:1']) {
  await page.getByRole('button', { name: ratio, exact: true }).click();
  const box = await page.locator('[data-camera-frame]').boundingBox();
  const expected = ratio === '16:9' ? 9 / 16 : ratio === '4:3' ? 3 / 4 : 1;
  const actual = box.width / box.height;
  if (Math.abs(actual - expected) > 0.03) throw new Error(`${ratio} frame rendered at ${actual.toFixed(2)}`);
  log(`${ratio} frame verified`);
}

// Record and edit in the portrait default, rather than whichever option the
// selector loop happened to visit last.
await page.getByRole('button', { name: '16:9', exact: true }).click();

// conventional front/rear switch must reopen the alternate facing request
await page.getByRole('button', { name: 'Switch to front camera' }).click();
await page.waitForSelector('button[aria-label="Switch to rear camera"]:not([disabled])', { timeout: 15000 });
await page.getByRole('button', { name: 'Switch to rear camera' }).click();
await page.waitForSelector('button[aria-label="Switch to front camera"]:not([disabled])', { timeout: 15000 });
log('front/rear switch verified');

// fake Chromium camera exposes no torch; the UI must state that honestly
const flash = page.getByRole('button', { name: /Flash/ });
const flashName = await flash.getAttribute('aria-label');
if (flashName === 'Flash unavailable') {
  if (!(await flash.isDisabled())) throw new Error('unavailable flash control should be disabled');
  log('flash unavailable state verified');
} else {
  const beforeFlash = await flash.getAttribute('aria-pressed');
  await flash.click();
  const afterFlash = await flash.getAttribute('aria-pressed');
  if (beforeFlash === afterFlash) throw new Error('flash toggle state did not change');
  log('flash toggle verified');
}

// exercise two-pointer pinch; unsupported cameras must show a clear fallback
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: 150, y: 300, id: 41 }, { x: 240, y: 300, id: 42 }],
});
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchMove',
  touchPoints: [{ x: 120, y: 300, id: 41 }, { x: 290, y: 300, id: 42 }],
});
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(250);
const zoomText = await page.locator('[data-camera-frame]').textContent();
const fallbackVisible = await page.getByText('Pinch zoom is unavailable on this camera').isVisible().catch(() => false);
if (!fallbackVisible && !/([2-9]|1\.[1-9])×/.test(zoomText)) throw new Error('pinch zoom produced neither zoom nor fallback state');
log(fallbackVisible ? 'pinch zoom fallback verified' : 'pinch zoom verified');

// Assistive technologies activate a button through its click contract rather
// than pointerdown/up. That path must start and stop a real saved recording.
await page.getByRole('button', { name: 'Tap to record' }).evaluate((button) => button.click());
await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
await page.waitForTimeout(2100);
await page.getByRole('button', { name: 'Stop recording' }).evaluate((button) => button.click());
await page.waitForSelector('[data-saved-notice]', { timeout: 5000 });
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 5000 });
if (mediaRecorderStarts !== 1) throw new Error(`assistive click started ${mediaRecorderStarts} recorders`);
log('assistive click record/stop path verified');

// Record 3 additional clips of ~2s each: clips 2-3 via the classic hold
// gesture (touchEnd / touchCancel releases), clip 4 via the tap-toggle path.
for (let i = 0; i < 3; i++) {
  const record = page.getByRole('button', { name: 'Tap to record' });
  const recordBox = await record.boundingBox();
  const recordPoint = { x: recordBox.x + recordBox.width / 2, y: recordBox.y + recordBox.height / 2, id: i + 1 };

  if (i === 2) {
    // TAP-TOGGLE: a short tap (<350ms press) starts the recording, which must
    // CONTINUE after the finger lifts; the button becomes an explicit red
    // Stop control; a second tap stops and saves.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [recordPoint] });
    await page.waitForTimeout(80);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
    await page.waitForTimeout(900);
    if (await page.locator('[data-record-state]').getAttribute('data-record-state') !== 'recording') {
      throw new Error('tap-started recording did not continue after the finger lifted');
    }
    if (!(await page.getByRole('button', { name: 'Stop recording' }).isVisible())) {
      throw new Error('record button did not become a Stop control after a tap');
    }
    await page.waitForTimeout(1100);
    const tapStopStarted = Date.now();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...recordPoint, id: 31 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => document.querySelector('[data-record-state]')?.getAttribute('data-record-state') !== 'recording', null, { timeout: 750 * SLACK });
    const tapStopLatency = Date.now() - tapStopStarted;
    await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 1500 * SLACK });
    // The tap-recorded clip must be SAVED like any other.
    await page.waitForSelector('[data-saved-notice]', { timeout: 5000 });
    const savedText = await page.locator('[data-saved-notice]').textContent();
    if (!savedText.includes('4 clips')) throw new Error(`tap-toggle clip not saved: toast "${savedText}"`);
    await page.waitForTimeout(600);
    if (mediaRecorderStarts !== 4) throw new Error(`expected 4 recorder starts, got ${mediaRecorderStarts}`);
    log(`clip 4 recorded via tap-toggle (continued after lift; tap-stop in ${tapStopLatency}ms; saved toast "${savedText}")`);
    continue;
  }

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [recordPoint] });
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });

  if (i === 0) {
    // A second finger/down event while the primary hold is active must not
    // create another MediaRecorder. The first hold must remain recording.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [recordPoint, { ...recordPoint, x: recordPoint.x + 6, id: 99 }],
    });
    await page.waitForTimeout(700);
    if (!(await page.getByRole('button', { name: 'Stop recording' }).isVisible())) {
      throw new Error('recording did not continue while the touch was held');
    }
    if (mediaRecorderStarts !== 2) throw new Error(`duplicate hold started ${mediaRecorderStarts} recorders`);
    // Ratio and quality selectors must lock while a recording is running.
    for (const control of ['16:9', 'HD', '4K']) {
      if (!(await page.getByRole('button', { name: control, exact: true }).isDisabled())) {
        throw new Error(`${control} selector stayed enabled while recording`);
      }
    }
    log('ratio + quality selectors locked during recording');
  }
  await page.waitForTimeout(2000);
  const releaseStarted = Date.now();
  const releaseType = i === 1 ? 'touchCancel' : 'touchEnd';
  await cdp.send('Input.dispatchTouchEvent', { type: releaseType, touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('[data-record-state]')?.getAttribute('data-record-state') !== 'recording', null, { timeout: 750 * SLACK });
  const releaseLatency = Date.now() - releaseStarted;
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 1500 * SLACK });
  await page.waitForTimeout(600);
  if (mediaRecorderStarts !== i + 2) throw new Error(`expected ${i + 2} recorder starts, got ${mediaRecorderStarts}`);
  log(`clip ${i + 2} recorded; ${releaseType} stopped in ${releaseLatency}ms`);
}
await page.screenshot({ path: `${OUT}/2-recorded.png` });

// Once the user has the clips they want, the next step must be explicit,
// finger-sized, fully visible on the narrow supported viewport, and actually
// open the review/editor screen. "Edit" alone did not explain that flow.
const reviewClips = page.getByRole('button', { name: 'Done recording. Review 4 clips' });
await reviewClips.waitFor();
if (!encoderPrefetchRequestAt) throw new Error('multi-clip encoder download did not start during recording flow');
await page.setViewportSize({ width: 320, height: 568 });
const reviewBox = await reviewClips.boundingBox();
const reviewViewport = page.viewportSize();
if (!reviewBox || reviewBox.height < 44 || reviewBox.x < 0 || reviewBox.y < 0 ||
    reviewBox.x + reviewBox.width > reviewViewport.width || reviewBox.y + reviewBox.height > reviewViewport.height) {
  throw new Error(`review-clips action is clipped or undersized at 320x568: ${JSON.stringify(reviewBox)}`);
}
await page.screenshot({ path: `${OUT}/2-recorded-compact.png` });
await page.setViewportSize({ width: 390, height: 844 });
await reviewClips.click();
await page.waitForSelector('[data-editor-frame]', { timeout: 10000 });
log('clear post-recording review action and early encoder download verified at 320x568');

// A reload must recover the durable session with every completed clip.
await page.reload();
await page.waitForSelector('[data-editor-frame]', { timeout: 10000 });
if (await page.locator('[data-clip]').count() !== 4) throw new Error('reload did not preserve all 4 clips');
log('reload preserved all completed clips');

// Continue in the editor after the explicit review action and reload proof.
await page.waitForSelector('text=Split', { timeout: 15000 });
await page.waitForTimeout(1500); // thumbnails
await page.screenshot({ path: `${OUT}/3-editor.png` });
log('editor open');

const editorFrame = page.locator('[data-editor-frame]');
const editorBox = await editorFrame.boundingBox();
if (Math.abs(editorBox.width / editorBox.height - 9 / 16) > 0.03) throw new Error('editor frame is not portrait 9:16');
// These fake-camera clips are HD, so the export default must be the source
// class (1080p), keeping the native/remux fast paths instead of a 4K upscale.
if (await editorFrame.getAttribute('data-export-width') !== '1080' || await editorFrame.getAttribute('data-export-height') !== '1920') {
  throw new Error('editor default export metadata is not the 1080p source class (1080x1920)');
}
log('editor portrait frame and source-matched 1080p default export verified');

const clipCount = await page.locator('[data-clip]').count();
log(`timeline clips: ${clipCount}`);
if (clipCount !== 4) throw new Error(`expected 4 clips, got ${clipCount}`);

// select clip 2, trim right edge left by ~1s via drag
const clips = page.locator('[data-clip]');
await clips.nth(1).click();
await page.waitForTimeout(300);
const selectedClipBox = await clips.nth(1).boundingBox();
const playheadBox = await page.locator('[data-timeline-playhead]').boundingBox();
if (!selectedClipBox || !playheadBox || Math.abs(selectedClipBox.x - playheadBox.x) > 1.5) {
  throw new Error(`timeline playhead drifted from clip 2 start (${selectedClipBox?.x} vs ${playheadBox?.x})`);
}
const beforeDuration = Number(await clips.nth(1).getAttribute('data-clip-duration'));
// right trim handle: amber bar at right edge of selected clip
const sel = await clips.nth(1).boundingBox();
await page.mouse.move(sel.x + sel.width - 8, sel.y + sel.height / 2);
await page.mouse.down();
await page.mouse.move(sel.x + sel.width - 8 - 44, sel.y + sel.height / 2, { steps: 10 }); // ~1s at 44px/s
await page.mouse.up();
await page.waitForTimeout(300);
const afterDuration = Number(await clips.nth(1).getAttribute('data-clip-duration'));
log(`trim: ${beforeDuration.toFixed(2)}s → ${afterDuration.toFixed(2)}s`);
if (!(afterDuration < beforeDuration)) throw new Error('trim drag did not shorten clip');
await page.screenshot({ path: `${OUT}/4-trimmed.png` });

// Swiping a clip scrolls the strip without selecting it. Keyboard users can
// still select a clip explicitly with Enter.
await clips.first().click();
await page.setViewportSize({ width: 320, height: 568 });
const scrollTarget = await clips.nth(2).boundingBox();
await page.mouse.move(scrollTarget.x + scrollTarget.width / 2, scrollTarget.y + scrollTarget.height / 2);
await page.mouse.down();
await page.mouse.move(scrollTarget.x - 70, scrollTarget.y + scrollTarget.height / 2, { steps: 6 });
await page.mouse.up();
const timelineScrollLeft = await page.getByRole('list', { name: 'Video clips' }).evaluate((strip) => strip.scrollLeft);
if (timelineScrollLeft <= 0) throw new Error('timeline swipe did not scroll');
if (await clips.first().getAttribute('aria-current') !== 'true') throw new Error('timeline swipe changed the selected clip');
await clips.nth(1).focus();
await page.keyboard.press('Enter');
if (await clips.nth(1).getAttribute('aria-current') !== 'true') throw new Error('keyboard clip selection failed');
await page.setViewportSize({ width: 390, height: 844 });
log('timeline scroll, selection, keyboard access, and playhead alignment verified');

// delete clip 3
await clips.nth(2).click();
await page.click('text=Delete');
await page.waitForTimeout(300);
const afterDelete = await page.locator('[data-clip]').count();
log(`after delete: ${afterDelete} clips`);
if (afterDelete !== 3) throw new Error('delete failed');

// undo the delete, then redo-less state check
await page.click('button[aria-label="Undo"]');
await page.waitForTimeout(300);
const afterUndo = await page.locator('[data-clip]').count();
log(`after undo: ${afterUndo} clips`);
if (afterUndo !== 4) throw new Error('undo failed');

// split clip 1 after playing into it
await page.locator('[data-clip]').nth(0).click();
await page.waitForTimeout(200);
await page.click('button[aria-label="Play"]');
await page.waitForSelector('button[aria-label="Pause"]', { timeout: 5000 });
const playbackSlot = await page.locator('[data-editor-playhead]').getAttribute('data-editor-active-slot');
const playbackVideo = page.locator(`[data-editor-video-slot="${playbackSlot}"]`);
const playbackStart = await playbackVideo.evaluate((video) => ({
  mediaTime: video.currentTime,
  wallTime: performance.now(),
}));
await page.waitForTimeout(1200);
const playbackEnd = await playbackVideo.evaluate((video) => ({
  mediaTime: video.currentTime,
  wallTime: performance.now(),
}));
const playbackRate = (playbackEnd.mediaTime - playbackStart.mediaTime) / ((playbackEnd.wallTime - playbackStart.wallTime) / 1000);
if (playbackRate < 0.85 || playbackRate > 1.15) throw new Error(`editor playback ran at ${playbackRate.toFixed(2)}x`);
log(`editor playback verified at ${playbackRate.toFixed(2)}x`);
const globalStart = Number(await page.locator('[data-editor-playhead]').getAttribute('data-editor-playhead'));
await page.waitForTimeout(1400);
const globalEnd = Number(await page.locator('[data-editor-playhead]').getAttribute('data-editor-playhead'));
const crossClipRate = (globalEnd - globalStart) / 1.4;
if (crossClipRate < 0.8 || crossClipRate > 1.2) throw new Error(`cross-clip playback ran at ${crossClipRate.toFixed(2)}x`);
if (!(await page.getByRole('button', { name: 'Pause' }).isVisible())) throw new Error('playback stopped while switching clips');
const handoffGap = Number(await page.locator('[data-editor-playhead]').getAttribute('data-last-handoff-gap-ms'));
if (!Number.isFinite(handoffGap) || handoffGap > 120) throw new Error(`clip handoff gap was ${handoffGap}ms`);
const handoffStartOffset = Number(await page.locator('[data-editor-playhead]').getAttribute('data-last-handoff-start-offset-ms'));
if (!Number.isFinite(handoffStartOffset) || handoffStartOffset > 50) {
  throw new Error(`clip handoff skipped ${handoffStartOffset}ms of the incoming clip`);
}
log(`cross-clip playback verified at ${crossClipRate.toFixed(2)}x; handoff ${handoffGap.toFixed(1)}ms; opening offset ${handoffStartOffset.toFixed(1)}ms`);
await page.click('button[aria-label="Pause"]');
await page.click('text=Split');
await page.waitForTimeout(300);
const afterSplit = await page.locator('[data-clip]').count();
log(`after split: ${afterSplit} clips`);
if (afterSplit !== 5) throw new Error(`split failed: expected 5 clips, got ${afterSplit}`);
await page.screenshot({ path: `${OUT}/5-split.png` });

await page.click('text=Export video');
const exportDialog = page.getByRole('dialog', { name: 'Export video' });
await exportDialog.waitFor();
for (let index = 0; index < 8; index += 1) {
  await page.keyboard.press('Tab');
  const focusInside = await exportDialog.evaluate((dialog) => dialog.contains(document.activeElement));
  if (!focusInside) throw new Error('export dialog let focus escape to the obscured editor');
}
log('export dialog focus trap verified');
await exportDialog.getByText('9:16 portrait', { exact: true }).waitFor();
// HD-only sources open the sheet on 1080p; switching to 4K and back must
// update the live export metadata. Controls stay finger-sized.
await exportDialog.getByText(/1080p · 1080 × 1920/).waitFor();
const quality1080 = exportDialog.getByRole('button', { name: '1080p', exact: true });
const quality4k = exportDialog.getByRole('button', { name: '4K', exact: true });
if (await quality1080.getAttribute('aria-pressed') !== 'true') throw new Error('export quality did not default to the 1080p source class');
const qualityBox = await quality1080.boundingBox();
if (!qualityBox || qualityBox.height < 44) throw new Error(`1080p quality control is ${qualityBox?.height}px tall, expected at least 44`);
await quality4k.click();
if (await quality4k.getAttribute('aria-pressed') !== 'true') throw new Error('4K quality selection was not pressed');
if (await editorFrame.getAttribute('data-export-width') !== '2160') throw new Error('4K selection did not update export metadata');
await exportDialog.getByText(/4K · 2160 × 3840/).waitFor();
await quality1080.click();
if (await quality1080.getAttribute('aria-pressed') !== 'true') throw new Error('1080p quality selection was not pressed');
if (await editorFrame.getAttribute('data-export-width') !== '1080') throw new Error('1080p selection did not update export metadata');
await exportDialog.getByText(/1080p · 1080 × 1920/).waitFor();
await exportDialog.getByRole('button', { name: 'Start export' }).click();
log('export started (ffmpeg.wasm)…');
await page.waitForSelector('text=Video ready to share or download', { timeout: 300000 });
if (await page.getByText('Saved to this device').count()) throw new Error('UI falsely claimed the file was saved');
const resultStats = await page.locator('[data-export-result-stats]').textContent();
if (!resultStats || !/ready in .*no upload needed/.test(resultStats)) {
  throw new Error(`export size/speed handoff is unclear: "${resultStats}"`);
}
log('export ready without false save claim');
await page.screenshot({ path: `${OUT}/6-exported.png` });

// A blocked anchor click must produce failure copy, never success copy.
await page.evaluate(() => {
  const proto = HTMLAnchorElement.prototype;
  window.__takesOriginalAnchorClick = proto.click;
  proto.click = () => { throw new Error('synthetic blocked download'); };
});
await page.getByRole('button', { name: 'Download MP4' }).click();
await page.getByText('The browser could not start the download. Try Share instead.').waitFor();
await page.evaluate(() => {
  HTMLAnchorElement.prototype.click = window.__takesOriginalAnchorClick;
});
const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await page.getByRole('button', { name: 'Download MP4' }).click();
const download = await downloadPromise;
await page.getByText(/Download started from this device — no upload/).waitFor();
const path = `${OUT}/exported.mp4`;
await download.saveAs(path);
const size = fs.statSync(path).size;
log(`downloaded ${(size / 1024 / 1024).toFixed(2)} MB → ${path}`);

// A denied initial camera request must leave a visible recovery path. Fail the
// constrained request and its fallback once, then let the retry use the real
// fake-device stream.
const recoveryContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
await recoveryContext.addInitScript(() => {
  const mediaDevices = navigator.mediaDevices;
  const original = mediaDevices.getUserMedia.bind(mediaDevices);
  let attempts = 0;
  Object.defineProperty(mediaDevices, 'getUserMedia', {
    configurable: true,
    value: (constraints) => {
      attempts += 1;
      if (attempts <= 2) return Promise.reject(new DOMException('Synthetic permission denial', 'NotAllowedError'));
      return original(constraints);
    },
  });
});
const recoveryPage = await recoveryContext.newPage();
await recoveryPage.goto(BASE, { waitUntil: 'load' });
await recoveryPage.getByText('Camera access was denied. Allow camera and microphone permission, then try again.').waitFor();
await recoveryPage.getByRole('button', { name: 'Import video', exact: true }).waitFor();
await recoveryPage.getByRole('button', { name: 'Try camera again' }).click();
await recoveryPage.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
await recoveryContext.close();
log('camera permission recovery actions verified');

console.log('\nBROWSER ERRORS:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
console.log('E2E PASS');
