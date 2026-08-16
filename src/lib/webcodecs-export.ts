import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { createFile, DataStream, Endianness, Log, MP4BoxBuffer } from 'mp4box';
import type { ISOFile, Movie, Sample, Track } from 'mp4box';
import { clipLen } from '../types/clip';
import type { Clip, ExportQuality } from '../types/clip';
import { exportLog } from './export-log';

/**
 * WebCodecs render path: decode each clip in an offscreen <video>, step it
 * frame by frame (paused seeks + requestVideoFrameCallback), draw each
 * presented frame onto an OffscreenCanvas and hand it to a (preferably
 * hardware) VideoEncoder. The encoded chunks are muxed with mp4-muxer; the
 * caller's ffmpeg-encoded AAC audio (raw ADTS frames) is muxed directly into
 * the same file, producing the final faststart MP4 with no ffmpeg remux.
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

// ---------------------------------------------------------------------------
// ADTS AAC parsing: the audio pipeline (ffmpeg.wasm) emits raw AAC in an ADTS
// stream, and the frames are muxed directly into the mp4-muxer output next to
// the video track — eliminating the former "-c copy" ffmpeg remux (and the
// MEMFS round-trip of the entire video) from the export's critical path.
// ---------------------------------------------------------------------------

export interface AdtsFrame {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
}

export interface AdtsAudio {
  sampleRate: number;
  numberOfChannels: number;
  /** MPEG-4 AudioSpecificConfig (esds decoder description) */
  audioSpecificConfig: Uint8Array;
  frames: AdtsFrame[];
}

/** ADTS sampling_frequency_index table (ISO 14496-3). */
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350,
];

/**
 * Parse an ADTS AAC elementary stream into per-frame payloads with timestamps
 * on a gapless 1024-samples-per-frame grid starting at 0. Header layout
 * (7 bytes, 9 with CRC): 12-bit syncword 0xFFF, MPEG version/layer,
 * protection_absent; profile (AOT-1), sampling_frequency_index and channel
 * configuration; 13-bit frame_length spanning bytes 3-5. Also builds the
 * AudioSpecificConfig (AOT, freq index, channel config) the MP4 esds needs.
 */
export function parseAdts(bytes: Uint8Array): AdtsAudio {
  const frames: AdtsFrame[] = [];
  let sampleRate = 0;
  let numberOfChannels = 0;
  let objectType = 2; // AAC-LC
  let freqIndex = -1;
  let chanCfg = 0;
  let offset = 0;
  while (offset + 7 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf0) !== 0xf0) {
      throw new Error(`ADTS sync lost at byte ${offset}`);
    }
    const protectionAbsent = (bytes[offset + 1] & 0x01) === 1;
    const headerLength = protectionAbsent ? 7 : 9;
    const profile = (bytes[offset + 2] >> 6) & 0x03; // AOT - 1
    const thisFreqIndex = (bytes[offset + 2] >> 2) & 0x0f;
    const thisChanCfg = ((bytes[offset + 2] & 0x01) << 2) | (bytes[offset + 3] >> 6);
    const frameLength =
      ((bytes[offset + 3] & 0x03) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
    if (frameLength < headerLength || offset + frameLength > bytes.length) {
      throw new Error(`ADTS frame length ${frameLength} invalid at byte ${offset}`);
    }
    const rate = ADTS_SAMPLE_RATES[thisFreqIndex];
    if (!rate) throw new Error(`ADTS sampling frequency index ${thisFreqIndex} unsupported`);
    if (freqIndex < 0) {
      objectType = profile + 1;
      freqIndex = thisFreqIndex;
      sampleRate = rate;
      chanCfg = thisChanCfg;
      numberOfChannels = thisChanCfg;
    }
    frames.push({
      data: bytes.slice(offset + headerLength, offset + frameLength),
      timestampUs: 0, // filled below on the gapless sample grid
      durationUs: 0,
    });
    offset += frameLength;
  }
  if (!frames.length || !sampleRate || !numberOfChannels) {
    throw new Error('ADTS stream contained no decodable frames');
  }
  // Gapless grid: frame i covers samples [i*1024, (i+1)*1024) at sampleRate.
  // Deriving each timestamp from the sample index (not by accumulating a
  // rounded per-frame duration) keeps long tracks drift-free.
  const tsAt = (i: number) => Math.round((i * 1024 * 1_000_000) / sampleRate);
  for (let i = 0; i < frames.length; i++) {
    frames[i].timestampUs = tsAt(i);
    frames[i].durationUs = tsAt(i + 1) - tsAt(i);
  }
  // AudioSpecificConfig: 5 bits AOT, 4 bits frequency index, 4 bits channel
  // config (AOT is always <= 4 here, so the escape encodings never apply).
  const asc = new Uint8Array(2);
  asc[0] = (objectType << 3) | (freqIndex >> 1);
  asc[1] = ((freqIndex & 0x01) << 7) | (chanCfg << 3);
  return { sampleRate, numberOfChannels, audioSpecificConfig: asc, frames };
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
  // QUALITY (default) latency mode first: latencyMode 'realtime' was set
  // globally to suppress Safari VideoToolbox B-frames (whose out-of-order
  // chunks broke the muxer), but a realtime session is wall-clock PACED on
  // VideoToolbox — exports took roughly the content duration on iPhone.
  // Quality mode unlocks faster-than-realtime encoding; the render carries a
  // runtime guard that detects out-of-presentation-order (B-frame) chunks and
  // restarts the render once with this same config plus latencyMode
  // 'realtime' (see renderVideoWebCodecs), so encoders that DO reorder
  // (Safari) still produce a correct file while encoders that don't (Chrome)
  // keep the fast path.
  const base: VideoEncoderConfig = { codec: '', width, height, bitrate, framerate };

  const override = codecOverride();
  const candidates: VideoEncoderConfig[] = [];
  if (override) {
    candidates.push({ ...base, codec: override });
    candidates.push({ ...base, codec: override, latencyMode: 'realtime' });
  } else {
    // High profile; level derived from output size and source frame rate
    // (e.g. 5.1 covers 2160x3840@30, 5.2 is required above 30fps at 4K).
    const codecFor = (fps: number) =>
      `avc1.6400${avcLevelFor(width, height, fps).toString(16).padStart(2, '0').toUpperCase()}`;
    const avc = { avc: { format: 'avc' as const } };
    // Prefer real hardware; accept the platform's native software encoder as a
    // second choice (still native code, far faster than wasm x264). A
    // conservative rung (30fps envelope, level for 30) covers hardware that
    // rejects the higher level despite claiming support. Each shape is tried
    // in quality mode first, then the whole ladder repeats with latencyMode
    // 'realtime' for platforms whose encoder only preflights in realtime.
    const shapes: VideoEncoderConfig[] = [
      { ...base, codec: codecFor(framerate), hardwareAcceleration: 'prefer-hardware', ...avc },
      { ...base, codec: codecFor(framerate), hardwareAcceleration: 'no-preference', ...avc },
    ];
    if (framerate > 30) {
      shapes.push({ ...base, framerate: 30, codec: codecFor(30), hardwareAcceleration: 'prefer-hardware', ...avc });
    }
    candidates.push(...shapes);
    candidates.push(...shapes.map((shape) => ({ ...shape, latencyMode: 'realtime' as const })));
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
        exportLog(
          `encoder preflight OK: ${config.codec} ${config.hardwareAcceleration ?? 'default'} ` +
          `@${config.framerate}fps latency=${config.latencyMode ?? 'quality'}`,
        );
        return { config, muxerCodec };
      }
      exportLog(`encoder preflight failed: ${config.codec} ${config.hardwareAcceleration ?? 'default'} latency=${config.latencyMode ?? 'quality'}`);
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
  /** timestamp of the last encoder chunk fed to the muxer (reorder guard) */
  lastMuxTs: number;
  frames: number;
  error: unknown;
  lastActivity: number;
}

const abortError = () => new DOMException('Export cancelled', 'AbortError');

/**
 * Thrown (via state.error) when the encoder emits chunks whose timestamps go
 * backwards — i.e. it reorders frames with B-frames (Safari VideoToolbox in
 * quality latency mode). WebCodecs delivers chunks in decode order, so with
 * strictly-increasing input pts a backwards timestamp can ONLY mean B-frame
 * reordering, which mp4-muxer's monotonic addVideoChunkRaw feed cannot
 * represent without dts/ctts bookkeeping WebCodecs gives us no dts for.
 * renderVideoWebCodecs catches this and restarts the render once with
 * latencyMode 'realtime', which disables B-frames.
 */
export class ReorderedChunksError extends Error {
  readonly reorderedChunks = true;
  constructor(previousUs: number, currentUs: number) {
    super(`encoder emitted out-of-order (B-frame) chunks: ${currentUs}us after ${previousUs}us`);
  }
}

const isReorderedChunksError = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { reorderedChunks?: boolean }).reorderedChunks === true;

/**
 * Scale/crop a decoded frame to the output size, preferring a single
 * GPU-accelerated createImageBitmap crop+resize over the 2D-canvas draw +
 * readback that dominated per-frame cost on phones (a 1080p->4K upscale
 * through a 33MP canvas ran at single-digit fps on iPhone). Falls back to the
 * canvas path permanently on the first failure (older engines lack resize
 * options).
 */
let bitmapResizeBroken = false;

// Test-only escape hatch mirroring ?wcodec=: ?scaler=webgl skips the
// createImageBitmap rung for that page load so the e2e suite can prove the
// WebGL rung specifically. Per-page-load query param only; persistent state
// is deliberately NOT honored so the override cannot linger for real users.
let scalerOverrideValue: string | null | undefined;

/**
 * Inject the scaler override explicitly. The render worker has no access to
 * the page URL (its `location` is the worker script URL), so the main thread
 * reads ?scaler= and passes it along in the start message.
 */
export function setScalerOverride(value: string | null): void {
  scalerOverrideValue = value;
}

function scalerOverride(): string | null {
  if (scalerOverrideValue !== undefined) return scalerOverrideValue;
  try {
    return new URLSearchParams(window.location.search).get('scaler');
  } catch {
    return null;
  }
}

/**
 * WebGL scaler state: one lazily-created OffscreenCanvas with a textured-quad
 * program, reused across every frame of a render. Freed by
 * releaseFrameScaler() (called from the render loop's finally). The GPU
 * texture upload of a VideoFrame + draw replaces the 33-megapixel 2D-canvas
 * draw + readback that made 4K exports crawl on engines without
 * createImageBitmap resize options (iPhone Safari).
 */
interface GlScaler {
  canvas: OffscreenCanvas;
  gl: WebGLRenderingContext;
  texBuf: WebGLBuffer;
}
let glScaler: GlScaler | null = null;
// Permanent (per session) flag: any WebGL failure — context creation, shader
// compile, texture upload, VideoFrame construction — disables the rung so the
// export falls through to the 2D canvas path instead of failing per frame.
let glScalerBroken = false;
// Log once per render which scaler rung engaged (reset by releaseFrameScaler).
let loggedScaler: string | null = null;
function logScaler(name: 'bitmap-resize' | 'webgl' | 'canvas2d') {
  if (loggedScaler !== name) {
    loggedScaler = name;
    exportLog(`scaler: ${name}`);
  }
}

function getGlScaler(W: number, H: number): GlScaler | null {
  if (glScalerBroken) return null;
  if (glScaler && glScaler.canvas.width === W && glScaler.canvas.height === H) return glScaler;
  if (glScaler) releaseFrameScaler();
  try {
    const canvas = new OffscreenCanvas(W, H);
    const attrs: WebGLContextAttributes = {
      premultipliedAlpha: false,
      // Honored where supported; harmless elsewhere.
      desynchronized: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    };
    const gl = (canvas.getContext('webgl2', attrs) ??
      canvas.getContext('webgl', attrs)) as WebGLRenderingContext | null;
    if (!gl) throw new Error('webgl context unavailable');
    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('createShader failed');
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error('createProgram failed');
    gl.attachShader(program, compile(gl.VERTEX_SHADER,
      'attribute vec2 a_pos;attribute vec2 a_tex;varying vec2 v_tex;' +
      'void main(){gl_Position=vec4(a_pos,0.,1.);v_tex=a_tex;}'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
      'precision mediump float;varying vec2 v_tex;uniform sampler2D u_tex;' +
      'void main(){gl_FragColor=texture2D(u_tex,v_tex);}'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);
    // Static full-viewport quad (triangle strip): BL, BR, TL, TR.
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    // Dynamic texcoord buffer: rewritten per frame with the cover-crop rect.
    const texBuf = gl.createBuffer();
    if (!texBuf) throw new Error('createBuffer failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(8), gl.DYNAMIC_DRAW);
    const aTex = gl.getAttribLocation(program, 'a_tex');
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.viewport(0, 0, W, H);
    glScaler = { canvas, gl, texBuf };
    return glScaler;
  } catch (error) {
    glScalerBroken = true;
    exportLog(`webgl scaler unavailable (${error instanceof Error ? error.message : error}); using canvas scaling`);
    return null;
  }
}

/**
 * Free WebGL scaler resources at the end of a render. Called from the render
 * loop's finally; also resets the per-render "scaler: ..." log latch. The
 * broken flags persist for the session by design.
 */
export function releaseFrameScaler(): void {
  loggedScaler = null;
  if (glScaler) {
    try {
      glScaler.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* context already lost */ }
    glScaler = null;
  }
}

/** Scale/crop via the WebGL quad; null means fall through to 2D canvas. */
function scaleFrameGl(
  frame: VideoFrame,
  timestamp: number,
  duration: number,
  W: number,
  H: number,
): VideoFrame | null {
  const s = getGlScaler(W, H);
  if (!s) return null;
  try {
    const { gl } = s;
    const vw = frame.displayWidth;
    const vh = frame.displayHeight;
    // Same cover-crop math as the bitmap rung, expressed as texcoords.
    const scale = Math.max(W / vw, H / vh);
    const sw = Math.min(vw, Math.round(W / scale));
    const sh = Math.min(vh, Math.round(H / scale));
    const sx = Math.floor((vw - sw) / 2);
    const sy = Math.floor((vh - sh) / 2);
    // No UNPACK_FLIP_Y_WEBGL: the uploaded image keeps its top row at v=0, so
    // top-of-crop texcoords go on the TOP (y=+1) vertices — the flipped-v quad
    // renders upright (verified programmatically by the e2e orientation check).
    const u0 = sx / vw;
    const u1 = (sx + sw) / vw;
    const vTop = sy / vh;
    const vBot = (sy + sh) / vh;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame as unknown as TexImageSource);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      u0, vBot, u1, vBot, // bottom vertices sample bottom of crop
      u0, vTop, u1, vTop, // top vertices sample top of crop
    ]), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
      throw new Error('gl error during frame scale');
    }
    return new VideoFrame(s.canvas, { timestamp, duration });
  } catch (error) {
    glScalerBroken = true;
    exportLog(`webgl scaler failed (${error instanceof Error ? error.message : error}); using canvas scaling`);
    releaseFrameScaler();
    return null;
  }
}

async function scaleFrame(
  frame: VideoFrame,
  timestamp: number,
  duration: number,
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
): Promise<VideoFrame> {
  const vw = frame.displayWidth;
  const vh = frame.displayHeight;
  const W = canvas.width;
  const H = canvas.height;
  const skipBitmapForTest = scalerOverride() === 'webgl';
  if (!skipBitmapForTest && !bitmapResizeBroken && typeof createImageBitmap === 'function') {
    try {
      // Cover semantics: crop the centered source rect whose aspect matches
      // the output, then resize — one GPU op instead of draw + readback.
      const scale = Math.max(W / vw, H / vh);
      const sw = Math.min(vw, Math.round(W / scale));
      const sh = Math.min(vh, Math.round(H / scale));
      const sx = Math.floor((vw - sw) / 2);
      const sy = Math.floor((vh - sh) / 2);
      const bitmap = await createImageBitmap(frame, sx, sy, sw, sh, {
        resizeWidth: W,
        resizeHeight: H,
        resizeQuality: 'medium',
      });
      try {
        if (bitmap.width === W && bitmap.height === H) {
          logScaler('bitmap-resize');
          return new VideoFrame(bitmap, { timestamp, duration });
        }
        // Engine ignored the resize options — fall through to canvas.
        bitmapResizeBroken = true;
        exportLog('bitmap resize unsupported (size mismatch); using canvas scaling');
      } finally {
        bitmap.close();
      }
    } catch {
      bitmapResizeBroken = true;
      exportLog('bitmap resize failed; using canvas scaling');
    }
  }
  // Middle rung: WebGL textured-quad scale (GPU, no 33MP 2D readback).
  const glFrame = scaleFrameGl(frame, timestamp, duration, W, H);
  if (glFrame) {
    logScaler('webgl');
    return glFrame;
  }
  logScaler('canvas2d');
  drawCover(ctx, frame, vw, vh, W, H);
  return new VideoFrame(canvas, { timestamp, duration });
}

function drawCover(
  ctx: OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  vw: number,
  vh: number,
  width: number,
  height: number,
) {
  // Same semantics as the wasm filter chain:
  // scale=W:H:force_original_aspect_ratio=increase + centered crop.
  if (!vw || !vh) throw new Error('source has no dimensions');
  const scale = Math.max(width / vw, height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

/**
 * Wait until `isDone()` (typically "queue drained below the watermark").
 * Where the codec supports the WebCodecs 'dequeue' event, waits on that event
 * (fired whenever [en/de]codeQueueSize decreases) with only a slow safety
 * poll for abort/error responsiveness; otherwise falls back to 40ms polling.
 */
function waitForDequeue(
  codec: VideoEncoder | VideoDecoder,
  isDone: () => boolean,
  state: RenderState,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = codec as unknown as {
      addEventListener?: (type: string, cb: () => void) => void;
      removeEventListener?: (type: string, cb: () => void) => void;
    };
    const useEvent = 'ondequeue' in codec && typeof target.addEventListener === 'function';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (useEvent) target.removeEventListener?.('dequeue', check);
    };
    const check = () => {
      if (timer !== undefined) clearTimeout(timer);
      state.lastActivity = Date.now();
      if (signal?.aborted) {
        cleanup();
        reject(abortError());
        return;
      }
      if (state.error || isDone()) {
        cleanup();
        resolve(); // state.error is rethrown by the caller's own checks
        return;
      }
      timer = setTimeout(check, useEvent ? 250 : 40);
    };
    if (useEvent) target.addEventListener?.('dequeue', check);
    check();
  });
}

function waitForQueueDrain(
  encoder: VideoEncoder,
  state: RenderState,
  signal?: AbortSignal,
): Promise<void> {
  return waitForDequeue(
    encoder,
    () => encoder.state !== 'configured' || encoder.encodeQueueSize <= 4,
    state,
    signal,
  );
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

async function captureClipViaElement(
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
  const diag = () =>
    `readyState=${video.readyState} network=${video.networkState} err=${video.error?.code ?? 'none'}`;
  try {
    video.src = url;
    video.load();
    // Wait only for METADATA (readyState >= 1). iOS Safari routinely parks a
    // paused, never-played video at HAVE_METADATA and does not decode a first
    // frame (so no `loadeddata`) until a play() or a seek kicks the pipeline —
    // waiting for loadeddata before the first seek was a structural deadlock
    // on iPhones ("clip decode timed out"). The first seekPresent below is the
    // kick, and its rVFC callback is the real "a frame exists" signal.
    // Event + poll belt-and-braces: events on freshly attached elements race.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`clip decode timed out (${diag()})`))),
        10_000,
      );
      const poll = setInterval(() => {
        if (signal?.aborted) return finish(() => reject(abortError()));
        if (state.error) return finish(() => reject(state.error instanceof Error ? state.error : new Error(String(state.error))));
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) finish(resolve);
      }, 100);
      video.onloadedmetadata = () => finish(resolve);
      video.onerror = () => finish(() => reject(new Error(`clip failed to decode (${diag()})`)));
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
    if (t === null) {
      // Muted play() nudge: some WebKit states only start the decode pipeline
      // for an element that has actually played. Play briefly, pause, re-seek.
      exportLog(`first seek presented nothing (${diag()}); trying play() nudge`);
      try { await video.play(); } catch { /* autoplay refusal — muted, unlikely */ }
      await new Promise<void>((resolve) => {
        const handle = video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
        const timer = setTimeout(() => { video.cancelVideoFrameCallback(handle); resolve(); }, 1000);
      });
      video.pause();
      t = await seekPresent(video, Math.max(0, clip.trimIn) + 0.001, 3000);
    }
    if (t === null) throw new Error(`could not present first frame (${diag()})`);

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
        drawCover(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height);
        // Explicit non-negative duration (see decoder path note).
        const frameDuration = Number.isFinite(minDelta) && minDelta > 0 ? Math.round(minDelta * 1_000_000) : 33_333;
        const frame = new VideoFrame(canvas, { timestamp: ts, duration: frameDuration });
        const keyFrame = state.frames === 0 || ts - state.lastKeyTs >= 2_000_000;
        if (keyFrame) state.lastKeyTs = ts;
        encoder.encode(frame, { keyFrame });
        frame.close();
        state.frames += 1;
        captured += 1;
        lastT = t;
        onSeconds(rel);
        if (encoder.encodeQueueSize > 8) await waitForQueueDrain(encoder, state, signal);
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
    video.onloadedmetadata = null;
    // Release the decoder promptly (matters on mobile).
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
    // Let the release actually start before anything else runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  state.offsetUs = base + Math.round(len * 1_000_000);
}

// ---------------------------------------------------------------------------
// Demuxer-based decode path (mp4box.js + VideoDecoder): no media elements.
// This is the deterministic primary path — iPhone Safari has repeatedly broken
// the element-based decode (paused seek-stepping) in ways rVFC cannot observe;
// demux + VideoDecoder involves no <video>, no seeks and no compositor.
// ---------------------------------------------------------------------------

/** Container codecs the decoder path knows how to configure. */
const DECODABLE_CODEC = /^(avc1|avc3|hvc1|hev1|vp09|av01)/;

/**
 * Cheap pre-demux gate: MP4 container (recorder MIME or blob type) and a
 * VideoDecoder implementation. WebM sources and decoder-less engines use the
 * element path. The per-track codec check happens after demux.
 */
export function decoderPathEligible(clip: Clip, blob: Blob): boolean {
  const type = clip.mimeType || blob.type || '';
  return type.includes('mp4') && typeof VideoDecoder !== 'undefined';
}

interface DemuxedClip {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  /** true when the source is fragmented MP4 (moof/trun — Safari MediaRecorder) */
  fragmented: boolean;
  /** timescale-converted samples in DECODE order; data copied out of mp4box */
  samples: Array<{ isSync: boolean; tsUs: number; durUs: number; data: Uint8Array }>;
}

/**
 * Derive keyframe-ness from the AVC/HEVC bitstream itself: walk the sample's
 * length-prefixed NAL units and look for an IDR (H.264 type 5) / IRAP (HEVC
 * types 16-23) slice. Container sync flags cannot be trusted in fragmented
 * MP4: trun/tfhd default sample flags routinely mark EVERY sample as sync
 * (observed with Safari MediaRecorder output), and feeding a delta frame to
 * VideoDecoder as type 'key' is an instant "Decoder failure". Returns null
 * when the bitstream is unparsable (caller falls back to the container flag).
 */
export function bitstreamIsSync(
  data: Uint8Array,
  lengthSize: number,
  kind: 'avc' | 'hevc',
): boolean | null {
  let offset = 0;
  let sawIdr: boolean | null = null;
  while (offset + lengthSize <= data.length) {
    let naluLength = 0;
    for (let i = 0; i < lengthSize; i++) naluLength = naluLength * 256 + data[offset + i];
    offset += lengthSize;
    if (naluLength <= 0 || offset + naluLength > data.length) return sawIdr;
    const nalType = kind === 'avc' ? data[offset] & 0x1f : (data[offset] >> 1) & 0x3f;
    if (kind === 'avc') {
      if (nalType === 5) return true; // IDR slice
      if (nalType >= 1 && nalType <= 4) sawIdr = false; // non-IDR slice/partition
    } else {
      if (nalType >= 16 && nalType <= 23) return true; // IRAP (BLA/IDR/CRA)
      if (nalType <= 9) sawIdr = false; // non-IRAP VCL slice
    }
    offset += naluLength;
  }
  return sawIdr;
}

/** NAL length-prefix size from the avcC/hvcC description (defaults to 4). */
export function naluLengthSize(description: Uint8Array | undefined, kind: 'avc' | 'hevc'): number {
  if (!description) return 4;
  // avcC: lengthSizeMinusOne lives in byte 4; hvcC: byte 21 (ISO 14496-15).
  const index = kind === 'avc' ? 4 : 21;
  if (description.length <= index) return 4;
  return (description[index] & 0x03) + 1;
}

/**
 * Extract the codec-specific DecoderConfig description for AVC/HEVC: the
 * avcC/hvcC box payload from the track's stsd entry, minus the 8-byte box
 * header. VP9/AV1 need no description (vpcC/av1C data travels in the codec
 * string / bitstream as far as VideoDecoder is concerned).
 */
function decoderDescription(file: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId) as unknown as {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: Array<Record<string, unknown>> } } } };
  };
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = (entry.avcC ?? entry.hvcC) as { write: (s: DataStream) => void } | undefined;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer as ArrayBuffer, 8); // strip box size+type header
  }
  return undefined;
}

/**
 * Demux the clip's MP4 with mp4box.js and return decode-ready samples for its
 * video track, or throw if the container/track/codec is unusable (the caller
 * falls back to the element path). The blob is appended in ~8MB chunks with
 * correct fileStart offsets; sample payloads are copied out and the originals
 * released batch-by-batch so mp4box never holds the whole mdat.
 */
export async function demuxClip(blob: Blob, signal?: AbortSignal): Promise<DemuxedClip> {
  const file = createFile();
  let movie: Movie | null = null;
  let demuxError: string | null = null;
  let track: Track | null = null;
  const samples: DemuxedClip['samples'] = [];

  file.onError = (module: string, message: string) => {
    demuxError = `${module}: ${message}`;
  };
  file.onReady = (info: Movie) => {
    movie = info;
    // Extraction must be armed synchronously inside onReady: mp4box (v2) does
    // not re-deliver samples parsed from buffers appended before extraction
    // was configured, and onReady fires mid-appendBuffer.
    const found = info.videoTracks?.[0];
    if (!found) {
      demuxError = 'mp4 has no video track';
      return;
    }
    if (!DECODABLE_CODEC.test(found.codec)) {
      demuxError = `unsupported track codec for decoder path: ${found.codec}`;
      return;
    }
    track = found;
    file.setExtractionOptions(found.id, null, { nbSamples: 100 });
    file.start();
  };
  let fragmented = false;
  file.onSamples = (id: number, _user: unknown, batch: Sample[]) => {
    // Copy the whole batch into ONE contiguous buffer (each sample becomes a
    // subarray view) instead of one .slice() allocation per sample: same
    // memory bound (exactly the payload bytes are retained, mp4box's buffers
    // are still released below), far less allocator churn on long clips.
    let batchBytes = 0;
    for (const sample of batch) if (sample.data) batchBytes += sample.data.byteLength;
    const block = new Uint8Array(batchBytes);
    let write = 0;
    for (const sample of batch) {
      if (!sample.data) continue;
      if (sample.moof_number !== undefined) fragmented = true;
      block.set(sample.data, write);
      samples.push({
        isSync: sample.is_sync,
        tsUs: Math.round((sample.cts * 1_000_000) / sample.timescale),
        durUs: Math.round((sample.duration * 1_000_000) / sample.timescale),
        data: block.subarray(write, write + sample.data.byteLength),
      });
      write += sample.data.byteLength;
    }
    // Memory discipline: hand the consumed batch's buffers back to mp4box.
    const last = batch[batch.length - 1];
    if (last) file.releaseUsedSamples(id, last.number);
  };

  const buffer = await blob.arrayBuffer();
  const CHUNK = 8 * 1024 * 1024;
  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK) {
    if (signal?.aborted) throw abortError();
    const end = Math.min(buffer.byteLength, offset + CHUNK);
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer.slice(offset, end), offset));
    if (demuxError) throw new Error(`mp4 demux failed (${demuxError})`);
    // Yield between chunks so a Cancel can interleave on big files.
    if (end < buffer.byteLength) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  file.flush();
  if (demuxError) throw new Error(`mp4 demux failed (${demuxError})`);
  // (callbacks above assign these; widen past TS's closure-blind narrowing)
  const readyTrack = track as Track | null;
  if (!movie || !readyTrack) throw new Error('mp4 demux produced no movie metadata');
  if (!samples.length) throw new Error('mp4 demux produced no video samples');

  const isMoofBacked = (file as unknown as { moofs?: unknown[] }).moofs;
  if (Array.isArray(isMoofBacked) && isMoofBacked.length > 0) fragmented = true;
  const description = decoderDescription(file, readyTrack.id);
  const codec = readyTrack.codec;

  // Defensive sync flags: in fragmented MP4 the container's is_sync comes from
  // trun/tfhd default flags and is frequently wrong (all-sync). For AVC/HEVC
  // the bitstream itself is authoritative — inspect each sample's NAL units
  // and only fall back to the container flag when parsing fails.
  const kind: 'avc' | 'hevc' | null =
    /^(avc1|avc3)/.test(codec) ? 'avc' : /^(hvc1|hev1)/.test(codec) ? 'hevc' : null;
  let syncFixes = 0;
  if (kind) {
    const lengthSize = naluLengthSize(description, kind);
    for (const sample of samples) {
      const derived = bitstreamIsSync(sample.data, lengthSize, kind);
      if (derived !== null && derived !== sample.isSync) {
        sample.isSync = derived;
        syncFixes += 1;
      }
    }
  }

  const syncCount = samples.reduce((n, s) => n + (s.isSync ? 1 : 0), 0);
  exportLog(
    `demux: codec=${codec} ${readyTrack.video?.width ?? readyTrack.track_width}x${
      readyTrack.video?.height ?? readyTrack.track_height
    } samples=${samples.length} sync=${syncCount}${syncFixes ? ` (container flags corrected on ${syncFixes})` : ''} frag=${
      fragmented ? 'yes' : 'no'
    } desc=${description ? `${description.byteLength}B` : 'none'}`,
  );

  const demuxed: DemuxedClip = {
    codec,
    codedWidth: readyTrack.video?.width ?? readyTrack.track_width,
    codedHeight: readyTrack.video?.height ?? readyTrack.track_height,
    description,
    fragmented,
    samples,
  };
  file.stop();
  return demuxed;
}

/**
 * Lightweight MP4 header probe via mp4box (pure JS, no ffmpeg): reports
 * whether the file has an audio track, its video frame rate, and the first
 * video track's codec string + encoded (pre-rotation) dimensions — the latter
 * feed the multi-clip "-c copy" uniformity check, so one parse per blob serves
 * both the encoder-planning and copy-path needs. Replaces the
 * former per-clip ffmpeg `-i` probe on the export critical path — that probe
 * required the whole ffmpeg wasm module to be loaded and each blob written to
 * MEMFS before the render could start (2-4s of dead time at 0% progress).
 * Returns null when the blob is not parsable MP4 (e.g. WebM); the caller
 * falls back to the ffmpeg probe for those.
 *
 * Non-fragmented files stop parsing right after moov (sample counts live in
 * stbl); fragmented files (Safari MediaRecorder) are appended fully so moof
 * sample counts accumulate — still pure in-memory JS, far cheaper than the
 * ffmpeg round-trip.
 */
export async function probeMp4Blob(
  blob: Blob,
  signal?: AbortSignal,
): Promise<{
  hasAudio: boolean;
  fps: number | null;
  codec: string | null;
  codedWidth: number | null;
  codedHeight: number | null;
  /** tkhd display/rotation matrix of the first video track (9 fixed-point values). */
  matrix: number[] | null;
} | null> {
  // Non-MP4 input (e.g. a WebM blob) makes mp4box's BoxParser call
  // Log.error("BoxParser", "Invalid box type...") WITHOUT an isofile, which
  // bypasses onError and prints straight to console.error before we return
  // null. Console-error-sensitive gates (the e2e suites fail the run on any
  // console error) must not trip on that expected fallback, so route
  // Log.error through onError-or-silence for the duration of the parse.
  const originalLogError = Log.error;
  Log.error = ((module: string, msg: string, isofile?: { onError?: (m: string, s: string) => void }) => {
    isofile?.onError?.(module, msg);
  }) as typeof Log.error;
  try {
    const file = createFile();
    let ready: Movie | null = null;
    let failed = false;
    file.onError = () => { failed = true; };
    file.onReady = (info: Movie) => { ready = info; };
    const buffer = await blob.arrayBuffer();
    const CHUNK = 8 * 1024 * 1024;
    for (let offset = 0; offset < buffer.byteLength; offset += CHUNK) {
      if (signal?.aborted) throw abortError();
      const end = Math.min(buffer.byteLength, offset + CHUNK);
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer.slice(offset, end), offset));
      if (failed) return null;
      const readyInfo = ready as Movie | null;
      if (readyInfo && !readyInfo.isFragmented && (readyInfo.videoTracks?.[0]?.nb_samples ?? 0) > 0) {
        break; // moov parsed and sample table present — nothing more needed
      }
      if (end < buffer.byteLength) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    file.flush();
    if (failed || !ready) return null;
    // Re-read the info so fragmented files include every parsed moof's samples.
    const info = file.getInfo() ?? (ready as Movie);
    const hasAudio = (info.audioTracks?.length ?? 0) > 0;
    let fps: number | null = null;
    const video = info.videoTracks?.[0];
    if (video && video.timescale > 0) {
      const durationSec = (video.samples_duration || video.duration || 0) / video.timescale;
      if (durationSec > 0 && video.nb_samples > 0) {
        const value = video.nb_samples / durationSec;
        if (Number.isFinite(value) && value >= 1 && value <= 240) fps = value;
      }
    }
    const codec = video?.codec ?? null;
    const codedWidth = video?.video?.width ?? video?.track_width ?? null;
    const codedHeight = video?.video?.height ?? video?.track_height ?? null;
    const matrix = video?.matrix ? Array.from(video.matrix as ArrayLike<number>) : null;
    file.stop();
    return { hasAudio, fps, codec, codedWidth, codedHeight, matrix };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return null;
  } finally {
    Log.error = originalLogError;
  }
}

/** Abortable/error-aware short sleep used by decoder backpressure waits. */
function decoderTick(state: RenderState, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    if (state.error) return reject(state.error instanceof Error ? state.error : new Error(String(state.error)));
    setTimeout(() => {
      state.lastActivity = Date.now();
      if (signal?.aborted) reject(abortError());
      else if (state.error) reject(state.error instanceof Error ? state.error : new Error(String(state.error)));
      else resolve();
    }, 10);
  });
}

/**
 * PRIMARY capture path: demux the clip with mp4box.js, decode its samples with
 * VideoDecoder, cover-crop each kept frame onto the shared canvas and hand it
 * to the encoder. No media elements are involved, so none of the iOS <video>
 * lifecycle pathologies apply. Timestamp semantics are identical to the
 * element path: the first kept frame anchors the clip (rel + state.offsetUs),
 * with the same strictly-increasing clamp, preserving VFR timing exactly.
 *
 * Trim: decoding starts at the last sync sample at/before trimIn; decoded
 * frames before trimIn are closed immediately, frames in [trimIn, trimOut)
 * are kept, and feeding stops at the first sample cts >= trimOut.
 */
export async function captureClipViaDecoder(
  clip: Clip,
  blob: Blob,
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  encoder: VideoEncoder,
  state: RenderState,
  onSeconds: (s: number) => void,
  signal?: AbortSignal,
  predemuxed?: Promise<DemuxedClip>,
): Promise<void> {
  const demuxed = await (predemuxed ?? demuxClip(blob, signal));
  if (signal?.aborted) throw abortError();
  // Some muxers (Chromium's MediaRecorder among them) write vpcC level 0,
  // yielding a codec string like "vp09.00.00.08" that VideoDecoder's parser
  // rejects — level 00 is not a defined VP9 level. Offer a normalized
  // candidate with a generous level (5.1 covers 4K@60) as a fallback; the
  // level only advertises capability, decoders accept content below it.
  // AVC/HEVC always use the track's EXACT codec string from stsd
  // (avc1.PPCCLL); only the malformed-level vp09 case gets a normalized
  // second candidate, and the exact string is still tried first.
  const codecCandidates = [demuxed.codec];
  const vp9BadLevel = demuxed.codec.match(/^vp09\.(\d{2})\.00\.(.+)$/);
  if (vp9BadLevel) codecCandidates.push(`vp09.${vp9BadLevel[1]}.51.${vp9BadLevel[2]}`);
  let codec: string | null = null;
  for (const candidate of codecCandidates) {
    try {
      const support = await VideoDecoder.isConfigSupported({
        codec: candidate,
        description: demuxed.description,
        codedWidth: demuxed.codedWidth,
        codedHeight: demuxed.codedHeight,
      });
      if (support.supported) { codec = candidate; break; }
    } catch { /* malformed codec string — try the next candidate */ }
  }
  if (!codec) throw new Error(`VideoDecoder rejects ${codecCandidates.join(', ')}`);
  demuxed.codec = codec;

  const len = clipLen(clip);
  const base = state.offsetUs;
  const trimInUs = Math.round(clip.trimIn * 1_000_000);
  const trimOutUs = Math.round(clip.trimOut * 1_000_000);

  // Decode must start on a sync sample: last keyframe at/before trimIn.
  let startIndex = 0;
  for (let i = 0; i < demuxed.samples.length; i++) {
    if (demuxed.samples[i].isSync && demuxed.samples[i].tsUs <= trimInUs) startIndex = i;
  }

  let captured = 0;
  let fed = 0;
  let decodedOut = 0;
  let firstT = -1; // clip-local anchor, seconds (first KEPT frame)
  const pending: VideoFrame[] = [];
  let decodeFailure: unknown = null;
  // Field-diagnosable failure text: the export sheet's Technical details must
  // pinpoint the stage, not just Safari's generic "Decoder failure".
  const failureContext = () =>
    `codec=${demuxed.codec}, fed=${fed} chunks, out=${decodedOut} frames, kept=${captured}, frag=${demuxed.fragmented ? 'yes' : 'no'}`;
  const decoder = new VideoDecoder({
    output: (frame) => {
      state.lastActivity = Date.now();
      decodedOut += 1;
      // Trim in decoder output: pre-trimIn frames close immediately, and
      // anything at/after trimOut (decode-order stragglers) closes too.
      if (frame.timestamp < trimInUs || frame.timestamp >= trimOutUs) {
        frame.close();
        return;
      }
      pending.push(frame);
    },
    error: (error) => {
      decodeFailure = error;
    },
  });

  const throwIfBroken = () => {
    if (signal?.aborted) throw abortError();
    if (decodeFailure) {
      const message = decodeFailure instanceof Error ? decodeFailure.message : String(decodeFailure);
      throw new Error(`decoder failure (${message}; ${failureContext()})`);
    }
    if (state.error) throw state.error instanceof Error ? state.error : new Error(String(state.error));
  };

  // Draw + encode one decoded frame, then close it promptly.
  const consume = async (frame: VideoFrame) => {
    try {
      const t = frame.timestamp / 1_000_000;
      if (firstT < 0) firstT = t;
      const rel = Math.min(len, Math.max(0, t - firstT));
      let ts = base + Math.round(rel * 1_000_000);
      if (ts <= state.lastTs) ts = state.lastTs + 1_000; // strictly increasing for the muxer
      state.lastTs = ts;
      // Explicit non-negative duration: the encoder propagates it to the
      // chunk, so the muxer never derives one from timestamp deltas.
      const duration = frame.duration && frame.duration > 0 ? frame.duration : 33_333;
      let out: VideoFrame;
      if (frame.displayWidth === canvas.width && frame.displayHeight === canvas.height) {
        // Dimensions already match the output (e.g. true 4K capture exported
        // at 4K): wrap the decoded frame with new timing instead of the
        // 33-megapixel canvas draw + readback — a zero-copy retimestamp that
        // roughly halves per-frame cost on the dominant path.
        out = new VideoFrame(frame, { timestamp: ts, duration });
      } else {
        out = await scaleFrame(frame, ts, duration, canvas, ctx);
      }
      const keyFrame = state.frames === 0 || ts - state.lastKeyTs >= 2_000_000;
      if (keyFrame) state.lastKeyTs = ts;
      encoder.encode(out, { keyFrame });
      out.close();
      state.frames += 1;
      captured += 1;
      onSeconds(rel);
    } finally {
      frame.close();
    }
    if (encoder.encodeQueueSize > 8) await waitForQueueDrain(encoder, state, signal);
  };

  try {
    // optimizeForLatency deliberately NOT set: it instructs the decoder to
    // suppress output reordering, which misbehaves on sources that do carry
    // B-frames (imports); our backpressure already bounds the queue, and the
    // flush loop consumes any frames a conservative decoder holds back.
    decoder.configure({
      codec: demuxed.codec,
      description: demuxed.description,
      codedWidth: demuxed.codedWidth,
      codedHeight: demuxed.codedHeight,
    });

    // Feed in DECODE order (mp4box extraction order), never cts-sorted.
    for (let i = startIndex; i < demuxed.samples.length; i++) {
      const sample = demuxed.samples[i];
      if (sample.tsUs >= trimOutUs) break; // stop feeding past trimOut
      throwIfBroken();
      state.lastActivity = Date.now();
      decoder.decode(new EncodedVideoChunk({
        // First fed chunk is always 'key': feeding starts at a sync sample by
        // construction, and a first chunk typed 'delta' (possible when fMP4
        // sync flags are broken AND bitstream inspection failed) is an
        // immediate decoder error on every engine.
        type: fed === 0 || sample.isSync ? 'key' : 'delta',
        timestamp: sample.tsUs,
        duration: sample.durUs,
        data: sample.data,
      }));
      fed += 1;
      // Backpressure: bounded decode queue and bounded pool of live frames.
      while (pending.length > 0 && (pending.length > 4 || decoder.decodeQueueSize > 8)) {
        await consume(pending.shift()!);
      }
      if (decoder.decodeQueueSize > 8 && pending.length === 0) {
        await waitForDequeue(
          decoder,
          () =>
            decoder.state !== 'configured' ||
            decoder.decodeQueueSize <= 8 ||
            pending.length > 0 ||
            decodeFailure !== null,
          state,
          signal,
        );
        throwIfBroken();
      }
    }
    // Abort-aware flush: keep consuming frames as they surface, and let an
    // abort or a decoder/encoder error interrupt the wait (Cancel stays
    // instant even mid-flush).
    let flushDone = false;
    let flushError: unknown = null;
    decoder.flush().then(
      () => { flushDone = true; },
      (error) => { flushError = error; flushDone = true; },
    );
    while (!flushDone) {
      while (pending.length > 0) await consume(pending.shift()!);
      await decoderTick(state, signal);
    }
    throwIfBroken();
    if (flushError) {
      const message = flushError instanceof Error ? flushError.message : String(flushError);
      throw new Error(`decoder flush failed (${message}; ${failureContext()})`);
    }
    while (pending.length > 0) await consume(pending.shift()!);
  } finally {
    for (const frame of pending.splice(0)) frame.close();
    try {
      if (decoder.state !== 'closed') decoder.close();
    } catch { /* already closed */ }
  }
  if (!captured) throw new Error('decoder path captured no frames from clip');
  exportLog(`decoder path captured ${captured} frames (${len.toFixed(2)}s clip, ${demuxed.codec})`);
  state.offsetUs = base + Math.round(len * 1_000_000);
}

/**
 * Render all clips to an MP4 (bytes) using the given encoder plan. When
 * `getAudio` is provided, its ADTS-parsed AAC frames are muxed directly into
 * the same file (awaited only after the video is fully encoded, so the ffmpeg
 * audio pipeline runs concurrently with the render) and the output is the
 * FINAL faststart MP4 — no ffmpeg remux follows. Without `getAudio` the output
 * is video-only, as before.
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
  getAudio?: () => Promise<AdtsAudio>,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError();
  try {
    return await renderVideoWithElementRestart(clips, blobs, width, height, plan, getAudio, onProgress, signal);
  } catch (error) {
    // B-frame safety net: the encoder plan prefers quality latency mode
    // (faster than realtime on hardware), but an encoder that reorders
    // output (B-frames — Safari VideoToolbox) cannot feed the monotonic
    // muxer. Restart the whole render ONCE with the same config in realtime
    // latency mode, which disables B-frames — the known-good former behavior.
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    if (!isReorderedChunksError(error) || plan.config.latencyMode === 'realtime') throw error;
    exportLog('render restart: realtime encoder config after out-of-order (B-frame) chunks');
    const realtimePlan: WebCodecsPlan = {
      ...plan,
      config: { ...plan.config, latencyMode: 'realtime' },
    };
    return await renderVideoWithElementRestart(clips, blobs, width, height, realtimePlan, getAudio, onProgress, signal);
  }
}

async function renderVideoWithElementRestart(
  clips: Clip[],
  blobs: Blob[],
  width: number,
  height: number,
  plan: WebCodecsPlan,
  getAudio?: () => Promise<AdtsAudio>,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let attemptUsedDecoder = false;
  try {
    return await renderVideoAttempt(clips, blobs, width, height, plan, true,
      (used) => { attemptUsedDecoder = used; }, getAudio, onProgress, signal);
  } catch (error) {
    // Full-render safety net: a decoder-path death AFTER frames reached the
    // muxer cannot be retried per-clip (duplicate frames), so restart the
    // whole render once — fresh muxer, encoder and state — with the decoder
    // path disabled, giving the element path a genuine shot before the caller
    // falls back to wasm (which 4K mobile cannot survive). Aborts, encoder
    // reorder errors (handled by the caller with a realtime config restart)
    // and renders that never touched the decoder path propagate unchanged.
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    if (isReorderedChunksError(error)) throw error;
    if (!attemptUsedDecoder) throw error;
    exportLog(`render restart: element-only after decoder failure (${error instanceof Error ? error.message : error})`);
    return await renderVideoAttempt(clips, blobs, width, height, plan, false, () => {}, getAudio, onProgress, signal);
  }
}

async function renderVideoAttempt(
  clips: Clip[],
  blobs: Blob[],
  width: number,
  height: number,
  plan: WebCodecsPlan,
  allowDecoderPath: boolean,
  onDecoderUsed: (used: boolean) => void,
  getAudio?: () => Promise<AdtsAudio>,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError();
  const total = clips.reduce((s, c) => s + clipLen(c), 0) || 1;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: plan.muxerCodec, width, height },
    // When audio is muxed here the output IS the delivered file, so it must be
    // faststart itself: 'in-memory' buffers samples (they were headed for one
    // ArrayBuffer anyway) and writes moov before mdat at finalize. Audio-less
    // (legacy) renders keep the cheap end-of-file moov; the ffmpeg remux that
    // consumed them applied +faststart.
    // Timestamps are anchored per clip (first captured frame = clip offset),
    // so the first sample lands at exactly 0 and no muxer-level offset — which
    // would shift video against the separately-encoded audio — is needed. The
    // AAC frames from parseAdts start at 0 on a gapless grid, matching how the
    // former remux laid out audio.m4a.
    fastStart: getAudio ? 'in-memory' : false,
    ...(getAudio
      ? { audio: { codec: 'aac' as const, sampleRate: 48000, numberOfChannels: 2 } }
      : {}),
  });

  const state: RenderState = {
    offsetUs: 0,
    lastTs: -1,
    lastKeyTs: 0,
    lastMuxTs: -1,
    frames: 0,
    error: null,
    lastActivity: Date.now(),
  };

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      state.lastActivity = Date.now();
      try {
        // Reorder guard: encoder output arrives in DECODE order, and input pts
        // are strictly increasing, so a backwards timestamp means the encoder
        // produced B-frames (Safari VideoToolbox in quality latency mode) —
        // which the monotonic muxer feed cannot represent. Surface a typed
        // error; renderVideoWebCodecs restarts once with latencyMode
        // 'realtime' (B-frames disabled).
        if (chunk.timestamp < state.lastMuxTs) {
          if (!state.error) state.error = new ReorderedChunksError(state.lastMuxTs, chunk.timestamp);
          return;
        }
        state.lastMuxTs = chunk.timestamp;
        // Feed the muxer through the raw API with a clamped duration: encoder
        // implementations (Safari) have emitted chunks whose absent/negative
        // duration aborts addVideoChunk. Timestamps are already strictly
        // increasing by construction.
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const duration = Number.isFinite(chunk.duration) && (chunk.duration as number) > 0
          ? (chunk.duration as number)
          : 33_333;
        muxer.addVideoChunkRaw(data, chunk.type as 'key' | 'delta', chunk.timestamp, duration, meta);
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

  // Each clip gets a FRESH <video> element, ATTACHED to the DOM (hidden but
  // not display:none): iOS Safari deprioritizes or outright refuses media
  // loading/decoding for detached elements, and skips decode for undisplayed
  // ones. A 2x2 transparent fixed-position element keeps the decoder honest
  // without being visible. Fresh-per-clip stays: reusing one element across
  // blob-src swaps starves iOS of decoder sessions (AVPlayer teardown is lazy).
  const makeVideo = () => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.style.cssText =
      'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(v);
    return v;
  };

  // Throttle progress to ~10 updates/sec: onSeconds fires per captured frame,
  // and pushing every frame through React state/DOM updates measurably taxes
  // the 2-core render loop. The final onProgress(1) below is unconditional.
  let lastProgressAt = 0;
  const throttledProgress = onProgress
    ? (p: number) => {
        const now = Date.now();
        if (now - lastProgressAt >= 100) {
          lastProgressAt = now;
          onProgress(p);
        }
      }
    : undefined;

  // One-ahead demux prefetch: clip N+1's demux (blob read + mp4box parse +
  // sample extraction) is CPU-light next to decode/encode, so it runs
  // concurrently while clip N occupies the codecs. Exactly ONE clip is
  // prefetched (bounded memory); the promise observes `signal`, and any
  // rejection is parked (no-op catch) until the owning clip awaits it — or
  // dropped entirely in the finally when the render aborts/fails.
  let prefetch: { index: number; promise: Promise<DemuxedClip> } | null = null;

  try {
    encoder.configure(plan.config);
    exportLog(`encoder latency mode: ${plan.config.latencyMode ?? 'quality'}`);
    for (let i = 0; i < clips.length; i++) {
      const done = clips.slice(0, i).reduce((s, c) => s + clipLen(c), 0);
      const progress = (s: number) => throttledProgress?.(Math.min(0.99, (done + s) / total));
      exportLog(`clip ${i + 1}/${clips.length}: decode+capture start`);
      if (
        allowDecoderPath &&
        i + 1 < clips.length &&
        (!prefetch || prefetch.index !== i + 1) &&
        decoderPathEligible(clips[i + 1], blobs[i + 1])
      ) {
        const promise = demuxClip(blobs[i + 1], signal);
        promise.catch(() => {}); // parked until awaited; never unhandled
        prefetch = { index: i + 1, promise };
      }
      const framesBefore = state.frames;
      // PRIMARY: demuxer-based decode (mp4box + VideoDecoder, no media
      // elements) for eligible MP4 clips. Fall back to the element path only
      // when the decoder path failed without contributing any frames — once
      // frames reached the muxer a rerun would duplicate them, so propagate.
      let captured = false;
      if (allowDecoderPath && decoderPathEligible(clips[i], blobs[i])) {
        onDecoderUsed(true);
        const predemuxed = prefetch?.index === i ? prefetch.promise : undefined;
        if (predemuxed) prefetch = null;
        try {
          await captureClipViaDecoder(clips[i], blobs[i], canvas, ctx, encoder, state, progress, signal, predemuxed);
          captured = true;
          exportLog(`clip ${i + 1}/${clips.length} mode=decoder`);
        } catch (error) {
          if (signal?.aborted || state.error || state.frames !== framesBefore) throw error;
          exportLog(`clip ${i + 1} decoder path failed (${error instanceof Error ? error.message : error}); falling back to element path`);
        }
      }
      if (!captured) {
        // In a worker there is no DOM: the element path cannot ever succeed,
        // so fail the worker attempt immediately instead of burning the
        // 400ms retry (the main thread falls back to an in-page render).
        if (typeof document === 'undefined') {
          throw new Error('element capture path unavailable in this context (no DOM)');
        }
        try {
          await captureClipViaElement(clips[i], blobs[i], makeVideo(), canvas, ctx, encoder, state, progress, signal);
        } catch (error) {
          // Retry only when the clip contributed nothing yet — a mid-clip retry
          // would re-encode frames already handed to the muxer.
          if (signal?.aborted || state.error || state.frames !== framesBefore) throw error;
          // One retry with another fresh element and a breather: transient
          // decoder-session exhaustion (iOS) recovers once the previous
          // element's release completes.
          exportLog(`clip ${i + 1} capture failed (${error instanceof Error ? error.message : error}); retrying once`);
          await new Promise((r) => setTimeout(r, 400));
          await captureClipViaElement(clips[i], blobs[i], makeVideo(), canvas, ctx, encoder, state, progress, signal);
        }
        exportLog(`clip ${i + 1}/${clips.length} mode=element`);
      }
      // Give iOS's lazy AVPlayer teardown a beat before opening the next
      // decoder session; without it, back-to-back sessions starve on phones.
      // Only needed when THIS clip went through a <video> element — the
      // demuxer path opens no AVPlayer-backed session, so pausing after
      // decoder-mode clips would only add dead time.
      if (!captured && i + 1 < clips.length) await new Promise((r) => setTimeout(r, 150));
    }
    await encoder.flush();
    if (signal?.aborted) throw abortError();
    if (state.error) throw state.error instanceof Error ? state.error : new Error(String(state.error));
    if (!state.frames) throw new Error('no frames encoded');
    if (getAudio) {
      // The audio pipeline has been running concurrently in the ffmpeg worker;
      // by the time the video is flushed it is normally already done.
      const audio = await getAudio();
      if (signal?.aborted) throw abortError();
      if (audio.sampleRate !== 48000 || audio.numberOfChannels !== 2) {
        // The ffmpeg audio chain normalizes to 48kHz stereo; anything else
        // means the pipeline changed and the declared track config is wrong.
        throw new Error(
          `unexpected AAC format ${audio.sampleRate}Hz/${audio.numberOfChannels}ch (expected 48000/2)`,
        );
      }
      const meta: EncodedAudioChunkMetadata = {
        decoderConfig: {
          codec: 'mp4a.40.2',
          sampleRate: audio.sampleRate,
          numberOfChannels: audio.numberOfChannels,
          description: audio.audioSpecificConfig,
        },
      };
      for (let i = 0; i < audio.frames.length; i++) {
        const f = audio.frames[i];
        // Every AAC frame is independently decodable — all 'key'. The esds
        // decoder description travels on the first chunk's metadata.
        muxer.addAudioChunkRaw(f.data, 'key', f.timestampUs, f.durationUs, i === 0 ? meta : undefined);
      }
      exportLog(`audio muxed directly: ${audio.frames.length} AAC frames @${audio.sampleRate}Hz`);
    }
    muxer.finalize();
  } finally {
    // Drop the prefetched demux so its samples are collectable immediately if
    // the render aborted or failed (its rejection is already parked above).
    prefetch = null;
    releaseFrameScaler();
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
