import { clipLen, clipMatchesOutput, exportDimensions } from '../types/clip';
import { mp4MetasShareCopyableCodec } from './mp4-meta';
import type { AspectRatio, Clip, ExportQuality } from '../types/clip';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { planWebCodecsEncode, probeMp4Blob } from './webcodecs-export';
import { renderVideoWorkerFirst } from './render-worker-client';
import { clearExportLog, exportLog } from './export-log';

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
      // Prefer the real "fps" figure. "tbr" is a timebase-derived guess that
      // VFR MediaRecorder files can inflate absurdly (e.g. 600); an inflated
      // value would push the 4K encoder config to a level real hardware
      // rejects at configure() even though isConfigSupported accepted it.
      const fpsMatch = line.match(/(\d+(?:\.\d+)?) fps/);
      const tbrMatch = line.match(/(\d+(?:\.\d+)?) tbr/);
      const value = fpsMatch ? Number(fpsMatch[1])
        : tbrMatch && Number(tbrMatch[1]) <= 120 ? Number(tbrMatch[1]) : NaN;
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
 * Phone/tablet-class device detection, used only to avoid committing such
 * devices to a wasm 4K encode that cannot realistically finish. iPadOS 13+
 * masquerades as macOS but reports multiple touch points.
 */
const isMobileClass = () =>
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

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
  clearExportLog();
  let webcodecsFailure: string | null = null;
  exportLog(`export start: ${clips.length} clip(s), ${quality}, ${aspectRatio}`);
  onProgress?.('Reading clips', 0);
  const blobs: Blob[] = [];
  for (let i = 0; i < clips.length; i++) {
    const b = await getBlob(clips[i].blobKey);
    if (!b) throw new Error(`Missing media for clip ${i + 1}`);
    blobs.push(b);
  }

  const total = clips.reduce((s, c) => s + clipLen(c), 0);
  const output = exportDimensions(aspectRatio, quality);
  // clip.width/height are DISPLAY dimensions (probeVideo reads
  // videoWidth/videoHeight, which apply the container rotation matrix), so
  // this compares display-to-display: a rotation-flagged landscape 4K capture
  // is stored portrait and matches (remux keeps the matrix, players show it
  // upright), while a true landscape-encoded stream without a rotation flag
  // stays landscape here and correctly falls through to the transcode paths.
  // See clipMatchesOutput for the full safety argument.
  const sourcesMatchOutput = clips.every((clip) => clipMatchesOutput(clip, output));
  const allMp4 = clips.every((clip, i) =>
    clip.mimeType.includes('mp4') || blobs[i].type.includes('mp4'),
  );
  const allUntrimmed = clips.every(isUntrimmed);
  const sameMimeType = clips.every((clip) => clip.mimeType === clips[0].mimeType);

  /**
   * Single mp4box probe pass per blob (pure JS, no ffmpeg load): one parse
   * yields fps + audio-track presence for encoder planning AND the codec +
   * encoded dimensions the multi-clip "-c copy" uniformity check needs, so the
   * copy-path gate and the transcode planner never parse the same blob twice.
   * null = not parsable as MP4 (e.g. WebM) — the transcode path falls back to
   * an ffmpeg probe for those, and the copy path treats null as "transcode".
   */
  const mp4ProbeCache: (Awaited<ReturnType<typeof probeMp4Blob>> | undefined)[] = [];
  const probeBlobCached = async (i: number) => {
    if (mp4ProbeCache[i] === undefined) mp4ProbeCache[i] = await probeMp4Blob(blobs[i], signal);
    return mp4ProbeCache[i];
  };

  /**
   * Multi-clip "-c copy" concat needs every clip on the same copy-safe codec
   * AND the same tkhd rotation/display matrix. The mimeType alone can prove
   * neither: iOS may report a bare "video/mp4" (no codec string), and even a
   * fully parameterized avc1 type says nothing about orientation — two avc1
   * clips with identical coded dims can carry 90° vs 270° matrices (both
   * display portrait, both pass clipMatchesOutput), and the concat output
   * would keep only the first clip's matrix, playing the other 180° wrong.
   * So EVERY remux candidate set is probed with mp4box (cheap JS header
   * parse, cached and shared with the fps/audio planner) and must be uniform
   * in codec, coded dims and matrix. Any doubt -> transcode; a probe-failed
   * genuine camera file merely loses the shortcut, and the concat exit-code
   * fallback below still guards the exec itself.
   */
  const sameCameraCodec = async (): Promise<boolean> => {
    if (!sameMimeType) return false;
    const metas = [];
    for (let i = 0; i < blobs.length; i++) metas.push(await probeBlobCached(i));
    const uniform = mp4MetasShareCopyableCodec(metas);
    exportLog(`remux uniformity probe (codec+dims+rotation matrix): ${uniform ? 'uniform — copy-safe' : 'not uniform/unknown — transcoding'}`);
    return uniform;
  };

  exportLog(
    `copy-path check: dimsMatch=${sourcesMatchOutput} mp4=${allMp4} untrimmed=${allUntrimmed} ` +
    `sameMime=${sameMimeType} sources=${clips.map((c) => `${c.width}x${c.height}`).join(',')} out=${output.width}x${output.height}`,
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
  // Kick off the ffmpeg wasm load WITHOUT awaiting it: the render path no
  // longer needs ffmpeg before the concurrent audio task, so the module load
  // (fetch + compile) overlaps probing/planning/rendering instead of holding
  // the export at 0% progress. Every consumer awaits `ffmpegReady` at its
  // point of first use.
  const ffmpegReady = getFFmpeg();
  ffmpegReady.catch(() => { /* surfaced where awaited */ });
  onProgress?.('Preparing media', 0.02);
  const ext = (m: string) => (m.includes('mp4') ? 'mp4' : 'webm');
  const inputs: string[] = clips.map((clip, i) => `in${i}.${ext(clip.mimeType || blobs[i].type)}`);
  // Emscripten's linear memory never shrinks, so every byte simultaneously
  // resident in MEMFS grows the wasm heap for the tab's remaining lifetime.
  // Inputs are therefore written one at a time wherever possible (peak =
  // largest clip, not the sum of all clips) — clip-count-scaled heap growth
  // is what pushed multi-clip 4K exports over iPhone Safari's memory ceiling.
  let memfsHasInputs = false;
  const writeAllInputs = async () => {
    if (memfsHasInputs) return;
    const ffmpeg = await ffmpegReady;
    for (let i = 0; i < clips.length; i++) {
      await ffmpeg.writeFile(inputs[i], new Uint8Array(await blobs[i].arrayBuffer()));
    }
    memfsHasInputs = true;
  };
  const dropAllInputs = async () => {
    const ffmpeg = await ffmpegReady;
    for (const name of inputs) await ffmpeg.deleteFile(name).catch(() => {});
    memfsHasInputs = false;
  };

  if (clips.length > 1 && allMp4 && allUntrimmed && sourcesMatchOutput && await sameCameraCodec()) {
    throwIfAborted();
    const ffmpeg = await ffmpegReady;
    throwIfAborted();
    await writeAllInputs();
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
    exportLog('lossless join was incompatible; rendering instead');
    await ffmpeg.deleteFile(concatFile).catch(() => {});
    await ffmpeg.deleteFile('out.mp4').catch(() => {});
    await dropAllInputs();
  }

  // Per-clip probe pass for fps + audio-track presence. Primary: mp4box in
  // pure JS — no ffmpeg load wait, no MEMFS write, so the render can start
  // immediately (the former ffmpeg `-i` probe serialized 2-4s of dead time at
  // 0% progress behind the wasm module load). ffmpeg probing remains only as
  // a fallback for blobs mp4box cannot parse (e.g. WebM sources).
  throwIfAborted();
  onProgress?.('Preparing media', 0.03);
  const probes: InputProbe[] = [];
  for (let i = 0; i < clips.length; i++) {
    throwIfAborted();
    let probe: InputProbe | null = await probeBlobCached(i);
    if (!probe) {
      const ffmpeg = await ffmpegReady;
      throwIfAborted();
      await ffmpeg.writeFile(inputs[i], new Uint8Array(await blobs[i].arrayBuffer()));
      [probe] = await probeInputs(ffmpeg, [inputs[i]]);
      await ffmpeg.deleteFile(inputs[i]).catch(() => {});
    }
    probes.push(probe);
    onProgress?.('Preparing media', 0.03 + 0.03 * ((i + 1) / clips.length));
  }
  exportLog(
    `probe: ${probes.map((p, i) => `clip${i + 1} fps=${p.fps ? p.fps.toFixed(1) : '?'} audio=${p.hasAudio ? 'y' : 'n'}`).join(' ')}`,
  );
  // Cap at 60 for encoder planning: phone/browser capture never exceeds 60fps
  // and anything above it here is a probe artifact that would produce an
  // encoder envelope real hardware rejects.
  const maxSourceFps = Math.min(60, probes.reduce((max, probe) => Math.max(max, probe.fps ?? 30), 30));
  throwIfAborted();

  /**
   * Audio pipeline (per-clip AAC segments + gapless join, emitted as raw ADTS
   * and parsed into frames the mp4-muxer adds directly next to the video).
   * Runs entirely inside the ffmpeg worker, so it executes CONCURRENTLY with
   * the WebCodecs video render (which never touches ffmpeg): the audio wall
   * time disappears from the export's critical path instead of preceding the
   * render serially. exec calls stay strictly sequential WITHIN this task —
   * the single ffmpeg worker is not reentrant — and the caller always settles
   * this promise before running any other exec.
   *
   * Memory note (iOS tab-kill ceiling, see 5b6c1b9): inputs are still written
   * one at a time and deleted immediately, so MEMFS peak stays at one clip.
   * The wasm heap never shrinks, so its high-water mark is identical to the
   * old audio-first ordering — overlap only moves WHEN the same growth
   * happens, it does not add to it.
   */
  const encodeAudioTrack = async (): Promise<Uint8Array> => {
    // First point of REQUIRED ffmpeg use on the webcodecs path: the module
    // load (kicked off at export start) overlaps probing/planning/render.
    const ffmpeg = await ffmpegReady;
    if (signal?.aborted) throw abortError();
    const audioSegments: string[] = [];
    try {
      for (let i = 0; i < clips.length; i++) {
        if (signal?.aborted) throw abortError();
        await ffmpeg.writeFile(inputs[i], new Uint8Array(await blobs[i].arrayBuffer()));
        const len = clipLen(clips[i]);
        const segment = `a${i}.m4a`;
        const segCode = await ffmpeg.exec([
          '-fflags', '+genpts',
          '-ss', String(clips[i].trimIn), '-t', String(len), '-i', inputs[i],
          '-filter_complex', audioChain(0, len, probes[i].hasAudio).replace('[a0]', '[aseg]'),
          '-map', '[aseg]', '-c:a', 'aac', '-b:a', '128k', '-vn', segment,
        ]);
        await ffmpeg.deleteFile(inputs[i]).catch(() => {});
        if (segCode !== 0) throw new Error(`audio encode failed (clip ${i + 1})`);
        audioSegments.push(segment);
      }
      // Join the AAC segments with the concat FILTER (decode + re-encode): the
      // concat demuxer's "-c copy" would reintroduce the AAC priming-gap
      // clicks at clip joins that the gapless work removed.
      const joinArgs: string[] = [];
      for (const segment of audioSegments) joinArgs.push('-i', segment);
      // Raw ADTS output (not .m4a): the frames are parsed in JS and handed to
      // mp4-muxer directly, so the final MP4 needs no ffmpeg "-c copy" remux.
      joinArgs.push(
        '-filter_complex',
        `${audioSegments.map((_, i) => `[${i}:a]`).join('')}concat=n=${audioSegments.length}:v=0:a=1[aout]`,
        '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-vn', '-f', 'adts', 'audio.aac',
      );
      const joinCode = await ffmpeg.exec(joinArgs);
      if (joinCode !== 0) throw new Error('audio join failed');
      const adts = await ffmpeg.readFile('audio.aac');
      await ffmpeg.deleteFile('audio.aac').catch(() => {});
      exportLog(
        `audio track encoded (per-clip segments, concurrent with render): ` +
        `${(adts as Uint8Array).byteLength} bytes ADTS`,
      );
      return adts as Uint8Array;
    } finally {
      for (const segment of audioSegments) await ffmpeg.deleteFile(segment).catch(() => {});
      for (const name of inputs) await ffmpeg.deleteFile(name).catch(() => {});
    }
  };

  // Fast path: hardware (or native software) H.264 via WebCodecs. wasm x264
  // cannot finish 2160x3840 on real devices, so 4K depends on this path; it is
  // also used for 1080p renders when available. Audio is still produced by
  // ffmpeg.wasm (audio-only AAC encode is fast, emitted as raw ADTS) and its
  // frames are muxed directly into the mp4-muxer output alongside the video,
  // so the result is a normal faststart MP4 with no final ffmpeg remux.
  const plan = await planWebCodecsEncode(output.width, output.height, quality, maxSourceFps);
  if (!plan && quality === '4K' && isMobileClass()) {
    // wasm x264 cannot realistically finish 2160x3840 on a phone; running it
    // presents as an export that never completes. Be honest instead.
    throw new Error('This device cannot encode 4K video in the browser. Export at 1080p instead.');
  }
  if (plan) {
    // Kick off the audio pipeline now and let it run in the ffmpeg worker
    // while the WebCodecs render proceeds; capture its outcome instead of
    // rejecting so an early render failure can still await settlement (the
    // worker must be idle before any fallback exec).
    const audioTask: Promise<{ adts: Uint8Array } | { failure: unknown }> = encodeAudioTrack().then(
      (adts) => ({ adts }),
      (error: unknown) => ({ failure: error ?? new Error('audio encode failed') }),
    );
    // Raw ADTS bytes, not parsed frames: a single Uint8Array crosses the
    // render-worker boundary as one structured-clone (the worker parses it);
    // the main-thread copy stays alive for the in-page fallback render.
    const getAdts = async () => {
      const settled = await audioTask;
      if ('failure' in settled) throw settled.failure;
      return settled.adts;
    };
    try {
      exportLog(
        `using webcodecs encoder: ${plan.config.codec} ${plan.config.hardwareAcceleration ?? 'default'} ` +
        `latency=${plan.config.latencyMode ?? 'quality'}`,
      );
      onProgress?.('Rendering video', 0.09);
      // The render (worker-first, main-thread fallback) muxes the AAC frames
      // directly next to the video and finalizes a faststart MP4 — the
      // returned bytes ARE the deliverable. No MEMFS video copy, no "-c copy"
      // exec, no out.mp4 readback.
      const finalBytes = await renderVideoWorkerFirst(
        clips, blobs, output.width, output.height, plan, getAdts,
        (p) => onProgress?.('Rendering video', 0.09 + p * 0.85), signal);

      throwIfAborted();
      exportLog('video+audio muxed (direct, no remux)');
      const bytes = finalBytes.byteLength;
      const blob = new Blob([finalBytes.buffer as ArrayBuffer], { type: 'video/mp4' });
      onProgress?.('Done', 1);
      return { blob, bytes, seconds: (performance.now() - started) / 1000, mode: 'transcoded' };
    } catch (error) {
      // The audio task may still be mid-exec in the worker; let it settle
      // (it never rejects) before any cleanup or fallback exec touches ffmpeg.
      await audioTask;
      if (signal?.aborted) throw abortError();
      webcodecsFailure = error instanceof Error ? error.message : String(error);
      exportLog(`webcodecs path failed (${webcodecsFailure}); falling back to wasm encoder`);
      console.warn('[export] webcodecs path failed; falling back to wasm encoder', error);
      const loaded = await ffmpegReady.catch(() => null);
      for (const n of ['audio.aac', 'out.mp4']) loaded?.deleteFile(n).catch(() => {});
      if (quality === '4K' && isMobileClass()) {
        // See above: a phone-class wasm 4K encode never finishes in practice.
        throw new Error(`Export failed: ${webcodecsFailure}. Try again, or export at 1080p.`);
      }
    }
  }

  throwIfAborted();
  const ffmpeg = await ffmpegReady;
  throwIfAborted();
  await ffmpeg.deleteFile('audio.aac').catch(() => {});
  // The combined wasm encode needs every input present at once.
  await writeAllInputs();
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
  if (ok !== 0) {
    exportLog('wasm encode failed');
    throw new Error(webcodecsFailure
      ? `Export failed: hardware path (${webcodecsFailure}), then software encoder error`
      : 'Export failed (encoder error)');
  }

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
