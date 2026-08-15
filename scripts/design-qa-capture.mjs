// Capture the implemented camera and editor at the reference screenshots' 3x width.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:4173/';
const out = 'scripts/e2e-out/design-qa';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 430, height: 887 },
  deviceScaleFactor: 3,
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

await page.goto(base, { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 15000 });
await page.screenshot({ path: `${out}/camera-430x887-at-3x.png` });

for (let i = 0; i < 2; i++) {
  const record = page.getByRole('button', { name: 'Hold to record' });
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: i + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Release to stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1500);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 10000 });
}

await page.getByText('Edit', { exact: true }).click();
await page.waitForSelector('text=Split', { timeout: 15000 });
await page.waitForTimeout(1000);
await page.setViewportSize({ width: 430, height: 799 });
await page.screenshot({ path: `${out}/editor-430x799-at-3x.png` });
await browser.close();
