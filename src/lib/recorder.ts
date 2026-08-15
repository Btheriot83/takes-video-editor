import { recBegin, recChunk, recFinalize } from './db';

// Prefer H.264 in MP4: it is hardware-encoded on virtually all phones, so the
// capture keeps its full frame rate. VP9/VP8 fallbacks are software encoders
// that can starve 1080x1920 capture down to ~20fps on mobile — the source of
// stuttery saved clips.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2', // High profile
  'video/mp4;codecs=avc1.4D4028,mp4a.40.2', // Main profile
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/webm;codecs=h264,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* ignore */ }
  }
  return '';
}

export interface ActiveRecording {
  stop: () => Promise<Blob>;
  finalize: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  paused: boolean;
}

export async function getCameraStream(facing: 'user' | 'environment'): Promise<MediaStream> {
  const base: MediaStreamConstraints = {
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: { echoCancellation: true, noiseSuppression: true },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(base);
  } catch {
    // fallback: any camera (some desktops choke on facingMode ideal with audio constraints)
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }
}

/**
 * Start an interruption-safe recording. Chunks are flushed to IndexedDB
 * every two seconds so a crash/kill loses at most ~2s, never completed clips.
 */
export async function startRecording(
  stream: MediaStream,
  onTick?: (elapsed: number) => void,
  facing: 'user' | 'environment' = 'environment',
): Promise<ActiveRecording> {
  const mimeType = pickMimeType();
  const videoSettings = stream.getVideoTracks()[0]?.getSettings?.();
  const audioSettings = stream.getAudioTracks()[0]?.getSettings?.();
  console.log('[rec] capture=', { mimeType, videoSettings, audioSettings });
  const rec = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 128_000,
  });

  let seq = 0;
  const chunks: Blob[] = [];
  const pendingChunkWrites: Promise<void>[] = [];
  const chunkIntervals: number[] = [];
  let lastChunkAt = performance.now();
  console.log('[rec] recBegin…');
  await recBegin({ mimeType: rec.mimeType || mimeType, startedAt: Date.now(), facing });

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      const now = performance.now();
      chunkIntervals.push(now - lastChunkAt);
      lastChunkAt = now;
      chunks.push(e.data);
      const write = recChunk(seq++, e.data).catch(() => {});
      pendingChunkWrites.push(write);
    }
  };

  let elapsed = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (rec.state === 'recording') elapsed += (now - last) / 1000;
    last = now;
    onTick?.(elapsed);
  }, 100);

  console.log('[rec] starting mediarecorder');
  // Fewer, larger chunks reduce IndexedDB/main-thread churn during capture
  // while retaining interruption recovery at a two-second cadence.
  rec.start(2000);
  console.log('[rec] started, state=', rec.state);

  return {
    get paused() { return rec.state === 'paused'; },
    pause: () => { if (rec.state === 'recording') rec.pause(); },
    resume: () => { if (rec.state === 'paused') rec.resume(); },
    finalize: async () => {
      await Promise.all(pendingChunkWrites);
      await recFinalize();
    },
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          reject(new Error('Timed out while stopping the recording'));
        }, 5000);
        rec.onstop = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          clearInterval(timer);
          const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
          console.log('[rec] completed=', {
            elapsed,
            bytes: blob.size,
            chunks: chunks.length,
            chunkIntervalsMs: chunkIntervals.map((interval) => Math.round(interval)),
            mimeType: blob.type,
            videoBitsPerSecond: rec.videoBitsPerSecond,
            audioBitsPerSecond: rec.audioBitsPerSecond,
          });
          resolve(blob);
        };
        rec.onerror = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          clearInterval(timer);
          reject(new Error('The browser failed to stop the recording'));
        };
        try { rec.requestData(); } catch { /* noop */ }
        try {
          rec.stop();
        } catch (error) {
          settled = true;
          window.clearTimeout(timeout);
          clearInterval(timer);
          reject(error);
        }
      }),
  };
}

/** Probe a video blob for duration + dimensions. */
export function probeVideo(blob: Blob): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const timeout = window.setTimeout(() => {
      done();
      reject(new Error('Timed out while reading the recorded clip'));
    }, 5000);
    const done = () => {
      window.clearTimeout(timeout);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
    };
    v.onloadedmetadata = () => {
      // some webm recordings report Infinity; seek to force duration computation
      if (v.duration === Infinity || isNaN(v.duration)) {
        v.currentTime = 1e7;
        v.onseeked = () => {
          const d = v.duration === Infinity ? v.currentTime : v.duration;
          const r = { duration: d, width: v.videoWidth, height: v.videoHeight };
          done();
          resolve(r);
        };
      } else {
        const r = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
        done();
        resolve(r);
      }
    };
    v.onerror = () => { done(); reject(new Error('Cannot read video file')); };
    v.src = url;
  });
}
