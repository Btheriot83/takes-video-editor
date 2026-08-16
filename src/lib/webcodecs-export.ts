import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import type { ISOFile, Movie, Sample, Track } from 'mp4box';
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
  // latencyMode 'realtime' disables B-frame reordering. Safari's VideoToolbox
  // H.264 encoder otherwise emits B-frames, whose out-of-presentation-order
  // chunks make mp4-muxer compute a NEGATIVE sample duration and abort
  // ("addVideoChunkRaw's fourth argument (duration) must be a non-negative
  // real number" — observed on iPhone). Chrome's encoder is realtime-biased
  // already, so this is behavior-neutral there.
  const base: VideoEncoderConfig = { codec: '', width, height, bitrate, framerate, latencyMode: 'realtime' };

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
    for (const sample of batch) {
      if (!sample.data) continue;
      if (sample.moof_number !== undefined) fragmented = true;
      samples.push({
        isSync: sample.is_sync,
        tsUs: Math.round((sample.cts * 1_000_000) / sample.timescale),
        durUs: Math.round((sample.duration * 1_000_000) / sample.timescale),
        data: sample.data.slice(), // copy: the original lives in mp4box's buffer
      });
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
): Promise<void> {
  const demuxed = await demuxClip(blob, signal);
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
      drawCover(ctx, frame, frame.displayWidth, frame.displayHeight, canvas.width, canvas.height);
      // Explicit non-negative duration: the encoder propagates it to the
      // chunk, so the muxer never derives one from timestamp deltas.
      const duration = frame.duration && frame.duration > 0 ? frame.duration : 33_333;
      const out = new VideoFrame(canvas, { timestamp: ts, duration });
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
    if (encoder.encodeQueueSize > 4) await waitForQueueDrain(encoder, state, signal);
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
      while (pending.length > 0 && (pending.length > 2 || decoder.decodeQueueSize > 4)) {
        await consume(pending.shift()!);
      }
      while (decoder.decodeQueueSize > 4 && pending.length === 0) {
        await decoderTick(state, signal);
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
  let attemptUsedDecoder = false;
  try {
    return await renderVideoAttempt(clips, blobs, width, height, plan, true,
      (used) => { attemptUsedDecoder = used; }, onProgress, signal);
  } catch (error) {
    // Full-render safety net: a decoder-path death AFTER frames reached the
    // muxer cannot be retried per-clip (duplicate frames), so restart the
    // whole render once — fresh muxer, encoder and state — with the decoder
    // path disabled, giving the element path a genuine shot before the caller
    // falls back to wasm (which 4K mobile cannot survive). Aborts and renders
    // that never touched the decoder path propagate unchanged.
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    if (!attemptUsedDecoder) throw error;
    exportLog(`render restart: element-only after decoder failure (${error instanceof Error ? error.message : error})`);
    return await renderVideoAttempt(clips, blobs, width, height, plan, false, () => {}, onProgress, signal);
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

  try {
    encoder.configure(plan.config);
    for (let i = 0; i < clips.length; i++) {
      const done = clips.slice(0, i).reduce((s, c) => s + clipLen(c), 0);
      const progress = (s: number) => onProgress?.(Math.min(0.99, (done + s) / total));
      exportLog(`clip ${i + 1}/${clips.length}: decode+capture start`);
      const framesBefore = state.frames;
      // PRIMARY: demuxer-based decode (mp4box + VideoDecoder, no media
      // elements) for eligible MP4 clips. Fall back to the element path only
      // when the decoder path failed without contributing any frames — once
      // frames reached the muxer a rerun would duplicate them, so propagate.
      let captured = false;
      if (allowDecoderPath && decoderPathEligible(clips[i], blobs[i])) {
        onDecoderUsed(true);
        try {
          await captureClipViaDecoder(clips[i], blobs[i], canvas, ctx, encoder, state, progress, signal);
          captured = true;
          exportLog(`clip ${i + 1}/${clips.length} mode=decoder`);
        } catch (error) {
          if (signal?.aborted || state.error || state.frames !== framesBefore) throw error;
          exportLog(`clip ${i + 1} decoder path failed (${error instanceof Error ? error.message : error}); falling back to element path`);
        }
      }
      if (!captured) {
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
