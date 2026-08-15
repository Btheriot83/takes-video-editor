import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage();
page.on('console', m => console.log('CON:', m.text().slice(0, 300)));
page.on('pageerror', e => console.log('ERR:', String(e).slice(0, 500)));
await page.goto('http://localhost:4173/', { waitUntil: 'load' });
const r = await page.evaluate(async () => {
  const t0 = performance.now();
  const res = await fetch('./ffmpeg/ffmpeg-core.wasm');
  const buf = await res.arrayBuffer();
  const t1 = performance.now();
  try {
    const mod = await WebAssembly.compile(buf);
    return { fetchMs: Math.round(t1 - t0), compiled: !!mod, compileMs: Math.round(performance.now() - t1) };
  } catch (e) { return { error: String(e) }; }
});
console.log('WASM PROBE:', JSON.stringify(r));
await browser.close();
