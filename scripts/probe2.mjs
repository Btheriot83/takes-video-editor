import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (t.includes('[probe]')) console.log(t.slice(0, 200)); });
page.on('pageerror', e => console.log('ERR:', String(e).slice(0, 500)));
await page.goto('http://localhost:4173/test-ffmpeg.html', { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('log').textContent.includes('DONE') || document.getElementById('log').textContent.includes('FAILED'), { timeout: 240000 });
console.log('FINAL:', (await page.textContent('#log')).split('\n').slice(-3).join(' | '));
await browser.close();
