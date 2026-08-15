// Probe: does this Chromium support WebCodecs avc1 encoding (hardware/software)?
import { chromium } from 'playwright-core';
import http from 'node:http';
const server = http.createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>probe</title>'); });
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${server.address().port}/`);
const res = await page.evaluate(async () => {
  const out = { hasVE: typeof VideoEncoder !== 'undefined', hasRVFC: 'requestVideoFrameCallback' in HTMLVideoElement.prototype };
  if (!out.hasVE) return out;
  for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software']) {
    for (const [label, codec, w, h] of [
      ['4k', 'avc1.640033', 2160, 3840], ['1080', 'avc1.640028', 1080, 1920],
      ['4k-vp9', 'vp09.00.51.08', 2160, 3840], ['4k-av1', 'av01.0.13M.08', 2160, 3840],
    ]) {
      try {
        const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 35_000_000, hardwareAcceleration: hw, avc: { format: 'avc' } });
        out[`${hw}/${label}`] = s.supported;
      } catch (e) { out[`${hw}/${label}`] = 'err:' + e.message; }
    }
  }
  return out;
});
console.log(JSON.stringify(res, null, 2));
await browser.close();
server.close();
