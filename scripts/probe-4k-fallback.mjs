// Probe: the 4K capture fallback path. The Chromium fake camera happily
// delivers >=2160 frames, so the main smoke exercises the happy path; this
// probe caps getUserMedia at 1280x720 to prove the camera screen degrades
// honestly — capability notice shown, badge reporting the real capture size,
// recording still working at the delivered resolution.
// Run: node scripts/probe-4k-fallback.mjs [baseURL]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://localhost:4173/';

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
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
// Simulate a camera that cannot do 4K: clamp every video request to 720p.
await ctx.addInitScript(() => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (constraints) => {
    const next = { ...constraints };
    if (next.video && typeof next.video === 'object') {
      next.video = { ...next.video, width: { ideal: 720, max: 720 }, height: { ideal: 1280, max: 1280 } };
    }
    return original(next);
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const log = (m) => console.log(`[probe-4k-fallback] ${m}`);

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 15000 });

await page.getByRole('button', { name: '4K', exact: true }).click();
// The notice appears as soon as the reopened stream reports a sub-4K size.
await page.getByText('4K not available on this camera').waitFor({ timeout: 15000 });
log('capability notice shown for unavailable 4K');

await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 15000 });
const frame = page.locator('[data-camera-frame]');
if (await frame.getAttribute('data-capture-quality') !== '4K') throw new Error('4K setting was not applied to the frame');
const capW = Number(await frame.getAttribute('data-capture-width'));
const capH = Number(await frame.getAttribute('data-capture-height'));
if (!(capW && capH) || Math.min(capW, capH) >= 2160) throw new Error(`expected a sub-4K capture, got ${capW}x${capH}`);
const badge = await page.getByText(/^Camera /).textContent();
if (!badge.includes(`${capW}×${capH}`)) throw new Error(`badge "${badge}" does not report the real capture size ${capW}x${capH}`);
log(`badge honestly reports ${capW}×${capH}`);

// Recording must still work at whatever the camera delivered.
const record = page.getByRole('button', { name: 'Hold to record' });
const box = await record.boundingBox();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }],
});
await page.waitForSelector('button[aria-label="Release to stop recording"]', { timeout: 5000 });
await page.waitForTimeout(1500);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 5000 });
await page.waitForTimeout(600);
const clipBadge = await page.getByText(/1 clip ·/).isVisible().catch(() => false);
if (!clipBadge) throw new Error('recording in the fallback resolution did not produce a clip');
log('recording still works at the fallback resolution');

await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s): ${errors.join('; ')}`);
console.log('PROBE 4K FALLBACK PASS');
