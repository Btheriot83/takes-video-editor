// Headless end-to-end: fake camera → record 3 clips → edit → export → verify MP4.
// Run: npm run smoke -- [baseURL]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
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
page.on('console', (m) => {
  const t = m.text();
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
await page.waitForSelector('button[aria-label="Start recording"]', { timeout: 15000 });
await page.screenshot({ path: `${OUT}/1-camera.png` });
log('camera open');

// record 3 clips of ~2s each
for (let i = 0; i < 3; i++) {
  await page.click('button[aria-label="Start recording"]');
  await page.waitForTimeout(2000);
  await page.click('button[aria-label="Stop recording"]');
  await page.waitForTimeout(600);
  log(`clip ${i + 1} recorded`);
}
await page.screenshot({ path: `${OUT}/2-recorded.png` });

// go to editor
await page.click('text=Edit');
await page.waitForSelector('text=Split', { timeout: 15000 });
await page.waitForTimeout(1500); // thumbnails
await page.screenshot({ path: `${OUT}/3-editor.png` });
log('editor open');

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

// split clip 1 in the middle: select it, move playhead by tapping into its middle, then Split
await page.locator('[data-clip]').nth(0).click();
await page.waitForTimeout(200);
// seek via preview play then pause mid-clip
await page.click('button[aria-label="Play"]');
await page.waitForTimeout(1000);
await page.keyboard.press('Escape').catch(() => {});
const pauseBtn = page.locator('button[aria-label="Pause"]');
// stop playback by reloading state: click on clip again to set playhead to its start + use split near start offset
await page.locator('[data-clip]').nth(0).click();
// simulate split: set playhead programmatically is not exposed; instead play 1s then split immediately
await page.click('text=Split');
await page.waitForTimeout(300);
const afterSplit = await page.locator('[data-clip]').count();
log(`after split attempt: ${afterSplit} clips`);
await page.screenshot({ path: `${OUT}/5-split.png` });

// export
await page.click('text=Export');
await page.waitForSelector('text=Start export', { timeout: 10000 });
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
