// Private-browsing storage probe: simulate the two ways IndexedDB breaks in
// private/incognito sessions and verify the whole capture -> edit -> 1080p
// export flow still works from the in-memory session fallback.
//
//   scenario "missing"     — window.indexedDB is undefined (Safari lockdown /
//                            older private mode). Full flow: 3 clips, notice,
//                            trim edit, 1080p export.
//   scenario "open-throws" — indexedDB.open() throws SecurityError (Firefox
//                            private mode, quota-locked Chrome incognito).
//                            Quick flow: 1 clip + notice.
//   scenario "quota-write" — IndexedDB opens but writing the recorded media
//                            blob throws QuotaExceededError (quota-limited
//                            incognito). This is the exact field failure:
//                            "The recording could not be saved. Please try
//                            again." Quick flow: 1 clip + notice.
//
// Before the in-memory fallback existed this probe reproduced the field bug:
// holding record surfaced "Recording is not supported in this browser." /
// "The recording could not be saved. Please try again." role=alert states.
//
// Run: CHROME_PATH=... node scripts/probe-private-mode.mjs http://localhost:PORT/
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://localhost:4173/';
const NOTICE = "Private browsing: clips won't survive closing this tab";

const INIT_SCRIPTS = {
  missing: () => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
  },
  'open-throws': () => {
    const broken = {
      open() { throw new DOMException('The user denied permission to access the database.', 'SecurityError'); },
      deleteDatabase() { throw new DOMException('The user denied permission to access the database.', 'SecurityError'); },
    };
    Object.defineProperty(window, 'indexedDB', { value: broken, configurable: true });
  },
  'quota-write': () => {
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(...args) {
      // Recording chunks still flush; only the final media blob write hits
      // the quota wall, which is how quota-limited incognito fails in the field.
      if (this.name === 'blobs') throw new DOMException('Quota exceeded.', 'QuotaExceededError');
      return origPut.apply(this, args);
    };
  },
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function assertNoSaveError(page, where) {
  const alert = page.locator('[role="alert"]');
  if (await alert.isVisible().catch(() => false)) {
    throw new Error(`REPRODUCED at ${where}: ${await alert.textContent()}`);
  }
}

async function recordClip(page, cdp, id) {
  const record = page.getByRole('button', { name: 'Tap to record' });
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  // Before the fallback fix this wait itself failed: recBegin() threw and the
  // camera showed the role=alert error instead of entering the recording state.
  try {
    await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
  } catch (error) {
    await assertNoSaveError(page, 'recording start');
    throw error;
  }
  await page.waitForTimeout(2000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 10000 });
  await page.waitForTimeout(400);
  await assertNoSaveError(page, 'recording save');
}

async function runScenario(scenario, { full }) {
  log(`--- scenario ${scenario} (${full ? 'full flow' : 'quick check'}) ---`);
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'microphone'],
    hasTouch: true,
    isMobile: true,
  });
  const errors = [];
  const fallbackLogs = [];
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.addInitScript(INIT_SCRIPTS[scenario]);
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('storage fallback') || t.startsWith('[db]')) fallbackLogs.push(t);
    if (m.type() === 'error') errors.push(`${t} (${m.location().url || 'unknown URL'})`);
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
  await assertNoSaveError(page, 'startup');
  log('camera open with broken IndexedDB');

  // clip 1 + the one-time private-browsing notice
  await recordClip(page, cdp, 1);
  await page.getByText(NOTICE).waitFor({ timeout: 4000 });
  log('clip 1 saved in memory; private-browsing notice shown');

  if (!fallbackLogs.length) throw new Error('no storage-fallback log line was emitted');
  log(`fallback logged: ${fallbackLogs[0]}`);

  if (full) {
    await recordClip(page, cdp, 2);
    // Let the first (6s) notice expire, then verify saving another clip does
    // not re-show it: the notice must be one-time per session.
    await page.getByText(NOTICE).waitFor({ state: 'hidden', timeout: 10000 });
    await recordClip(page, cdp, 3);
    if (await page.getByText(NOTICE).isVisible().catch(() => false)) {
      throw new Error('private-browsing notice re-appeared after later clips');
    }
    log('3 clips recorded; notice stayed one-time');

    // edit: open the editor, trim clip 2's right edge
    await page.getByRole('button', { name: /Done recording\. Review \d+ clips?/ }).click();
    await page.waitForSelector('[data-editor-frame]', { timeout: 10000 });
    if (await page.locator('[data-clip]').count() !== 3) throw new Error('editor did not show all 3 in-memory clips');
    const clips = page.locator('[data-clip]');
    await clips.nth(1).click();
    await page.waitForTimeout(300);
    const before = await clips.nth(1).boundingBox();
    await page.mouse.move(before.x + before.width - 8, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width - 8 - 44, before.y + before.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await clips.nth(1).boundingBox();
    if (!(after.width < before.width)) throw new Error('trim drag did not shrink the in-memory clip');
    log(`trim verified (${before.width.toFixed(0)} -> ${after.width.toFixed(0)}px)`);

    // 1080p export straight from the in-memory blobs
    await page.click('text=Export video');
    const dialog = page.getByRole('dialog', { name: 'Export video' });
    const quality1080 = dialog.getByRole('button', { name: '1080p', exact: true });
    if (await quality1080.getAttribute('aria-pressed') !== 'true') await quality1080.click();
    await dialog.getByRole('button', { name: 'Start export' }).click();
    log('1080p export started from memory-mode blobs…');
    await page.waitForSelector('text=Video ready to share or download', { timeout: 300000 });
    log('1080p export completed in memory mode');
  }

  await ctx.close();
  const fatal = errors.filter((e) => !e.includes('storage fallback'));
  if (fatal.length) throw new Error(`scenario ${scenario} browser errors:\n${fatal.join('\n')}`);
  log(`scenario ${scenario} PASS`);
}

try {
  await runScenario('missing', { full: true });
  await runScenario('open-throws', { full: false });
  await runScenario('quota-write', { full: false });
} finally {
  await browser.close();
}
console.log('PRIVATE MODE PROBE PASS');
