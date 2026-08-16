import { exportLog } from './export-log';
import { decoderPathEligible, parseAdts, renderVideoWebCodecs } from './webcodecs-export';
import type { WebCodecsPlan } from './webcodecs-export';
import type { Clip } from '../types/clip';
import type { RenderWorkerAudio, RenderWorkerResponse, RenderWorkerStart } from './render-worker';

/**
 * Main-thread client for the render worker (see render-worker.ts). The worker
 * attempt comes first; on ANY worker failure — construction, crash, or a
 * structured error (e.g. the DOM-dependent element fallback throwing in the
 * worker) — the render is rerun on the main thread, where the full ladder
 * (decoder → element → element-only restart) still applies. A worker failure
 * commits nothing: its muxer output dies with it, so the rerun cannot
 * duplicate frames.
 */

const abortError = () => new DOMException('Export cancelled', 'AbortError');

/** How long to wait after 'abort' for the worker to confirm before killing it. */
const ABORT_TERMINATE_MS = 2000;

function renderInWorker(
  clips: Clip[],
  blobs: Blob[],
  width: number,
  height: number,
  plan: WebCodecsPlan,
  getAdts: () => Promise<Uint8Array>,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let worker: Worker;
    try {
      worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      return reject(new Error(`render worker unavailable (${error instanceof Error ? error.message : error})`));
    }
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      worker.terminate();
      fn();
    };
    const onAbort = () => {
      // Ask the worker to abort internally (it unwinds exactly like the
      // in-page signal handling: encoder/decoder closed, scaler released),
      // with a safety timeout in case the worker is wedged — terminate() then
      // reclaims everything regardless.
      try {
        worker.postMessage('abort');
      } catch { /* worker already dead */ }
      abortTimer = setTimeout(() => settle(() => reject(abortError())), ABORT_TERMINATE_MS);
    };
    signal?.addEventListener('abort', onAbort);
    worker.onerror = (event) => {
      settle(() => reject(new Error(`render worker crashed (${event.message || 'unknown error'})`)));
    };
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as RenderWorkerResponse;
      switch (msg.type) {
        case 'log':
          // Merge worker breadcrumbs into the main log live: the export
          // sheet's error state reads the MAIN buffer, and the worker itself
          // stays console-silent (its exportLog forwards instead of printing).
          exportLog(msg.line);
          break;
        case 'progress':
          if (!signal?.aborted && !settled) onProgress?.(msg.p);
          break;
        case 'done':
          settle(() => resolve(msg.bytes));
          break;
        case 'aborted':
          settle(() => reject(abortError()));
          break;
        case 'error':
          // msg.log (the worker's exportLog tail) has already been merged
          // line-by-line via the live 'log' forwarding above.
          settle(() => reject(new Error(msg.message)));
          break;
      }
    };
    let scaler: string | null = null;
    try {
      scaler = new URLSearchParams(window.location.search).get('scaler');
    } catch { /* no window (tests) */ }
    const start: RenderWorkerStart = { type: 'start', clips, blobs, width, height, plan, scaler };
    worker.postMessage(start);
    // Forward the audio bytes (or the audio task's failure) as soon as they
    // exist. Deliberately CLONED, not transferred: the main-thread copy must
    // survive for the in-page fallback render if this worker dies. ~1MB/min
    // of AAC, so the copy is trivial next to the video pipeline.
    getAdts().then(
      (adts) => {
        if (settled) return;
        const audio: RenderWorkerAudio = { type: 'audio', ok: true, adts };
        try { worker.postMessage(audio); } catch { /* worker already gone */ }
      },
      (error: unknown) => {
        if (settled) return;
        const audio: RenderWorkerAudio = {
          type: 'audio', ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
        try { worker.postMessage(audio); } catch { /* worker already gone */ }
      },
    );
  });
}

/**
 * Render the video track: dedicated worker first (keeps the main thread — and
 * the page — responsive during a 4K export), main-thread renderVideoWebCodecs
 * as fallback. Aborts propagate unchanged and never trigger the fallback.
 */
export async function renderVideoWorkerFirst(
  clips: Clip[],
  blobs: Blob[],
  width: number,
  height: number,
  plan: WebCodecsPlan,
  getAdts: () => Promise<Uint8Array>,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // The worker can only run the DOM-free decoder path (mp4box+VideoDecoder);
  // a clip that will need the <video> element path would fail there after
  // worker startup + demux attempts. Cheap main-thread approximation of
  // eligibility (mp4 mime + VideoDecoder present, no demux): if ANY clip is
  // clearly element-only, skip the worker detour entirely.
  const allDecoderEligible = clips.every((clip, i) => decoderPathEligible(clip, blobs[i]));
  if (!allDecoderEligible) {
    exportLog('render: clip(s) need the element path; skipping worker, rendering on main thread');
  }
  if (allDecoderEligible && typeof Worker !== 'undefined') {
    try {
      return await renderInWorker(clips, blobs, width, height, plan, getAdts, onProgress, signal);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      exportLog(`worker render failed (${error instanceof Error ? error.message : error}); retrying on main thread`);
    }
  }
  return renderVideoWebCodecs(
    clips, blobs, width, height, plan,
    async () => parseAdts(await getAdts()),
    onProgress, signal,
  );
}
