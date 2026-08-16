// Design QA probe: screenshots + geometry measurements at 320x568 and 390x844.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:4634/';
const OUT = 'scripts/e2e-out/qa';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

async function measure(label) {
  const vp = page.viewportSize();
  const data = await page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('button, [role="button"], a, input, [data-clip]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName;
      rows.push({ label, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), hidden: el.hidden });
    });
    return { rows, docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight };
  });
  const problems = [];
  if (data.docW > vp.width) problems.push(`document scrollWidth ${data.docW} > viewport ${vp.width}`);
  for (const r of data.rows) {
    if (r.hidden) continue;
    if ((r.w < 44 || r.h < 44)) problems.push(`SMALL ${r.w}x${r.h} @(${r.x},${r.y}) "${r.label}"`);
    if (r.x < 0 || r.x + r.w > vp.width) problems.push(`XCLIP @(${r.x} w${r.w}) vp ${vp.width} "${r.label}"`);
    if (r.y < 0 || r.y + r.h > vp.height) problems.push(`YCLIP @(${r.y} h${r.h}) vp ${vp.height} "${r.label}"`);
  }
  console.log(`\n== ${label} (${vp.width}x${vp.height}) ==`);
  problems.forEach((p) => console.log('  ' + p));
  if (!problems.length) console.log('  ok');
}

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
await page.screenshot({ path: `${OUT}/camera-390.png` });
await measure('camera');
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/camera-320.png` });
await measure('camera');
await page.setViewportSize({ width: 390, height: 844 });

// record 2 clips
for (let i = 0; i < 2; i++) {
  const record = page.getByRole('button', { name: 'Tap to record' });
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: i + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1200);
  if (i === 0) {
    await page.screenshot({ path: `${OUT}/camera-recording-390.png` });
    await measure('camera-recording');
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  if (i === 0) {
    await page.waitForSelector('[data-saved-notice]', { timeout: 10000 });
    await page.screenshot({ path: `${OUT}/camera-saved-390.png` });
    await measure('camera-just-saved');
  }
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 10000 });
}
await page.waitForTimeout(2800); // let the saved toast dismiss for the steady-state shot
await page.screenshot({ path: `${OUT}/camera-clips-390.png` });
await measure('camera-with-clips');
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/camera-clips-320.png` });
await measure('camera-with-clips');
{
  // Compact-viewport recording + saved states.
  const record = page.getByRole('button', { name: 'Tap to record' });
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 9 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/camera-recording-320.png` });
  await measure('camera-recording');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('[data-saved-notice]', { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/camera-saved-320.png` });
  await measure('camera-just-saved');
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 10000 });
}
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);

await page.getByText('Edit', { exact: true }).click();
await page.waitForSelector('text=Split', { timeout: 15000 });
await page.waitForTimeout(800);
// select first clip so trim controls appear
await page.locator('[data-clip]').first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/editor-390.png` });
await measure('editor');
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/editor-320.png` });
await measure('editor');
await page.setViewportSize({ width: 390, height: 844 });

await page.click('text=Export video');
await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/export-390.png` });
await measure('export-sheet');
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/export-320.png` });
await measure('export-sheet');

await browser.close();
