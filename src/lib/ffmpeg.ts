import { ASPECT_RATIOS, clipLen } from '../types/clip';
import type { AspectRatio, Clip } from '../types/clip';
import type { FFmpeg } from '@ffmpeg/ffmpeg';

// We load @ffmpeg/ffmpeg's ESM build from same-origin static files
// (public/ffesm) instead of the vite-bundled worker: the bundled module
// worker path proved unreliable, while the static path is verified working.
type FFmpegLike = FFmpeg;
let ff: FFmpegLike | null = null;
let loading: Promise<FFmpegLike> | null = null;

async function getFFmpeg(): Promise<FFmpegLike> {
  if (ff) return ff;
  if (!loading) {
    loading = (async () => {
      const u = (p: string) => new URL(p, document.baseURI).href;
      const mod = await import(/* @vite-ignore */ u('ffesm/index.js'));
      const inst = new mod.FFmpeg();
      inst.on('log', ({ message }: { message: string }) => console.log('[ffmpeg]', message));
      await inst.load({
        coreURL: u('ffmpeg/ffmpeg-core.js'),
        wasmURL: u('ffmpeg/ffmpeg-core.wasm'),
        workerURL: u('ffesm/worker.js'),
      });
      ff = inst;
      return inst;
    })();
  }
  return loading;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  seconds: number;
}

/**
 * Export clips to a clean 1080x1920 H.264/AAC MP4.
 * Everything is re-encoded through one filter graph → A/V stays in sync,
 * orientation is normalized, metadata is stripped.
 */
export async function exportMp4(
  clips: Clip[],
  getBlob: (key: string) => Promise<Blob | undefined>,
  aspectRatio: AspectRatio,
  onProgress?: (phase: string, p: number) => void,
): Promise<ExportResult> {
  if (!clips.length) throw new Error('Nothing to export');
  const ffmpeg = await getFFmpeg();
  onProgress?.('Preparing encoder', 0);

  const ext = (m: string) => (m.includes('mp4') ? 'mp4' : 'webm');
  const inputs: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const b = await getBlob(clips[i].blobKey);
    if (!b) throw new Error(`Missing media for clip ${i + 1}`);
    const name = `in${i}.${ext(clips[i].mimeType)}`;
    await ffmpeg.writeFile(name, new Uint8Array(await b.arrayBuffer()));
    inputs.push(name);
  }

  const total = clips.reduce((s, c) => s + clipLen(c), 0);

  const args: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    args.push('-ss', String(clips[i].trimIn), '-t', String(clipLen(clips[i])), '-i', inputs[i]);
  }

  const output = ASPECT_RATIOS[aspectRatio];

  // Per-clip normalize to the selected portrait frame, 30fps, reset timestamps.
  const parts: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    parts.push(
      `[${i}:v]scale=${output.width}:${output.height}:force_original_aspect_ratio=increase,` +
        `crop=${output.width}:${output.height},setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
    );
    parts.push(
      `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`,
    );
  }
  const concatIn = clips.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${concatIn}concat=n=${clips.length}:v=1:a=1[vout][aout]`);

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-level', '4.0',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
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
  const t0 = performance.now();
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
  return { blob, bytes, seconds: (performance.now() - t0) / 1000 };
}

/** Try native share sheet with the file; returns false if unavailable/cancelled. */
export async function shareFile(blob: Blob, filename: string): Promise<'shared' | 'downloaded' | 'unavailable'> {
  const file = new File([blob], filename, { type: 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared'; // user dismissed sheet; not an error
    }
  }
  return 'unavailable';
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
