// Verify export cancellation: start a 4K wasm export, cancel mid-encode,
// confirm the sheet returns to the idle/choose state, then run a fresh export
// to completion (proves ffmpeg.terminate() + module reset leave a clean slate).
// Run: CHROME_PATH=... node scripts/probe-cancel.mjs http://localhost:PORT/
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://localhost:4173/';
const errors = [];
const logs = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
page.on('console', (m) => {
  if (m.text().startsWith('[export]') || m.text().startsWith('[ffmpeg] loaded')) logs.push(m.text());
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
const record = page.getByRole('button', { name: 'Tap to record' });
const box = await record.boundingBox();
const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
await page.waitForTimeout(1500);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 2000 });
await page.getByText('Edit', { exact: true }).click();
await page.locator('[data-editor-frame]').waitFor();

await page.getByText('Export video', { exact: true }).click();
const dialog = page.getByRole('dialog', { name: 'Export video' });
// 4K wasm encode: slow enough to cancel mid-flight in headless chromium.
await dialog.getByRole('button', { name: 'Start export' }).click();
await dialog.getByText(/Encoding|Rendering video/).waitFor({ timeout: 120000 });
await page.waitForTimeout(1500); // let the wasm exec get going
await dialog.getByRole('button', { name: 'Cancel export' }).click();
// The sheet must return to the idle/choose state, not error.
await dialog.getByRole('button', { name: 'Start export' }).waitFor({ timeout: 15000 });
const errorVisible = await dialog.locator('.text-red-400').isVisible().catch(() => false);
if (errorVisible) throw new Error('cancel surfaced an error state instead of idle');
console.log('cancel returned sheet to idle state');

// Fresh export after the terminate must succeed (module singleton was reset).
await dialog.getByRole('button', { name: 'Start export' }).click();
await dialog.getByText('Video ready to share or download').waitFor({ timeout: 300000 });
console.log('post-cancel export completed');

// Escape while working must also cancel and close the sheet.
await page.keyboard.press('Escape');
await dialog.waitFor({ state: 'detached', timeout: 5000 });
await page.getByRole('button', { name: 'Export video' }).click();
await dialog.getByRole('button', { name: 'Start export' }).click();
await dialog.getByText(/Encoding|Rendering video/).waitFor({ timeout: 120000 });
await page.keyboard.press('Escape');
await dialog.waitFor({ state: 'detached', timeout: 15000 });
console.log('escape-while-working cancelled and closed the sheet');

console.log(JSON.stringify({ logs, errors }, null, 2));
await browser.close();
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
console.log('CANCEL PROBE PASS');
