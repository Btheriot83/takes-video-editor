// Probe: the 4K capture fallback path. The Chromium fake camera happily
// delivers >=2160 frames, so the main smoke exercises the happy path; this
// probe caps getUserMedia at 1280x720 to prove the camera screen degrades
// honestly — badge reporting the real size and recording blocked instead of
// silently upscaling HD into a 4K-shaped file.
// Run: node scripts/probe-4k-fallback.mjs [baseURL]
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
await page.locator('[data-4k-recording-blocked]').waitFor({ timeout: 15000 });
log('persistent 4K recording block shown');

const frame = page.locator('[data-camera-frame]');
if (await frame.getAttribute('data-capture-quality') !== '4K') throw new Error('4K setting was not applied to the frame');
if (await frame.getAttribute('data-capture-verified-4k') !== 'false') throw new Error('sub-4K source was incorrectly verified');
const capW = Number(await frame.getAttribute('data-capture-width'));
const capH = Number(await frame.getAttribute('data-capture-height'));
if (!(capW && capH) || Math.min(capW, capH) >= 2160) throw new Error(`expected a sub-4K capture, got ${capW}x${capH}`);
const badge = await page.locator('[data-capture-badge]').textContent();
if (!badge.includes('Not 4K') || !badge.includes(`${capW}×${capH}`)) throw new Error(`badge "${badge}" does not report the sub-4K source ${capW}x${capH}`);
log(`badge honestly reports ${capW}×${capH}`);

const record = page.getByRole('button', { name: '4K camera unavailable' });
if (!(await record.isDisabled())) throw new Error('record control unlocked on a sub-4K source');
if (await page.locator('[data-review-clips]').count()) throw new Error('a clip appeared while 4K recording was blocked');
const layout = await page.evaluate(() => ({
  innerWidth: window.innerWidth,
  documentWidth: document.documentElement.scrollWidth,
  scrollX: window.scrollX,
}));
if (layout.documentWidth > layout.innerWidth + 1 || layout.scrollX !== 0) {
  throw new Error(`4K unavailable state overflows horizontally: ${JSON.stringify(layout)}`);
}
log('recording remains locked rather than manufacturing an upscaled 4K file');
await page.screenshot({ path: `${OUT}/4k-unavailable-390x844.png` });

await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s): ${errors.join('; ')}`);
console.log('PROBE 4K FALLBACK PASS');
