// Probe: run REAL MP4s through the demuxer-based decode path
// (demuxClip + captureClipViaDecoder):
//  - avc1 regular (moov+stbl) and avc1 FRAGMENTED (moof/trun — the shape
//    Safari's MediaRecorder produces on iPhone)
//  - vp9 FRAGMENTED (same fMP4 shape, but decodable by this Chromium)
//
// This Playwright Chromium ships NO H.264 decoder (no proprietary codecs), so
// for the avc variants the probe asserts the demux layer exhaustively:
//  - sample count matches ffprobe, frag flag correct
//  - extracted VideoDecoder description === the file's avcC payload byte-for-byte
//  - samples preserved in DECODE order (x264 emits B-frames: cts is NOT
//    monotonic, proving no cts re-sort happened)
//  - bitstream-derived sync flags: first sample is sync, exactly the IDR count
// When an engine with H.264 decode runs this probe, the full decode+encode
// assertions activate for the avc variants automatically. The vp9-frag
// variant always runs the FULL path (decode every frame, re-encode) so the
// fragmented-MP4 shape is exercised end-to-end regardless.
// Run: CHROME_PATH=... node scripts/probe-avc-decoder.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const OUT = 'scripts/e2e-out';
const PORT = Number(process.env.PROBE_PORT || 4471);
fs.mkdirSync(OUT, { recursive: true });

const fixtures = [
  { name: 'test-avc.mp4', frag: false, kind: 'avc', args: ['-c:v', 'libx264', '-profile:v', 'high'] },
  { name: 'test-avc-frag.mp4', frag: true, kind: 'avc', args: ['-c:v', 'libx264', '-profile:v', 'high', '-movflags', 'frag_keyframe+empty_moov'] },
  { name: 'test-vp9-frag.mp4', frag: true, kind: 'vp9', args: ['-c:v', 'libvpx-vp9', '-movflags', 'frag_keyframe+empty_moov'] },
];
for (const f of fixtures) {
  const path = `${OUT}/${f.name}`;
  if (!fs.existsSync(path)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30',
      '-t', '2', '-pix_fmt', 'yuv420p', ...f.args, path]);
  }
  f.frames = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path]).toString().trim());
  f.keyframes = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=flags', '-of', 'csv=p=0', path]).toString()
    .split('\n').filter((l) => l.includes('K')).length;
  if (f.kind === 'avc') {
    // Ground truth avcC payload: raw box scan (4-byte size precedes the type).
    const bytes = fs.readFileSync(path);
    const at = bytes.indexOf(Buffer.from('avcC', 'latin1'));
    if (at < 4) throw new Error(`${f.name}: no avcC box found`);
    const size = bytes.readUInt32BE(at - 4);
    f.avcC = bytes.subarray(at + 4, at - 4 + size).toString('base64'); // payload after 8B header
  }
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
try {
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/`);
        if (res.ok) { clearInterval(poll); resolve(); }
      } catch {
        if (Date.now() - start > 20000) { clearInterval(poll); reject(new Error('vite dev did not start')); }
      }
    }, 300);
  });

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const pageErrors = [];
  const exportLogs = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.text().startsWith('[export]')) exportLogs.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  const results = await page.evaluate(async (fixtureList) => {
    const mod = await import('/src/lib/webcodecs-export.ts');
    const out = { h264DecodeSupported: null, variants: [] };
    out.h264DecodeSupported = (await VideoDecoder.isConfigSupported({
      codec: 'avc1.640028', codedWidth: 1080, codedHeight: 1920,
    })).supported;
    for (const fixture of fixtureList) {
      const r = { name: fixture.name };
      try {
        const blob = await (await fetch(`/scripts/e2e-out/${fixture.name}`)).blob();
        const demuxed = await mod.demuxClip(blob);
        r.codec = demuxed.codec;
        r.samples = demuxed.samples.length;
        r.syncSamples = demuxed.samples.filter((s) => s.isSync).length;
        r.firstIsSync = demuxed.samples[0]?.isSync ?? false;
        // decode-order proof: with B-frames, cts must NOT be monotonic
        r.ctsMonotonic = demuxed.samples.every((s, i, a) => i === 0 || s.tsUs > a[i - 1].tsUs);
        r.fragmented = demuxed.fragmented;
        r.descriptionB64 = demuxed.description
          ? btoa(String.fromCharCode(...demuxed.description)) : null;
        r.exactCodecSupported = (await VideoDecoder.isConfigSupported({
          codec: demuxed.codec, description: demuxed.description,
          codedWidth: demuxed.codedWidth, codedHeight: demuxed.codedHeight,
        })).supported;

        if (r.exactCodecSupported) {
          // Full path: decode every frame and hand it to a real encoder.
          const canvas = new OffscreenCanvas(1080, 1920);
          const ctx = canvas.getContext('2d');
          const state = { offsetUs: 0, lastTs: -1, lastKeyTs: 0, frames: 0, error: null, lastActivity: Date.now() };
          let encoded = 0;
          const encoder = new VideoEncoder({
            output: () => { encoded += 1; },
            error: (e) => { state.error = e; },
          });
          encoder.configure({ codec: 'vp09.00.40.08', width: 1080, height: 1920, bitrate: 8_000_000 });
          const clip = {
            id: 'probe', blobKey: 'probe', mimeType: 'video/mp4', duration: 2,
            trimIn: 0, trimOut: 2, width: 1080, height: 1920, createdAt: 0, thumbs: [],
          };
          await mod.captureClipViaDecoder(clip, blob, canvas, ctx, encoder, state, () => {});
          await encoder.flush();
          encoder.close();
          r.decodedFrames = state.frames;
          r.encodedChunks = encoded;
          r.stateError = state.error ? String(state.error) : null;
        }
      } catch (error) {
        r.error = error instanceof Error ? error.message : String(error);
      }
      out.variants.push(r);
    }
    return out;
  }, fixtures.map(({ name }) => ({ name })));

  await browser.close();

  const failures = [];
  for (const f of fixtures) {
    const r = results.variants.find((v) => v.name === f.name);
    if (!r) { failures.push(`${f.name}: no result`); continue; }
    if (r.error) { failures.push(`${f.name}: ${r.error}`); continue; }
    // demux-layer assertions (always)
    if (r.samples !== f.frames) failures.push(`${f.name}: demuxed ${r.samples} samples, ffprobe says ${f.frames}`);
    if (r.fragmented !== f.frag) failures.push(`${f.name}: frag=${r.fragmented}, expected ${f.frag}`);
    if (!r.firstIsSync) failures.push(`${f.name}: first sample not sync`);
    if (r.syncSamples !== f.keyframes) failures.push(`${f.name}: ${r.syncSamples} sync samples, ffprobe says ${f.keyframes} keyframes`);
    if (f.kind === 'avc') {
      if (!/^avc1\./.test(r.codec)) failures.push(`${f.name}: codec ${r.codec} not avc1.*`);
      if (r.descriptionB64 !== f.avcC) failures.push(`${f.name}: description differs from avcC payload`);
      if (r.ctsMonotonic) failures.push(`${f.name}: cts monotonic — B-frame source appears cts-sorted, decode order lost`);
    }
    // full decode+encode assertions (whenever the engine can decode this codec)
    const decodable = f.kind === 'vp9' || results.h264DecodeSupported;
    if (decodable) {
      if (!r.exactCodecSupported) failures.push(`${f.name}: VideoDecoder rejects exact codec ${r.codec}`);
      if (r.decodedFrames !== f.frames) failures.push(`${f.name}: decoded ${r.decodedFrames}/${f.frames} frames`);
      if (r.encodedChunks !== f.frames) failures.push(`${f.name}: encoded ${r.encodedChunks}/${f.frames} chunks`);
      if (r.stateError) failures.push(`${f.name}: state error ${r.stateError}`);
    }
  }
  console.log(JSON.stringify({
    results, exportLogs, pageErrors,
    expected: fixtures.map((f) => ({ name: f.name, frames: f.frames, keyframes: f.keyframes, frag: f.frag })),
    note: results.h264DecodeSupported
      ? 'H.264 decode available: avc variants ran the FULL path'
      : 'this Chromium has no H.264 decoder: avc variants asserted at the demux/description/order layer only; vp9-frag ran the full path',
  }, null, 2));
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length) throw new Error(`AVC decoder probe FAILED:\n- ${failures.join('\n- ')}`);
  console.log('AVC decoder probe PASS');
} finally {
  vite.kill('SIGTERM');
}
