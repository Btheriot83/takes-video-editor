import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { clipLen } from '../types/clip';
import type { Clip, ExportQuality } from '../types/clip';

/**
 * WebCodecs render path: decode each clip in an offscreen <video>, capture the
 * real presented frames via requestVideoFrameCallback, scale/crop them on an
 * OffscreenCanvas and hand them to a (preferably hardware) VideoEncoder. The
 * encoded chunks are muxed into a video-only MP4 with mp4-muxer; the caller
 * adds the AAC audio track afterwards.
 *
 * This exists because single-threaded wasm x264 cannot finish a 2160x3840
 * encode on real phones/laptops, and the pthread core deadlocks in Chrome.
 * Hardware encoders finish the same export in roughly real time.
 *
 * Frame timing is preserved exactly as presented (VFR): each frame keeps its
 * mediaTime relative to the clip's trim-in, offset by the accumulated length
 * of the preceding clips, so concatenation is continuous and nothing is
 * snapped onto a fixed frame grid (that grid caused the old stutter bug).
 */

export interface WebCodecsPlan {
  config: VideoEncoderConfig;
  muxerCodec: 'avc' | 'vp9' | 'av1' | 'hevc';
}

// Test-only escape hatch: headless Chromium builds used by the e2e suite ship
// no H.264 encoder, so the suite can force a codec they do support (vp9) to
// exercise this whole pipeline. Real users never have this key set.
function codecOverride(): string | null {
  try {
    return localStorage.getItem('takes:webcodecs-codec');
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

const hasWebCodecsPrereqs = () =>
  typeof VideoEncoder !== 'undefined' &&
  typeof VideoFrame !== 'undefined' &&
  typeof OffscreenCanvas !== 'undefined' &&
  typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/**
 * Decide whether the fast encode path is usable for this output. Returns the
 * supported encoder configuration, or null to use the wasm pipeline.
 */
export async function planWebCodecsEncode(
  width: number,
  height: number,
  quality: ExportQuality,
): Promise<WebCodecsPlan | null> {
  if (!hasWebCodecsPrereqs()) return null;
  const bitrate = quality === '4K' ? 35_000_000 : 14_000_000;
  const base: VideoEncoderConfig = { codec: '', width, height, bitrate };

  const override = codecOverride();
  const candidates: VideoEncoderConfig[] = [];
  if (override) {
    candidates.push({ ...base, codec: override });
  } else {
    // High profile; level 5.1 covers 2160x3840@30, level 4.0 covers 1080x1920.
    const codec = quality === '4K' ? 'avc1.640033' : 'avc1.640028';
    const avc = { avc: { format: 'avc' as const } };
    // Prefer real hardware; accept the platform's native software encoder as a
    // second choice (still native code, far faster than wasm x264).
    candidates.push({ ...base, codec, hardwareAcceleration: 'prefer-hardware', ...avc });
    candidates.push({ ...base, codec, hardwareAcceleration: 'no-preference', ...avc });
  }

  for (const config of candidates) {
    const muxerCodec = muxerCodecFor(config.codec);
    if (!muxerCodec) continue;
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return { config, muxerCodec };
    } catch {
      // An unknown codec string or option throws; just try the next candidate.
    }
  }
  return null;
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

function waitForQueueDrain(encoder: VideoEncoder, state: RenderState): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      state.lastActivity = Date.now();
      if (encoder.state !== 'configured' || encoder.encodeQueueSize <= 2) resolve();
      else setTimeout(check, 40);
    };
    check();
  });
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    // Best effort: MediaRecorder webm sometimes seeks unreliably; a failed or
    // ignored seek is fine because frames before trimIn are filtered out.
    const timer = setTimeout(resolve, 1500);
    video.onseeked = () => {
      clearTimeout(timer);
      resolve();
    };
    video.currentTime = t;
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
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const len = clipLen(clip);
  const base = state.offsetUs;
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
    if (clip.trimIn > 0.25) await seekTo(video, clip.trimIn);

    let captured = 0;
    let firstPresented = -1;
    let lastPresented = -1;
    let lastRateAdjustSpan = 0;
    video.playbackRate = 1;
    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      const finish = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(watchdog);
        video.pause();
        resolve();
      };
      const fail = (error: unknown) => {
        if (stopped) return;
        stopped = true;
        clearInterval(watchdog);
        video.pause();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      // If decode or encode stops making progress (background throttling,
      // stuck pipeline), bail out so the caller can fall back to wasm.
      state.lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - state.lastActivity > 20_000) fail(new Error('webcodecs render stalled'));
        if (state.error) fail(state.error);
      }, 2_000);

      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (stopped) return;
        state.lastActivity = Date.now();
        if (state.error) {
          fail(state.error);
          return;
        }
        const t = meta.mediaTime;
        if (t >= clip.trimOut - 1e-4) {
          finish();
          return;
        }
        if (t >= clip.trimIn - 1e-4) {
          try {
            const rel = Math.min(len, Math.max(0, t - clip.trimIn));
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
            if (firstPresented < 0) firstPresented = meta.presentedFrames;
            lastPresented = meta.presentedFrames;
            // If realtime playback outruns capture+encode, frames never reach
            // rVFC. Slowing the offscreen playback widens the per-frame budget
            // (mediaTime timestamps are unaffected, so output timing stays
            // identical); the export just takes a little longer.
            const span = lastPresented - firstPresented + 1;
            if (span - lastRateAdjustSpan >= 10 && captured / span < 0.7 && video.playbackRate > 0.3) {
              lastRateAdjustSpan = span;
              video.playbackRate = Math.max(0.25, video.playbackRate / 2);
            }
            onSeconds(rel);
            if (encoder.encodeQueueSize > 4) {
              // Encoder is behind the realtime decode; pause until it drains.
              video.pause();
              void waitForQueueDrain(encoder, state).then(() => {
                if (!stopped) void video.play().catch(fail);
              });
            }
          } catch (error) {
            fail(error);
            return;
          }
        }
        video.requestVideoFrameCallback(onFrame);
      };

      video.onended = finish;
      video.onerror = () => fail(new Error('clip playback failed'));
      video.requestVideoFrameCallback(onFrame);
      void video.play().catch(fail);
    });
    if (!captured) throw new Error('no frames captured from clip');
    // rVFC only reports frames the browser actually presented; when the page
    // cannot keep up with realtime playback some source frames are skipped.
    // Timing stays correct (VFR), but log the loss for diagnostics.
    const span = lastPresented - firstPresented + 1;
    if (span > captured) {
      console.log(`[export] webcodecs capture skipped ${span - captured}/${span} presented frames`);
    }
  } finally {
    video.onended = null;
    video.onerror = null;
    // Release the decoder promptly (matters on mobile).
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
  state.offsetUs = base + Math.round(len * 1_000_000);
}

/**
 * Render all clips to a video-only MP4 (bytes) using the given encoder plan.
 * Throws on any failure; the caller is expected to fall back to wasm.
 */
export async function renderVideoWebCodecs(
  clips: Clip[],
  blobs: Blob[],
  width: number,
  height: number,
  plan: WebCodecsPlan,
  onProgress?: (p: number) => void,
): Promise<Uint8Array> {
  const total = clips.reduce((s, c) => s + clipLen(c), 0) || 1;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: plan.muxerCodec, width, height },
    // The final ffmpeg "-c copy" remux applies +faststart; keep muxing cheap.
    fastStart: false,
    firstTimestampBehavior: 'offset',
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

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  try {
    encoder.configure(plan.config);
    for (let i = 0; i < clips.length; i++) {
      const done = clips.slice(0, i).reduce((s, c) => s + clipLen(c), 0);
      await captureClip(clips[i], blobs[i], video, canvas, ctx, encoder, state, (s) =>
        onProgress?.(Math.min(0.99, (done + s) / total)),
      );
    }
    await encoder.flush();
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
  return new Uint8Array(muxer.target.buffer);
}
