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
await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 15000 });
await page.screenshot({ path: `${out}/camera-430x887-at-3x.png` });

// Use the selfie path for the export screenshots: its output-ready portrait
// capture is the physical-device regression under review.
await page.getByRole('button', { name: 'Switch to front camera' }).click();
await page.waitForSelector('button[aria-label="Switch to rear camera"]:not([disabled])', { timeout: 15000 });

for (let i = 0; i < 2; i++) {
  const record = page.getByRole('button', { name: 'Tap to record' });
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: i + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1500);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Tap to record"]:not([disabled])', { timeout: 10000 });
}

await page.getByRole('button', { name: /Done recording\. Review \d+ clips?/ }).click();
await page.waitForSelector('text=Split', { timeout: 15000 });
await page.waitForTimeout(1000);
await page.setViewportSize({ width: 430, height: 799 });
await page.screenshot({ path: `${out}/editor-430x799-at-3x.png` });

await page.getByText('Export video', { exact: true }).click();
const exportDialog = page.getByRole('dialog', { name: 'Export video' });
await exportDialog.locator('[data-export-plan][data-export-path="join"]').waitFor();
await page.screenshot({ path: `${out}/export-fast-430x799-at-3x.png` });

// Switching an HD capture to 4K deterministically exercises the warning state
// without starting a costly render. Verify both the smallest supported phone
// viewport and the centered desktop presentation from the real rendered UI.
await exportDialog.getByRole('button', { name: '4K', exact: true }).click();
await exportDialog.locator('[data-export-plan][data-export-path="render"]').waitFor();
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(150);
const compactCta = await exportDialog.getByRole('button', { name: 'Start export' }).boundingBox();
const compactViewport = page.viewportSize();
if (!compactCta || compactCta.height < 44 || compactCta.x < 0 || compactCta.y < 0 ||
    compactCta.x + compactCta.width > compactViewport.width ||
    compactCta.y + compactCta.height > compactViewport.height) {
  throw new Error(`export action is clipped or undersized at 320x568: ${JSON.stringify(compactCta)}`);
}
await page.screenshot({ path: `${out}/export-render-320x568-at-3x.png` });
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/export-render-1280x900-at-3x.png` });
await browser.close();
