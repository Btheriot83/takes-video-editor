import { clipLen, exportDimensions } from '../types/clip';
import type { AspectRatio, Clip, ExportQuality } from '../types/clip';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { planWebCodecsEncode, renderVideoWebCodecs } from './webcodecs-export';

// We load @ffmpeg/ffmpeg's ESM build from same-origin static files
// (public/ffesm) instead of the vite-bundled worker: the bundled module
// worker path proved unreliable, while the static path is verified working.
type FFmpegLike = FFmpeg;
let ff: FFmpegLike | null = null;
let loading: Promise<FFmpegLike> | null = null;
/** Identity of the in-flight load; cleared by resetFFmpegModule so a stale
 * load that finishes after a cancel does not republish its instance. */
let loadToken: object | null = null;

/**
 * Multithreaded encoding needs SharedArrayBuffer, which browsers only enable
 * on cross-origin-isolated pages (COOP/COEP headers). When available it makes
 * 4K exports several times faster; otherwise we fall back to the
 * single-threaded core.
 */
// The pthread build currently deadlocks during real browser exports on some
// Chrome/WebAssembly combinations. Keep it available for explicit testing,
// but ship the proven single-threaded core until the mt path passes the same
// end-to-end export suite. Vite only exposes VITE_* values at build time.
const mtCoreEnabled = import.meta.env.VITE_ENABLE_FFMPEG_MT === 'true';

const canUseMtCore = () =>
  mtCoreEnabled &&
  typeof SharedArrayBuffer !== 'undefined' &&
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true &&
  (navigator.hardwareConcurrency ?? 1) > 1;

let usingMtCore = false;

/**
 * With the mt core, x264 must not be allowed to pick its own thread count:
 * Emscripten's pthread pool is finite and letting x264 spawn cores-worth of
 * threads (plus lookahead threads) deadlocks the encoder mid-stream. Two
 * encoder threads is a safe, still-faster-than-single configuration.
 */
const encoderThreadArgs = () => (usingMtCore ? ['-threads', '2'] : []);

/**
 * Drop the module singleton so the next export loads a fresh ffmpeg. Used
 * after terminate() (cancelled export): a terminated instance's worker is dead
 * and every later call on it would reject.
 */
function resetFFmpegModule() {
  ff = null;
  loading = null;
  loadToken = null;
  usingMtCore = false;
}

async function getFFmpeg(): Promise<FFmpegLike> {
  if (ff) return ff;
  if (!loading) {
    const token = {};
    loadToken = token;
    loading = (async () => {
      const u = (path: string) => new URL(path, document.baseURI).href;
      const mod = await import(/* @vite-ignore */ u('ffesm/index.js'));
      const inst = new mod.FFmpeg();
      inst.on('log', ({ message }: { message: string }) => console.log('[ffmpeg]', message));
      if (canUseMtCore()) {
        try {
          await inst.load({
            coreURL: u('ffmpeg-mt/ffmpeg-core.js'),
            wasmURL: u('ffmpeg-mt/ffmpeg-core.wasm'),
            workerURL: u('ffmpeg-mt/ffmpeg-core.worker.js'),
          });
          console.log('[ffmpeg] loaded multithreaded core');
          // A cancel may have reset the module while this load was in flight;
          // only publish the instance if this load is still the current one.
          if (loadToken === token) {
            usingMtCore = true;
            ff = inst;
          }
          return inst;
        } catch (error) {
          console.warn('[ffmpeg] mt core failed to load; using single-threaded core', error);
        }
      }
      await inst.load({
        coreURL: u('ffmpeg/ffmpeg-core.js'),
        wasmURL: u('ffmpeg/ffmpeg-core.wasm'),
      });
      if (loadToken === token) ff = inst;
      return inst;
    })();
  }
  return loading;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  seconds: number;
  mode: 'native' | 'remuxed' | 'transcoded';
}

const isUntrimmed = (clip: Clip) =>
  clip.trimIn <= 1 / 60 && Math.abs(clip.trimOut - clip.duration) <= 1 / 60;

interface InputProbe {
  hasAudio: boolean;
  fps: number | null;
}

/**
 * Probe each already-written MEMFS input with the loaded ffmpeg: `-i` with no
 * output exits nonzero but logs every stream, which tells us (a) whether the
 * input has an audio stream at all — MediaRecorder without a mic permission
 * and many imported screen captures have none, and unconditionally referencing
 * [i:a] in a filtergraph aborts with "Stream specifier ':a' matches no
 * streams" — and (b) the video frame rate, used to pick a conformant H.264
 * level.
 */
async function probeInputs(ffmpeg: FFmpegLike, names: string[]): Promise<InputProbe[]> {
  const probes: InputProbe[] = [];
  for (const name of names) {
    const lines: string[] = [];
    const onLog = ({ message }: { message: string }) => lines.push(message);
    ffmpeg.on('log', onLog);
    try {
      await ffmpeg.exec(['-hide_banner', '-i', name]);
    } catch {
      // exec without an output always "fails"; the stream log is what we want
    }
    ffmpeg.off('log', onLog);
    const hasAudio = lines.some((line) => /Stream #\d+:\d+.*: Audio/.test(line));
    let fps: number | null = null;
    for (const line of lines) {
      if (!/Stream #\d+:\d+.*: Video/.test(line)) continue;
      const m = line.match(/(\d+(?:\.\d+)?) fps/) ?? line.match(/(\d+(?:\.\d+)?) tbr/);
      const value = m ? Number(m[1]) : NaN;
      // tbn/tbc artifacts (e.g. "1k tbr") are not real frame rates.
      if (Number.isFinite(value) && value >= 1 && value <= 240) fps = value;
    }
    probes.push({ hasAudio, fps });
  }
  return probes;
}

/**
 * Per-clip audio chain for a filtergraph: the clip's real audio normalized to
 * 48kHz stereo and cut/padded to exactly `len` seconds — or, when the source
 * has no audio stream, the same duration of generated silence so audio-less
 * clips (and all-silent projects) still export a valid MP4 with an AAC track.
 */
function audioChain(index: number, len: number, hasAudio: boolean): string {
  if (!hasAudio) {
    return (
      `anullsrc=r=48000:cl=stereo,atrim=end=${len},asetpts=PTS-STARTPTS,` +
      `aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`
    );
  }
  return (
    `[${index}:a]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `asetpts=PTS-STARTPTS,atrim=end=${len},apad=whole_dur=${len}[a${index}]`
  );
}

const abortError = () => new DOMException('Export cancelled', 'AbortError');

/**
 * Export clips to MP4 at the selected output profile. A compatible source is
 * returned unchanged, compatible untrimmed sources are first offered to the
 * concat demuxer, and only the remaining cases enter the render pipeline.
 *
 * Aborting `signal` cancels the export: the frame capture loop stops, the
 * VideoEncoder is closed, a running wasm exec is terminated (and the module
 * singleton reset so the next export reloads cleanly), and the returned
 * promise rejects with a DOMException named 'AbortError'.
 */
export async function exportMp4(
  clips: Clip[],
  getBlob: (key: string) => Promise<Blob | undefined>,
  aspectRatio: AspectRatio,
  quality: ExportQuality,
  onProgress?: (phase: string, p: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const onAbort = () => {
    const inst = ff;
    resetFFmpegModule();
    try {
      inst?.terminate();
    } catch {
      // instance was not running
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await runExport(clips, getBlob, aspectRatio, quality, onProgress, signal);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function runExport(
  clips: Clip[],
  getBlob: (key: string) => Promise<Blob | undefined>,
  aspectRatio: AspectRatio,
  quality: ExportQuality,
  onProgress?: (phase: string, p: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  if (!clips.length) throw new Error('Nothing to export');
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  throwIfAborted();
  const started = performance.now();
  onProgress?.('Reading clips', 0);
  const blobs: Blob[] = [];
  for (let i = 0; i < clips.length; i++) {
    const b = await getBlob(clips[i].blobKey);
    if (!b) throw new Error(`Missing media for clip ${i + 1}`);
    blobs.push(b);
  }

  const total = clips.reduce((s, c) => s + clipLen(c), 0);
  const output = exportDimensions(aspectRatio, quality);
  const sourcesMatchOutput = clips.every((clip) =>
    clip.width === output.width && clip.height === output.height,
  );
  const allMp4 = clips.every((clip, i) =>
    clip.mimeType.includes('mp4') || blobs[i].type.includes('mp4'),
  );
  const allUntrimmed = clips.every(isUntrimmed);
  const sameCameraCodec = clips.every((clip) =>
    clip.mimeType === clips[0].mimeType && clip.mimeType.includes('avc1'),
  );

  if (clips.length === 1 && allMp4 && allUntrimmed && sourcesMatchOutput) {
    onProgress?.('Using camera original', 1);
    return {
      blob: blobs[0],
      bytes: blobs[0].size,
      seconds: (performance.now() - started) / 1000,
      mode: 'native',
    };
  }

  throwIfAborted();
  const ffmpeg = await getFFmpeg();
  throwIfAborted();
  onProgress?.('Preparing media', 0.02);
  const ext = (m: string) => (m.includes('mp4') ? 'mp4' : 'webm');
  const inputs: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const name = `in${i}.${ext(clips[i].mimeType || blobs[i].type)}`;
    await ffmpeg.writeFile(name, new Uint8Array(await blobs[i].arrayBuffer()));
    inputs.push(name);
  }

  if (clips.length > 1 && allMp4 && allUntrimmed && sourcesMatchOutput && sameCameraCodec) {
    throwIfAborted();
    const concatFile = 'concat.txt';
    const concatBody = inputs.map((name) => `file '${name}'`).join('\n');
    await ffmpeg.writeFile(concatFile, new TextEncoder().encode(concatBody));
    onProgress?.('Joining without re-encoding', 0.25);
    const remuxCode = await ffmpeg.exec([
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
      '-movflags', '+faststart', '-map_metadata', '-1', 'out.mp4',
    ]);
    if (remuxCode === 0) {
      const data = await ffmpeg.readFile('out.mp4');
      const bytes = (data as Uint8Array).byteLength;
      const blob = new Blob([new Uint8Array(data as Uint8Array).buffer as ArrayBuffer], { type: 'video/mp4' });
      for (const name of [...inputs, concatFile, 'out.mp4']) ffmpeg.deleteFile(name).catch(() => {});
      onProgress?.('Done', 1);
      return { blob, bytes, seconds: (performance.now() - started) / 1000, mode: 'remuxed' };
    }
    console.warn('[export] lossless join was incompatible; rendering instead');
    await ffmpeg.deleteFile(concatFile).catch(() => {});
    await ffmpeg.deleteFile('out.mp4').catch(() => {});
  }

  throwIfAborted();
  const probes = await probeInputs(ffmpeg, inputs);
  const maxSourceFps = probes.reduce((max, probe) => Math.max(max, probe.fps ?? 30), 30);
  throwIfAborted();

  // Fast path: hardware (or native software) H.264 via WebCodecs. wasm x264
  // cannot finish 2160x3840 on real devices, so 4K depends on this path; it is
  // also used for 1080p renders when available. Audio is still produced by
  // ffmpeg.wasm (audio-only AAC encode is fast) and the two are remuxed with
  // "-c copy", so the result stays a normal faststart MP4.
  const plan = await planWebCodecsEncode(output.width, output.height, quality, maxSourceFps);
  if (plan) {
    try {
      console.log('[export] using webcodecs encoder:', plan.config.codec, plan.config.hardwareAcceleration ?? 'default');
      onProgress?.('Rendering video', 0.05);
      let videoBytes: Uint8Array | null = await renderVideoWebCodecs(
        clips, blobs, output.width, output.height, plan,
        (p) => onProgress?.('Rendering video', 0.05 + p * 0.65), signal);

      throwIfAborted();
      onProgress?.('Encoding audio', 0.72);
      const audioParts: string[] = [];
      for (let i = 0; i < clips.length; i++) {
        audioParts.push(audioChain(i, clipLen(clips[i]), probes[i].hasAudio));
      }
      audioParts.push(`${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[aout]`);
      const audioArgs: string[] = ['-fflags', '+genpts'];
      for (let i = 0; i < clips.length; i++) {
        audioArgs.push('-ss', String(clips[i].trimIn), '-t', String(clipLen(clips[i])), '-i', inputs[i]);
      }
      audioArgs.push(
        '-filter_complex', audioParts.join(';'), '-map', '[aout]',
        '-c:a', 'aac', '-b:a', '128k', '-vn', 'audio.m4a',
      );
      const audioProgress = ({ time }: { time: number }) => {
        onProgress?.('Encoding audio', 0.72 + Math.min(0.2, (time / 1_000_000 / total) * 0.2));
      };
      ffmpeg.on('progress', audioProgress);
      const audioCode = await ffmpeg.exec(audioArgs);
      ffmpeg.off('progress', audioProgress);
      if (audioCode !== 0) throw new Error('audio encode failed');

      // Peak-memory control: the source clips are no longer needed once the
      // audio track exists. Freeing them BEFORE the encoded 4K video is copied
      // into MEMFS keeps sources + encoded video from being resident at the
      // same time (>1GB transient on ~60s 4K exports, an iOS jetsam risk).
      for (const name of inputs) await ffmpeg.deleteFile(name).catch(() => {});

      throwIfAborted();
      onProgress?.('Finalizing', 0.94);
      await ffmpeg.writeFile('wcvideo.mp4', videoBytes);
      videoBytes = null; // MEMFS holds the only copy now; release ours
      const muxCode = await ffmpeg.exec([
        '-i', 'wcvideo.mp4', '-i', 'audio.m4a',
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
        '-movflags', '+faststart', '-map_metadata', '-1', '-metadata', 'encoder=',
        'out.mp4',
      ]);
      // Intermediates are dead weight whether or not the mux worked.
      for (const n of ['wcvideo.mp4', 'audio.m4a']) await ffmpeg.deleteFile(n).catch(() => {});
      if (muxCode !== 0) throw new Error('final mux failed');

      const muxed = await ffmpeg.readFile('out.mp4');
      const bytes = (muxed as Uint8Array).byteLength;
      const blob = new Blob([new Uint8Array(muxed as Uint8Array).buffer as ArrayBuffer], { type: 'video/mp4' });
      ffmpeg.deleteFile('out.mp4').catch(() => {});
      onProgress?.('Done', 1);
      return { blob, bytes, seconds: (performance.now() - started) / 1000, mode: 'transcoded' };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      console.warn('[export] webcodecs path failed; falling back to wasm encoder', error);
      for (const n of ['wcvideo.mp4', 'audio.m4a', 'out.mp4']) ffmpeg.deleteFile(n).catch(() => {});
      // The inputs may already have been freed for peak-memory reasons;
      // restore them from the still-held blobs so the wasm path can run.
      for (let i = 0; i < clips.length; i++) {
        await ffmpeg.writeFile(inputs[i], new Uint8Array(await blobs[i].arrayBuffer()));
      }
    }
  }

  throwIfAborted();
  const args: string[] = [];
  args.push('-fflags', '+genpts');
  for (let i = 0; i < clips.length; i++) {
    args.push('-ss', String(clips[i].trimIn), '-t', String(clipLen(clips[i])), '-i', inputs[i]);
  }

  // Per-clip normalize to the selected portrait frame and reset timestamps.
  // Deliberately NO fps=30 CFR conversion here: camera captures are variable
  // frame rate, and snapping jittery/short timestamps onto a rigid 30fps grid
  // duplicated and dropped frames (measured ~28-40% duplicates), which is
  // exactly the stutter seen on saved clips. Preserving the captured
  // timestamps (VFR output) keeps playback as smooth as the recording.
  // Seamless joins: MediaRecorder audio routinely starts late or ends a few
  // hundred ms short of the video, and the concat filter delays each next
  // segment to the end of the previous segment's longest stream — so a short
  // audio track becomes an audible gap/click at every join. Cut both streams
  // to the exact clip length: video via trim (the input-level -t cut is only
  // packet-accurate on VFR sources) and audio via atrim + apad=whole_dur,
  // which pads real silence up to the same length (audio-less clips get pure
  // generated silence). Every segment then measures exactly clipLen on both
  // streams and concat lines them up sample-tight.
  const parts: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const len = clipLen(clips[i]);
    parts.push(
      `[${i}:v]scale=${output.width}:${output.height}:force_original_aspect_ratio=increase,` +
        `crop=${output.width}:${output.height}:(in_w-out_w)/2:(in_h-out_h)/2,setsar=1,format=yuv420p,settb=AVTB,` +
        `setpts=PTS-STARTPTS,trim=end=${len}[v${i}]`,
    );
    parts.push(audioChain(i, len, probes[i].hasAudio));
  }
  const concatIn = clips.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${concatIn}concat=n=${clips.length}:v=1:a=1[vout][aout]`);

  // H.264 level must satisfy the spec for the output size at the source frame
  // rate: 5.1 only covers 2160x3840 up to 30fps; faster sources need 5.2.
  // Same math for 1080x1920: 4.0 up to 30fps, 4.2 above.
  const level = quality === '4K'
    ? (maxSourceFps > 30 ? '5.2' : '5.1')
    : (maxSourceFps > 30 ? '4.2' : '4.0');

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...encoderThreadArgs(),
    '-c:v', 'libx264', '-preset', quality === '4K' ? 'ultrafast' : 'veryfast', '-crf', quality === '4K' ? '22' : '20',
    '-profile:v', 'high', '-level', level,
    // Keep the 4K encoder memory-lean so wasm (2GB address space, less on
    // some mobile browsers) survives 2160x3840: single reference frame, no
    // B-frames, short lookahead.
    ...(quality === '4K' ? ['-x264-params', 'ref=1:bframes=0:rc-lookahead=10:keyint=60'] : []),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    // vfr preserves the capture's real frame timing (see filter note above).
    '-fps_mode', 'vfr', '-video_track_timescale', '90000', '-avoid_negative_ts', 'make_zero',
    '-map_metadata', '-1',
    '-metadata', 'encoder=',
    'out.mp4',
  );

  const progressCb = ({ time }: { time: number }) => {
    const p = Math.min(0.99, time / 1_000_000 / total);
    onProgress?.('Encoding', p);
  };
  ffmpeg.on('progress', progressCb);

  console.log('[export] args:', args.join(' '));
  const ok = await ffmpeg.exec(args);
  ffmpeg.off('progress', progressCb);
  if (ok !== 0) throw new Error('Export failed (encoder error)');

  const data = await ffmpeg.readFile('out.mp4');
  const bytes = (data as Uint8Array).byteLength;
  const blob = new Blob([new Uint8Array(data as Uint8Array).buffer as ArrayBuffer], { type: 'video/mp4' });

  // cleanup FS
  for (const n of inputs) ffmpeg.deleteFile(n).catch(() => {});
  ffmpeg.deleteFile('out.mp4').catch(() => {});

  onProgress?.('Done', 1);
  return { blob, bytes, seconds: (performance.now() - started) / 1000, mode: 'transcoded' };
}

/** Native share reports completion/cancellation, but not the destination chosen by the OS. */
export async function shareFile(blob: Blob, filename: string): Promise<'shared' | 'cancelled' | 'unavailable' | 'failed'> {
  const file = new File([blob], filename, { type: 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      return 'failed';
    }
  }
  return 'unavailable';
}

/** Requests a browser download. Browsers expose no API to confirm its final OS location. */
export function downloadBlob(blob: Blob, filename: string): boolean {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Large iOS downloads may still be handed to the OS after the click.
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    return true;
  } catch {
    URL.revokeObjectURL(url);
    return false;
  }
}
