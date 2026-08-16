// Proves the WebCodecs export path end-to-end when a VideoEncoder IS available.
// Headless Chromium ships no H.264 encoder, so this run forces the test-only
// codec override (vp9, which it can encode) through the exact same pipeline:
// <video> decode -> paused frame-step capture (rVFC per seek) ->
// OffscreenCanvas -> VideoEncoder -> mp4-muxer -> wasm AAC audio ->
// "-c copy" faststart remux. The override is passed per page load via the
// ?wcodec= query parameter (localStorage is intentionally not honored).
// Run: node scripts/e2e-webcodecs.mjs http://localhost:PORT/
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = 'scripts/e2e-out';
const clipCount = Number(process.env.CLIP_COUNT || 2);
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const exportLogs = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('[export]')) exportLogs.push(text);
  if (message.type() === 'error') errors.push(text);
});
page.on('pageerror', (error) => errors.push(String(error)));

const url = new URL(BASE);
url.searchParams.set('wcodec', 'vp09.00.51.08');
// SCALER=webgl proves the WebGL middle rung: ?scaler=webgl makes scaleFrame
// skip the createImageBitmap rung for this page load (same test-only query
// param pattern as ?wcodec).
const forcedScaler = process.env.SCALER || '';
if (forcedScaler) url.searchParams.set('scaler', forcedScaler);
await page.goto(url.toString(), { waitUntil: 'load' });
await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 15000 });
const record = page.getByRole('button', { name: 'Hold to record' });
for (let index = 0; index < clipCount; index++) {
  const box = await record.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: index + 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForSelector('button[aria-label="Release to stop recording"]', { timeout: 5000 });
  await page.waitForTimeout(1100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('button[aria-label="Hold to record"]:not([disabled])', { timeout: 2000 });
}
await page.getByText('Edit', { exact: true }).click();
await page.locator('[data-editor-frame]').waitFor();

// Snapshot the source clips (straight out of IndexedDB) so ffprobe can count
// the true number of source frames for the frame-completeness assertion.
const sources = await page.evaluate(async () => {
  const open = indexedDB.open('takes-db', 1);
  const db = await new Promise((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const get = (store, key) => new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const project = await get('project', 'current');
  const result = [];
  for (const clip of project.clips) {
    const blob = await get('blobs', clip.blobKey);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    result.push({ trimIn: clip.trimIn, trimOut: clip.trimOut, duration: clip.duration, base64: btoa(bin) });
  }
  return result;
});
let sourceFrames = 0;
sources.forEach((source, index) => {
  const file = `${OUT}/webcodecs-src-${index}.webm`;
  fs.writeFileSync(file, Buffer.from(source.base64, 'base64'));
  const count = Number(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file,
  ]).toString().trim());
  sourceFrames += count;
});

await page.getByText('Export video', { exact: true }).click();
const dialog = page.getByRole('dialog', { name: 'Export video' });
// HD fake-camera clips default the sheet to 1080p, which would remux and
// bypass the encoder under test; force the 4K transcode path explicitly.
await dialog.getByRole('button', { name: '4K', exact: true }).click();
await dialog.getByText(/4K · 2160 × 3840/).waitFor();
await dialog.getByRole('button', { name: 'Start export' }).click();
await dialog.getByText('Video ready to share or download').waitFor({ timeout: 300000 });
const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await dialog.getByRole('button', { name: 'Download MP4' }).click();
const download = await downloadPromise;
const output = `${OUT}/exported-webcodecs.mp4`;
await download.saveAs(output);

const usedWebCodecs = exportLogs.some((l) => l.includes('using webcodecs encoder'));
const fellBack = exportLogs.some((l) => l.includes('webcodecs path failed'));
// The demuxer-based decode path (mp4box + VideoDecoder) must carry every clip:
// the fake camera records vp9-in-mp4, which is decoder-path eligible.
const decoderClips = exportLogs.filter((l) => / mode=decoder$/.test(l)).length;
const elementClips = exportLogs.filter((l) => / mode=element$/.test(l)).length;

// --- ffprobe assertions on the delivered file ---
const streams = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-count_packets', '-show_entries',
  'stream=codec_type,codec_name,width,height,duration,nb_read_packets', '-of', 'json', output,
]).toString()).streams;
const video = streams.find((s) => s.codec_type === 'video');
const audio = streams.find((s) => s.codec_type === 'audio');
if (!video || !audio) throw new Error(`expected video+audio streams, got ${JSON.stringify(streams)}`);
if (video.width !== 2160 || video.height !== 3840) {
  throw new Error(`expected 2160x3840, got ${video.width}x${video.height}`);
}
const videoDur = Number(video.duration);
const audioDur = Number(audio.duration);
const avSkew = Math.abs(videoDur - audioDur);
if (!(avSkew < 0.15)) throw new Error(`|video-audio| duration skew ${avSkew.toFixed(3)}s exceeds 150ms`);

// faststart: the moov box must precede mdat in the file.
const bytes = fs.readFileSync(output);
const boxOffset = (type) => {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const name = bytes.toString('latin1', offset + 4, offset + 8);
    if (name === type) return offset;
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    else if (size === 0) break;
    if (size < 8) break;
    offset += size;
  }
  return -1;
};
const moovAt = boxOffset('moov');
const mdatAt = boxOffset('mdat');
if (moovAt < 0 || mdatAt < 0 || moovAt > mdatAt) {
  throw new Error(`not faststart: moov@${moovAt} mdat@${mdatAt}`);
}

// Frame completeness: the deterministic frame-step capture must deliver
// (near-)every source frame; tolerate only tiny boundary losses.
const exportedFrames = Number(video.nb_read_packets);
const completeness = exportedFrames / sourceFrames;
if (!(completeness >= 0.95)) {
  throw new Error(`frame-complete capture failed: ${exportedFrames}/${sourceFrames} source frames (${(completeness * 100).toFixed(1)}%)`);
}

// --- orientation check: prove the scaler did not vertically flip frames ---
// Extract the same-numbered frame from clip 1's source and the export, scale
// both to a common size, then compare the export against the source upright
// and vertically flipped. A correct scaler must match the upright source
// better than the flipped one (the fake-camera pattern is not vertically
// symmetric), regardless of which scaler rung produced the frames.
const ssimAgainst = (flip) => {
  const res = spawnSync('ffmpeg', [
    '-v', 'info',
    '-i', output, '-i', `${OUT}/webcodecs-src-0.webm`,
    '-lavfi',
    `[0:v]select=eq(n\\,10),scale=270:480,format=gray[a];` +
    `[1:v]select=eq(n\\,10),scale=270:480,format=gray${flip ? ',vflip' : ''}[b];[a][b]ssim`,
    '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const match = res.stderr.match(/SSIM.*All:([\d.]+)/);
  if (!match) throw new Error(`ssim probe failed: ${res.stderr.slice(-400)}`);
  return Number(match[1]);
};
const ssimUpright = ssimAgainst(false);
const ssimFlipped = ssimAgainst(true);
if (!(ssimUpright > ssimFlipped)) {
  throw new Error(`orientation check failed: export matches vflipped source better (upright=${ssimUpright} flipped=${ssimFlipped})`);
}
const scalerLog = exportLogs.find((l) => l.includes('scaler:')) || null;
if (forcedScaler === 'webgl' && !exportLogs.some((l) => l.includes('scaler: webgl'))) {
  throw new Error(`SCALER=webgl run did not engage the WebGL scaler (saw: ${scalerLog})`);
}

console.log(JSON.stringify({
  clipCount, output, bytes: fs.statSync(output).size, usedWebCodecs, fellBack, decoderClips, elementClips,
  forcedScaler, scalerLog, ssimUpright, ssimFlipped,
  video: { width: video.width, height: video.height, duration: videoDur, frames: exportedFrames },
  audio: { codec: audio.codec_name, duration: audioDur },
  avSkew, moovAt, mdatAt, sourceFrames, completeness,
  exportLogs, browserErrors: errors,
}, null, 2));
await browser.close();
if (!usedWebCodecs || fellBack) throw new Error('export did not complete through the WebCodecs path');
if (decoderClips !== clipCount || elementClips !== 0) {
  throw new Error(`expected all ${clipCount} clips via mode=decoder, got decoder=${decoderClips} element=${elementClips}`);
}
if (errors.length) throw new Error(`browser reported ${errors.length} error(s)`);
