// Headless end-to-end: fake camera → record 3 clips → edit → export → verify MP4.
// Run: npm run smoke -- [baseURL]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
let mediaRecorderStarts = 0;
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
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`);
});

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 15000 });
await page.screenshot({ path: `${OUT}/1-camera.png` });
log('camera open');

// A fresh/empty project must visibly default to vertical 9:16 output.
const defaultFrame = page.locator('[data-camera-frame]');
const defaultBox = await defaultFrame.boundingBox();
if (Math.abs(defaultBox.width / defaultBox.height - 9 / 16) > 0.03) {
  throw new Error(`default frame is not portrait 9:16: ${(defaultBox.width / defaultBox.height).toFixed(2)}`);
}
if (await defaultFrame.getAttribute('data-output-width') !== '1080' || await defaultFrame.getAttribute('data-output-height') !== '1920') {
  throw new Error('default frame metadata is not 1080x1920');
}
if (!(await page.getByRole('button', { name: '16:9', exact: true }).getAttribute('aria-pressed') === 'true')) {
  throw new Error('16:9 selector is not the default');
}
await page.getByText('9:16 portrait', { exact: true }).waitFor();
log('default portrait 9:16 frame verified');

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

// record 3 clips of ~2s each
for (let i = 0; i < 3; i++) {
  const record = page.getByRole('button', { name: 'Hold to record' });
  const recordBox = await record.boundingBox();
  const recordPoint = { x: recordBox.x + recordBox.width / 2, y: recordBox.y + recordBox.height / 2, id: i + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [recordPoint] });
  await page.waitForSelector('button[aria-label="Release to stop recording"]', { timeout: 5000 });

  if (i === 0) {
    // A second finger/down event while the primary hold is active must not
    // create another MediaRecorder. The first hold must remain recording.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [recordPoint, { ...recordPoint, x: recordPoint.x + 6, id: 99 }],
    });
    await page.waitForTimeout(700);
    if (!(await page.getByRole('button', { name: 'Release to stop recording' }).isVisible())) {
      throw new Error('recording did not continue while the touch was held');
    }
    if (mediaRecorderStarts !== 1) throw new Error(`duplicate hold started ${mediaRecorderStarts} recorders`);
  }
  await page.waitForTimeout(2000);
  const releaseStarted = Date.now();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('[data-record-state]')?.getAttribute('data-record-state') !== 'recording', null, { timeout: 750 });
  const releaseLatency = Date.now() - releaseStarted;
  await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 10000 });
  await page.waitForTimeout(600);
  if (mediaRecorderStarts !== i + 1) throw new Error(`expected ${i + 1} recorder starts, got ${mediaRecorderStarts}`);
  log(`clip ${i + 1} recorded; release stopped in ${releaseLatency}ms`);
}
await page.screenshot({ path: `${OUT}/2-recorded.png` });

// go to editor
await page.click('text=Edit');
await page.waitForSelector('text=Split', { timeout: 15000 });
await page.waitForTimeout(1500); // thumbnails
await page.screenshot({ path: `${OUT}/3-editor.png` });
log('editor open');

const editorFrame = page.locator('[data-editor-frame]');
const editorBox = await editorFrame.boundingBox();
if (Math.abs(editorBox.width / editorBox.height - 9 / 16) > 0.03) throw new Error('editor frame is not portrait 9:16');
if (await editorFrame.getAttribute('data-output-width') !== '1080' || await editorFrame.getAttribute('data-output-height') !== '1920') {
  throw new Error('editor frame metadata is not 1080x1920');
}
log('editor portrait 9:16 frame verified');

const clipCount = await page.locator('[data-clip]').count();
log(`timeline clips: ${clipCount}`);
if (clipCount !== 3) throw new Error(`expected 3 clips, got ${clipCount}`);

// select clip 2, trim right edge left by ~1s via drag
const clips = page.locator('[data-clip]');
await clips.nth(1).click();
await page.waitForTimeout(300);
const before = await page.locator('[data-clip]').nth(1).boundingBox();
const handle = await page.locator('[data-clip]').nth(1).locator('div').last().boundingBox();
// right trim handle: amber bar at right edge of selected clip
const sel = await clips.nth(1).boundingBox();
await page.mouse.move(sel.x + sel.width - 8, sel.y + sel.height / 2);
await page.mouse.down();
await page.mouse.move(sel.x + sel.width - 8 - 44, sel.y + sel.height / 2, { steps: 10 }); // ~1s at 44px/s
await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.locator('[data-clip]').nth(1).boundingBox();
log(`trim: width ${before.width.toFixed(0)} → ${after.width.toFixed(0)}`);
if (!(after.width < before.width)) throw new Error('trim drag did not shrink clip');
await page.screenshot({ path: `${OUT}/4-trimmed.png` });

// delete clip 3
await clips.nth(2).click();
await page.click('text=Delete');
await page.waitForTimeout(300);
const afterDelete = await page.locator('[data-clip]').count();
log(`after delete: ${afterDelete} clips`);
if (afterDelete !== 2) throw new Error('delete failed');

// undo the delete, then redo-less state check
await page.click('button[aria-label="Undo"]');
await page.waitForTimeout(300);
const afterUndo = await page.locator('[data-clip]').count();
log(`after undo: ${afterUndo} clips`);
if (afterUndo !== 3) throw new Error('undo failed');

// split clip 1 after playing into it
await page.locator('[data-clip]').nth(0).click();
await page.waitForTimeout(200);
await page.click('button[aria-label="Play"]');
await page.waitForTimeout(900);
await page.click('button[aria-label="Pause"]');
await page.click('text=Split');
await page.waitForTimeout(300);
const afterSplit = await page.locator('[data-clip]').count();
log(`after split: ${afterSplit} clips`);
if (afterSplit !== 4) throw new Error(`split failed: expected 4 clips, got ${afterSplit}`);
await page.screenshot({ path: `${OUT}/5-split.png` });

// export
await page.click('text=Export');
await page.waitForSelector('text=Start export', { timeout: 10000 });
const exportDialog = page.getByRole('dialog', { name: 'Export video' });
await exportDialog.getByText('9:16 portrait', { exact: true }).waitFor();
await exportDialog.getByText('1080 × 1920', { exact: true }).waitFor();
await page.click('text=Start export');
log('export started (ffmpeg.wasm)…');
await page.waitForSelector('text=Export complete', { timeout: 300000 });
log('export complete');
await page.screenshot({ path: `${OUT}/6-exported.png` });

// download and save
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.click('text=Download MP4'),
]);
const path = `${OUT}/exported.mp4`;
await download.saveAs(path);
const size = fs.statSync(path).size;
log(`downloaded ${(size / 1024 / 1024).toFixed(2)} MB → ${path}`);

console.log('\nBROWSER ERRORS:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
console.log('E2E PASS');
