import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { clipLen } from '../types/clip';
import type { Clip, ExportQuality } from '../types/clip';
import { exportLog } from './export-log';

/**
 * WebCodecs render path: decode each clip in an offscreen <video>, step it
 * frame by frame (paused seeks + requestVideoFrameCallback), draw each
 * presented frame onto an OffscreenCanvas and hand it to a (preferably
 * hardware) VideoEncoder. The encoded chunks are muxed into a video-only MP4
 * with mp4-muxer; the caller adds the AAC audio track afterwards.
 *
 * This exists because single-threaded wasm x264 cannot finish a 2160x3840
 * encode on real phones/laptops, and the pthread core deadlocks in Chrome.
 * Hardware encoders finish the same export in roughly real time.
 *
 * Capture is deterministic, not realtime: earlier realtime playback capture
 * silently dropped 28-52% of frames on slow machines because rVFC only fires
 * for frames the compositor managed to present. Seek-stepping presents every
 * source frame exactly once regardless of machine speed.
 *
 * Frame timing is preserved exactly as presented (VFR): each frame keeps its
 * mediaTime relative to the clip's FIRST CAPTURED frame, offset by the
 * accumulated length of the preceding clips. Anchoring to the first captured
 * frame (rather than trimIn, or a whole-track muxer offset) keeps every clip's
 * video aligned with its ffmpeg-encoded audio, which is likewise anchored to
 * its own start (asetpts=PTS-STARTPTS) — imports with nonzero start_time would
 * otherwise carry a constant A/V skew.
 */

export interface WebCodecsPlan {
  config: VideoEncoderConfig;
  muxerCodec: 'avc' | 'vp9' | 'av1' | 'hevc';
}

// Test-only escape hatch: headless Chromium builds used by the e2e suite ship
// no H.264 encoder, so the suite can force a codec they do support (vp9) to
// exercise this whole pipeline. It must be requested explicitly per page load
// via the ?wcodec= query parameter; persistent state (localStorage) is
// deliberately NOT honored so the override cannot linger for real users.
function codecOverride(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('wcodec');
  } catch {
    return null;
  }
}

function muxerCodecFor(codec: string): WebCodecsPlan['muxerCodec'] | null {
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'avc';
  if (codec.startsWith('vp09')) return 'vp9';
  if (codec.startsWith('av01')) return 'av1';
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 'hevc';
  return null;
}

/**
 * Smallest H.264 level that satisfies both the frame-size (MaxFS) and
 * macroblock-rate (MaxMBPS) limits of the spec for this output. A hardcoded
 * level 5.1 was previously used for 4K, which is out of spec above 30fps at
 * 2160x3840 (32,640 MBs x 60fps far exceeds level 5.1's 983,040 MB/s) — and
 * isConfigSupported cannot flag that unless a framerate is supplied.
 */
export function avcLevelFor(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * Math.max(1, fps);
  // [level byte, MaxFS (MBs), MaxMBPS (MBs/s)] — H.264 Annex A, Table A-1.
  const levels: Array<[number, number, number]> = [
    [0x28, 8192, 245_760], // 4.0
    [0x2a, 8704, 522_240], // 4.2
    [0x32, 22_080, 589_824], // 5.0
    [0x33, 36_864, 983_040], // 5.1
    [0x34, 36_864, 2_073_600], // 5.2
    [0x3c, 139_264, 4_177_920], // 6.0
    [0x3d, 139_264, 8_355_840], // 6.1
  ];
  for (const [level, maxFs, maxMbps] of levels) {
    if (mbs <= maxFs && mbps <= maxMbps) return level;
  }
  return 0x3d;
}

const hasWebCodecsPrereqs = () =>
  typeof VideoEncoder !== 'undefined' &&
  typeof VideoFrame !== 'undefined' &&
  typeof OffscreenCanvas !== 'undefined' &&
  typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/**
 * Decide whether the fast encode path is usable for this output. Returns the
 * supported encoder configuration, or null to use the wasm pipeline.
 * `maxSourceFps` is the highest source frame rate among the clips; it selects
 * a spec-conformant H.264 level and is passed to the encoder as `framerate` so
 * isConfigSupported can veto rates the hardware cannot sustain.
 */
export async function planWebCodecsEncode(
  width: number,
  height: number,
  quality: ExportQuality,
  maxSourceFps = 30,
): Promise<WebCodecsPlan | null> {
  if (!hasWebCodecsPrereqs()) return null;
  const bitrate = quality === '4K' ? 35_000_000 : 14_000_000;
  // 60fps ceiling: capture never exceeds it and higher figures are probe
  // artifacts that inflate the H.264 level past what hardware accepts.
  const framerate = Math.min(60, Math.max(1, Math.round(maxSourceFps)));
  const base: VideoEncoderConfig = { codec: '', width, height, bitrate, framerate };

  const override = codecOverride();
  const candidates: VideoEncoderConfig[] = [];
  if (override) {
    candidates.push({ ...base, codec: override });
  } else {
    // High profile; level derived from output size and source frame rate
    // (e.g. 5.1 covers 2160x3840@30, 5.2 is required above 30fps at 4K).
    const codecFor = (fps: number) =>
      `avc1.6400${avcLevelFor(width, height, fps).toString(16).padStart(2, '0').toUpperCase()}`;
    const avc = { avc: { format: 'avc' as const } };
    // Prefer real hardware; accept the platform's native software encoder as a
    // second choice (still native code, far faster than wasm x264). A final
    // conservative rung (30fps envelope, level for 30) covers hardware that
    // rejects the higher level despite claiming support.
    candidates.push({ ...base, codec: codecFor(framerate), hardwareAcceleration: 'prefer-hardware', ...avc });
    candidates.push({ ...base, codec: codecFor(framerate), hardwareAcceleration: 'no-preference', ...avc });
    if (framerate > 30) {
      candidates.push({ ...base, framerate: 30, codec: codecFor(30), hardwareAcceleration: 'prefer-hardware', ...avc });
    }
  }

  for (const config of candidates) {
    const muxerCodec = muxerCodecFor(config.codec);
    if (!muxerCodec) continue;
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (!support.supported) {
        exportLog(`encoder rejected by isConfigSupported: ${config.codec} ${config.hardwareAcceleration ?? 'default'}`);
        continue;
      }
      // isConfigSupported is optimistic on some platforms (notably Safari):
      // configs it accepts can still fail at configure()/first encode. Prove
      // the config with a real one-frame encode before committing the export.
      if (await preflightEncode(config)) {
        exportLog(`encoder preflight OK: ${config.codec} ${config.hardwareAcceleration ?? 'default'} @${config.framerate}fps`);
        return { config, muxerCodec };
      }
      exportLog(`encoder preflight failed: ${config.codec} ${config.hardwareAcceleration ?? 'default'}`);
    } catch {
      // An unknown codec string or option throws; just try the next candidate.
    }
  }
  return null;
}

/**
 * Prove an encoder config with a real one-frame encode. Catches platforms
 * whose isConfigSupported accepts configs their hardware then rejects at
 * configure() or on the first frame — committing a full export to such a
 * config fails at "Rendering video 5%".
 */
async function preflightEncode(config: VideoEncoderConfig): Promise<boolean> {
  let encoder: VideoEncoder | null = null;
  try {
    let failed = false;
    encoder = new VideoEncoder({
      output: () => {},
      error: () => { failed = true; },
    });
    encoder.configure(config);
    const canvas = new OffscreenCanvas(config.width, config.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.fillRect(0, 0, 4, 4);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
    return !failed;
  } catch {
    return false;
  } finally {
    try {
      if (encoder && encoder.state !== 'closed') encoder.close();
    } catch { /* already closed */ }
  }
}

interface RenderState {
  /** timestamp offset of the current clip within the output, microseconds */
  offsetUs: number;
  lastTs: number;
  lastKeyTs: number;
  frames: number;
  error: unknown;
  lastActivity: number;
}

const abortError = () => new DOMException('Export cancelled', 'AbortError');

function drawCover(
  ctx: OffscreenCanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
) {
  // Same semantics as the wasm filter chain:
  // scale=W:H:force_original_aspect_ratio=increase + centered crop.
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('video has no dimensions');
  const scale = Math.max(width / vw, height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

function waitForQueueDrain(
  encoder: VideoEncoder,
  state: RenderState,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      state.lastActivity = Date.now();
      if (signal?.aborted) reject(abortError());
      else if (encoder.state !== 'configured' || encoder.encodeQueueSize <= 2) resolve();
      else setTimeout(check, 40);
    };
    check();
  });
}

/**
 * Seek the paused video to `target` and resolve with the mediaTime of the
 * frame the seek presented, or null if no (new) frame was presented within the
 * timeout. rVFC is registered before the seek starts so the presentation
 * cannot be missed; a seek that lands inside the currently-presented frame
 * re-presents it in Chrome, but the timeout covers engines that skip that.
 */
function seekPresent(video: HTMLVideoElement, target: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const handle = video.requestVideoFrameCallback((_now, meta) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(meta.mediaTime);
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      video.cancelVideoFrameCallback(handle);
      resolve(null);
    }, timeoutMs);
    video.currentTime = target;
  });
}

async function captureClip(
  clip: Clip,
  blob: Blob,
  video: HTMLVideoElement,
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  encoder: VideoEncoder,
  state: RenderState,
  onSeconds: (s: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const len = clipLen(clip);
  const base = state.offsetUs;
  const EPS = 1e-4;
  try {
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('clip decode timed out')), 10_000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('clip failed to decode'));
      };
    });
    video.pause();

    // Frame-complete capture: with the video paused, seek from frame to frame
    // and encode every presented frame in [trimIn, trimOut) exactly once. The
    // step starts small and adapts to half of the smallest observed frame
    // interval, so VFR sources cannot be under-sampled; a step that lands on
    // the same frame simply advances further. Every source frame is therefore
    // captured regardless of how slow drawing/encoding is on this machine.
    let captured = 0;
    let firstT = -1; // clip-local anchor: mediaTime of the first captured frame
    let lastT = -1;
    let minDelta = Infinity;
    const end = Math.min(clip.trimOut, Number.isFinite(video.duration) ? video.duration : clip.trimOut);

    let t = await seekPresent(video, Math.max(0, clip.trimIn), 3000);
    if (t === null) t = await seekPresent(video, Math.max(0, clip.trimIn) + 0.001, 3000);
    if (t === null) throw new Error('could not present first frame');

    for (;;) {
      if (signal?.aborted) throw abortError();
      if (state.error) throw state.error instanceof Error ? state.error : new Error(String(state.error));
      state.lastActivity = Date.now();

      if (t >= clip.trimOut - EPS) break;
      if (t > lastT + 1e-6) {
        // capture this frame
        if (firstT >= 0 && t - lastT > 0) minDelta = Math.min(minDelta, t - lastT);
        if (firstT < 0) firstT = t;
        const rel = Math.min(len, Math.max(0, t - firstT));
        let ts = base + Math.round(rel * 1_000_000);
        // Timestamps must be strictly increasing for the muxer.
        if (ts <= state.lastTs) ts = state.lastTs + 1_000;
        state.lastTs = ts;
        drawCover(ctx, video, canvas.width, canvas.height);
        const frame = new VideoFrame(canvas, { timestamp: ts });
        const keyFrame = state.frames === 0 || ts - state.lastKeyTs >= 2_000_000;
        if (keyFrame) state.lastKeyTs = ts;
        encoder.encode(frame, { keyFrame });
        frame.close();
        state.frames += 1;
        captured += 1;
        lastT = t;
        onSeconds(rel);
        if (encoder.encodeQueueSize > 4) await waitForQueueDrain(encoder, state, signal);
      }

      // advance to the next distinct frame
      const from = Math.max(lastT, t);
      const step = Number.isFinite(minDelta) ? Math.max(1 / 240, minDelta / 2) : 1 / 120;
      let target = from + step;
      let next: number | null = null;
      let attempts = 0;
      while (attempts < 90 && target < end + step) {
        if (signal?.aborted) throw abortError();
        next = await seekPresent(video, target, 1000);
        if (next !== null && next > from + 1e-6) break;
        next = null;
        target += step;
        attempts += 1;
      }
      if (next === null) break; // no further frame before trimOut / end of media
      t = next;
    }
    if (!captured) throw new Error('no frames captured from clip');
    exportLog(
      `webcodecs captured ${captured} frames (${(len).toFixed(2)}s clip, min frame delta ${
        Number.isFinite(minDelta) ? (minDelta * 1000).toFixed(1) : 'n/a'
      }ms)`,
    );
  } finally {
    video.onended = null;
    video.onerror = null;
    video.onloadeddata = null;
    // Release the decoder promptly (matters on mobile).
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    // Let the release actually start before anything else runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  state.offsetUs = base + Math.round(len * 1_000_000);
}

/**
 * Render all clips to a video-only MP4 (bytes) using the given encoder plan.
 * Throws on any failure; the caller is expected to fall back to wasm.
 * Aborting the signal stops the capture loop, closes the encoder and rejects
 * with an AbortError DOMException.
 */
export async function renderVideoWebCodecs(
  clips: Clip[],
  blobs: Blob[],
  width: number,
  height: number,
  plan: WebCodecsPlan,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError();
  const total = clips.reduce((s, c) => s + clipLen(c), 0) || 1;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: plan.muxerCodec, width, height },
    // The final ffmpeg "-c copy" remux applies +faststart; keep muxing cheap.
    // Timestamps are anchored per clip (first captured frame = clip offset),
    // so the first sample lands at exactly 0 and no muxer-level offset — which
    // would shift video against the separately-encoded audio — is needed.
    fastStart: false,
  });

  const state: RenderState = {
    offsetUs: 0,
    lastTs: -1,
    lastKeyTs: 0,
    frames: 0,
    error: null,
    lastActivity: Date.now(),
  };

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      state.lastActivity = Date.now();
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (error) {
        state.error = error;
      }
    },
    error: (error) => {
      state.error = error;
    },
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');

  // Each clip gets a FRESH <video> element. Reusing one element across many
  // blob-src swaps starves iOS Safari of decoder sessions (AVPlayer-backed
  // elements release their hardware decoder lazily), which made multi-clip
  // exports fail on the third clip while one- and two-clip exports passed.
  const makeVideo = () => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    return v;
  };

  try {
    encoder.configure(plan.config);
    for (let i = 0; i < clips.length; i++) {
      const done = clips.slice(0, i).reduce((s, c) => s + clipLen(c), 0);
      const progress = (s: number) => onProgress?.(Math.min(0.99, (done + s) / total));
      exportLog(`clip ${i + 1}/${clips.length}: decode+capture start`);
      const framesBefore = state.frames;
      try {
        await captureClip(clips[i], blobs[i], makeVideo(), canvas, ctx, encoder, state, progress, signal);
      } catch (error) {
        // Retry only when the clip contributed nothing yet — a mid-clip retry
        // would re-encode frames already handed to the muxer.
        if (signal?.aborted || state.error || state.frames !== framesBefore) throw error;
        // One retry with another fresh element and a breather: transient
        // decoder-session exhaustion (iOS) recovers once the previous
        // element's release completes.
        exportLog(`clip ${i + 1} capture failed (${error instanceof Error ? error.message : error}); retrying once`);
        await new Promise((r) => setTimeout(r, 400));
        await captureClip(clips[i], blobs[i], makeVideo(), canvas, ctx, encoder, state, progress, signal);
      }
      // Give iOS's lazy AVPlayer teardown a beat before opening the next
      // decoder session; without it, back-to-back sessions starve on phones.
      if (i + 1 < clips.length) await new Promise((r) => setTimeout(r, 150));
    }
    await encoder.flush();
    if (signal?.aborted) throw abortError();
    if (state.error) throw state.error instanceof Error ? state.error : new Error(String(state.error));
    if (!state.frames) throw new Error('no frames encoded');
    muxer.finalize();
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      // already closed
    }
  }
  onProgress?.(1);
  exportLog(`webcodecs total frames encoded: ${state.frames}`);
  return new Uint8Array(muxer.target.buffer);
}
