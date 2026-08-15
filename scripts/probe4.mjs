import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('console', m => console.log('CON:', m.type(), m.text().slice(0, 250)));
page.on('pageerror', e => console.log('PAGEERR:', String(e).slice(0, 500)));
await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Start recording"]:not([disabled])', { timeout: 15000 });
await page.click('button[aria-label="Start recording"]');
await page.waitForTimeout(2000);
await page.click('button[aria-label="Stop recording"]');
await page.waitForTimeout(800);
await page.click('text=Edit');
await page.waitForSelector('text=Export', { timeout: 10000 });
await page.waitForTimeout(500);
await page.click('text=Export');
await page.waitForSelector('text=Start export');
await page.click('text=Start export');
console.log('--- export clicked, watching 60s ---');
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const sheet = (await page.textContent('body')).replace(/\s+/g, ' ').slice(-200);
  console.log(`[${(i + 1) * 5}s]`, sheet);
}
await page.screenshot({ path: 'scripts/probe4.png' });
await browser.close();
