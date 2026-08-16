import { recBegin, recChunk, recFinalize } from './db';
import { CAPTURE_DIMENSIONS, isUltraHDCapture } from '../types/clip';
import type { CaptureQuality } from '../types/clip';

export type CameraFacing = 'user' | 'environment';
export type CameraTrackConstraints = MediaTrackConstraints & {
  /** Present in the Media Capture spec but missing from older lib.dom types. */
  resizeMode?: { exact: 'none' };
};

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
  /**
   * The recorder's ACTUAL negotiated mimeType (MediaRecorder.mimeType after
   * start, falling back to the requested candidate). Stamped onto recorded
   * clips as Clip.recorderMimeType: provenance-trusted remux requires every
   * clip in the set to carry the same non-empty stamp, so clips recorded
   * before/after a browser update that changed the negotiated codec can never
   * be silently concat-copied together.
   */
  mimeType: string;
  /** Camera used when this recording started; stable even after UI switches. */
  facing: CameraFacing;
}

/** Portrait-convention video constraints for a capture quality. */
export function captureConstraints(facing: CameraFacing, quality: CaptureQuality): CameraTrackConstraints {
  const size = CAPTURE_DIMENSIONS[quality];
  return {
    facingMode: { ideal: facing },
    width: { ideal: size.width },
    height: { ideal: size.height },
    frameRate: { ideal: 30, max: 30 },
    // A portrait width/height request is allowed to make the browser crop a
    // native 3:4 selfie sensor before the app even receives it. Require the
    // uncropped native mode for the front camera; unsupported constraints are
    // ignored by the browser and the UI/export contain framing is the second
    // line of defense.
    ...(facing === 'user' ? { resizeMode: { exact: 'none' } } : {}),
  };
}

/**
 * Landscape-convention 4K retry constraints. iOS lists its camera modes in
 * landscape, so portrait ideals 2160x3840 sit closer (by fitness distance) to
 * 1920x1080 than to 3840x2160 and 4K silently never engages. Retrying with
 * landscape ideals — plus advanced exact sets for both orientations — lets
 * WebKit pick the real 4K mode.
 */
export function ultraHDRetryConstraints(facing: CameraFacing): CameraTrackConstraints {
  const size = CAPTURE_DIMENSIONS['4K'];
  return {
    facingMode: { ideal: facing },
    width: { ideal: size.height },
    height: { ideal: size.width },
    frameRate: { ideal: 30, max: 30 },
    ...(facing === 'user' ? { resizeMode: { exact: 'none' } } : {}),
    advanced: [
      { width: size.height, height: size.width },
      { width: size.width, height: size.height },
    ],
  };
}

function streamIsUltraHD(stream: MediaStream): boolean {
  const settings = stream.getVideoTracks()[0]?.getSettings?.();
  return isUltraHDCapture(settings?.width, settings?.height);
}

/**
 * Recording bitrate matched to the delivered capture size. 4K-class frames
 * need roughly 4x the bits of 1080x1920 to keep the same visual quality;
 * everything else stays at the proven HD rate.
 */
export function captureVideoBitrate(width?: number, height?: number): number {
  return isUltraHDCapture(width, height) ? 30_000_000 : 6_000_000;
}

export async function getCameraStream(
  facing: CameraFacing,
  quality: CaptureQuality = 'HD',
): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
  const base: MediaStreamConstraints = {
    video: captureConstraints(facing, quality),
    audio,
  };
  try {
    let stream = await navigator.mediaDevices.getUserMedia(base);
    if (quality === '4K' && !streamIsUltraHD(stream)) {
      // iOS resolves portrait 2160x3840 ideals to 1920x1080 (see
      // ultraHDRetryConstraints). Retry ONCE with landscape ideals before
      // letting the Camera screen show the "4K not available" notice.
      stream.getTracks().forEach((track) => track.stop());
      try {
        const retry = await navigator.mediaDevices.getUserMedia({
          video: ultraHDRetryConstraints(facing),
          audio,
        });
        if (streamIsUltraHD(retry)) return retry;
        // Still not 4K-class: discard the landscape stream so preview and
        // recording keep the portrait convention.
        retry.getTracks().forEach((track) => track.stop());
      } catch { /* retry constraints rejected; reopen the portrait stream */ }
      stream = await navigator.mediaDevices.getUserMedia(base);
    }
    return stream;
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
  facing: CameraFacing = 'environment',
): Promise<ActiveRecording> {
  const mimeType = pickMimeType();
  const videoSettings = stream.getVideoTracks()[0]?.getSettings?.();
  const audioSettings = stream.getAudioTracks()[0]?.getSettings?.();
  // Bitrate follows what the camera actually delivers, not what was requested,
  // so a 4K request that fell back to 1080x1920 is not encoded at 4K rates.
  const videoBitsPerSecond = captureVideoBitrate(videoSettings?.width, videoSettings?.height);
  console.log('[rec] capture=', { mimeType, videoSettings, audioSettings, videoBitsPerSecond });
  const rec = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond,
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
    get mimeType() { return rec.mimeType || mimeType; },
    facing,
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
