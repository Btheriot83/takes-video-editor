import { parseAdts, renderVideoWebCodecs, setScalerOverride } from './webcodecs-export';
import type { WebCodecsPlan } from './webcodecs-export';
import { exportLog, exportLogTail, setExportLogSink } from './export-log';
import type { Clip } from '../types/clip';

/**
 * Dedicated module Worker for the WebCodecs video render. The whole pipeline
 * (mp4box demux + VideoDecoder + scaler + VideoEncoder + mp4-muxer) is pure
 * WebCodecs/OffscreenCanvas work and runs unchanged off the main thread, so
 * UI/React/progress rendering no longer contends with per-frame decode/encode
 * — on iPhone that contention both slowed the pipeline and froze the page.
 *
 * The ELEMENT fallback path inside renderVideoWebCodecs needs a DOM <video>
 * and cannot run here: in a worker `document` is undefined, so that path
 * throws immediately, surfaces as a structured 'error' message, and the main
 * thread reruns the whole render in-page (where the element path works).
 *
 * Protocol: one 'start' message per worker lifetime; the worker replies with
 * throttled 'progress', forwarded 'log' breadcrumbs, and finally 'done' (MP4
 * bytes, ArrayBuffer transferred), 'aborted', or 'error' (message + the
 * worker-side exportLog tail). 'abort' (a bare string) aborts the internal
 * AbortController exactly like the in-page signal handling; the main thread
 * terminates the worker afterwards.
 */

export interface RenderWorkerStart {
  type: 'start';
  clips: Clip[];
  blobs: Blob[];
  width: number;
  height: number;
  plan: WebCodecsPlan;
  /** test-only ?scaler= override read from the page URL by the main thread */
  scaler: string | null;
}

/**
 * Raw ADTS AAC bytes from the main thread's concurrent ffmpeg audio task
 * (or its failure). The worker parses and muxes them directly next to the
 * video; the muxer awaits this message before finalize.
 */
export interface RenderWorkerAudio {
  type: 'audio';
  ok: boolean;
  adts?: Uint8Array;
  message?: string;
}

export type RenderWorkerResponse =
  | { type: 'log'; line: string }
  | { type: 'progress'; p: number }
  | { type: 'done'; bytes: Uint8Array }
  | { type: 'aborted' }
  | { type: 'error'; message: string; log: string[] };

interface WorkerScope {
  postMessage(message: RenderWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = self as unknown as WorkerScope;
const controller = new AbortController();

// Deferred audio: resolved/rejected by the 'audio' message from the main
// thread. Raced against abort so a cancelled render never hangs on it.
let audioResolve: (bytes: Uint8Array) => void;
let audioReject: (error: Error) => void;
const audioBytes = new Promise<Uint8Array>((resolve, reject) => {
  audioResolve = resolve;
  audioReject = reject;
});
audioBytes.catch(() => { /* parked until awaited by getAudio */ });
const abortRejection = new Promise<never>((_, reject) => {
  controller.signal.addEventListener('abort', () =>
    reject(new DOMException('Export cancelled', 'AbortError')));
});
abortRejection.catch(() => { /* only observed via Promise.race */ });

// Forward breadcrumbs to the main thread, which re-logs them into the main
// exportLog buffer (the export sheet's diagnostic surface) and the console.
setExportLogSink((line) => {
  try {
    scope.postMessage({ type: 'log', line });
  } catch { /* worker mid-teardown */ }
});

async function run(msg: RenderWorkerStart): Promise<void> {
  try {
    setScalerOverride(msg.scaler);
    exportLog('render worker: video render started off main thread');
    // Progress is already throttled (>=100ms) inside renderVideoAttempt —
    // the single throttle point — so every callback is forwarded as-is.
    const bytes = await renderVideoWebCodecs(
      msg.clips, msg.blobs, msg.width, msg.height, msg.plan,
      async () => parseAdts(await Promise.race([audioBytes, abortRejection])),
      (p) => scope.postMessage({ type: 'progress', p }),
      controller.signal,
    );
    scope.postMessage({ type: 'done', bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      scope.postMessage({ type: 'aborted' });
      return;
    }
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      log: exportLogTail(48),
    });
  }
}

scope.onmessage = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (data === 'abort') {
    controller.abort();
    return;
  }
  const typed = data as { type?: string } | null;
  if (typed && typeof typed === 'object' && typed.type === 'start') {
    void run(data as RenderWorkerStart);
  } else if (typed && typeof typed === 'object' && typed.type === 'audio') {
    const audio = data as RenderWorkerAudio;
    if (audio.ok && audio.adts) audioResolve(audio.adts);
    else audioReject(new Error(audio.message || 'audio encode failed'));
  }
};
