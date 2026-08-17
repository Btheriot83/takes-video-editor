import { recBegin, recChunk, recFinalize } from './db';
import { CAPTURE_DIMENSIONS, isFullUltraHDFrame, isUltraHDCapture } from '../types/clip';
import { framePlacement } from './framing';
import type { CaptureQuality } from '../types/clip';

export type CameraFacing = 'user' | 'environment';
export type CameraTrackConstraints = MediaTrackConstraints & {
  /** Present in the Media Capture spec but missing from older lib.dom types. */
  resizeMode?: { ideal: 'crop-and-scale' };
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
  /** True when the saved track was normalized to the selected output frame. */
  outputReady: boolean;
  /** How output frames are sampled from the live camera. */
  captureMode: 'camera-native' | 'source-synced' | 'timer' | 'raw';
}

type RecordingFrame = { width: number; height: number };
type ManualCanvasTrack = MediaStreamTrack & { requestFrame?: () => void };
type ComposedRecordingStream = {
  stream: MediaStream;
  dispose: () => void;
  mode: 'source-synced' | 'timer';
  frameCount: () => number;
};

/**
 * The camera track is the smoothest recording source because the phone can
 * keep it on its native hardware encode path. A 4K canvas redraw is only
 * necessary when the selected project frame actually differs from the
 * display-oriented camera frame (for example, a square crop).
 */
export function canRecordCameraTrackDirectly(
  preview: RecordingFrame,
  output: RecordingFrame,
): boolean {
  return preview.width > 0 && preview.height > 0
    && preview.width === output.width && preview.height === output.height;
}

function cancelPreviewFrame(preview: HTMLVideoElement, id: number | null): void {
  if (id !== null && typeof preview.cancelVideoFrameCallback === 'function') {
    preview.cancelVideoFrameCallback(id);
  }
}

/**
 * Record the frame the user actually sees instead of trusting MediaRecorder
 * to preserve a phone camera track's display orientation. WebKit and Chromium
 * can both expose a portrait preview while MediaRecorder writes the camera's
 * underlying landscape sensor dimensions; that mismatch is what forced every
 * selfie through a very slow export-time render.
 *
 * A canvas capture has three useful properties here:
 *  - the stored MP4 pixels are physically portrait (no fragile rotation flag),
 *  - the dimensions exactly match the selected project frame, and
 *  - the single necessary cover crop happens once during hardware recording,
 *    so untouched clips can later use native/copy export.
 *
 * The original microphone tracks are reused without processing. If canvas
 * capture is unavailable, return null and let startRecording retain the raw
 * camera fallback; the export sheet will then label the required render before
 * the user starts it.
 */
function composeOutputReadyStream(
  source: MediaStream,
  preview: HTMLVideoElement,
  output: RecordingFrame,
  frameRate: number,
): ComposedRecordingStream | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') return null;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  canvas.width = output.width;
  canvas.height = output.height;

  let disposed = false;
  let videoFrameId: number | null = null;
  let animationFrameId: number | null = null;
  let drawnFrames = 0;

  const draw = () => {
    if (disposed) return false;
    if (preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && preview.videoWidth > 0 && preview.videoHeight > 0) {
      const placement = framePlacement(
        preview.videoWidth,
        preview.videoHeight,
        output.width,
        output.height,
        'cover',
      );
      context.drawImage(
        preview,
        placement.source.x,
        placement.source.y,
        placement.source.width,
        placement.source.height,
        placement.output.x,
        placement.output.y,
        placement.output.width,
        placement.output.height,
      );
      drawnFrames += 1;
      return true;
    }
    return false;
  };

  // A fixed 30 Hz canvas clock can sample between camera frames, duplicating
  // some frames and skipping others. Prefer manual canvas capture and request
  // exactly one output frame for every frame the camera actually delivers.
  // Older browsers fall back to the proven timer-driven stream.
  let canvasStream = canvas.captureStream(0);
  let videoTrack = canvasStream.getVideoTracks()[0] as ManualCanvasTrack | undefined;
  let mode: ComposedRecordingStream['mode'] = 'source-synced';
  if (videoTrack && typeof videoTrack.requestFrame !== 'function') {
    videoTrack.stop();
    canvasStream = canvas.captureStream(Math.max(1, Math.min(30, frameRate || 30)));
    videoTrack = canvasStream.getVideoTracks()[0] as ManualCanvasTrack | undefined;
    mode = 'timer';
  }
  if (!videoTrack) {
    disposed = true;
    cancelPreviewFrame(preview, videoFrameId);
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    return null;
  }

  const schedule = () => {
    if (disposed) return;
    if (typeof preview.requestVideoFrameCallback === 'function') {
      videoFrameId = preview.requestVideoFrameCallback(() => {
        if (draw() && mode === 'source-synced') videoTrack.requestFrame?.();
        schedule();
      });
    } else {
      animationFrameId = window.requestAnimationFrame(() => {
        draw();
        schedule();
      });
    }
  };
  if (draw() && mode === 'source-synced') videoTrack.requestFrame?.();
  schedule();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelPreviewFrame(preview, videoFrameId);
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    videoTrack.stop();
    canvas.width = 1;
    canvas.height = 1;
  };

  return {
    stream: new MediaStream([videoTrack, ...source.getAudioTracks()]),
    dispose,
    mode,
    frameCount: () => drawnFrames,
  };
}

/**
 * Output-ready 9:16 selfie constraints. `crop-and-scale` is intentional for
 * the front camera: a phone's native selfie sensor is commonly landscape 4:3,
 * so forbidding the UA's capture-time crop yields a landscape/3:4 file that
 * must be slowly re-encoded to become portrait 9:16. Asking for the displayed
 * portrait size lets the camera pipeline derive a 1080x1920/2160x3840 track
 * that can be exported without re-encoding.
 *
 * The crop is not a digital zoom. It is the single center crop required to
 * turn the sensor frame into 9:16 — the same crop the preview/output would
 * otherwise apply later, only without the expensive second encode.
 */
export function captureConstraints(facing: CameraFacing, quality: CaptureQuality): CameraTrackConstraints {
  const size = CAPTURE_DIMENSIONS[quality];
  const front = facing === 'user';
  return {
    facingMode: { ideal: facing },
    width: { ideal: size.width },
    height: { ideal: size.height },
    frameRate: { ideal: 30, max: 30 },
    ...(front ? {
      aspectRatio: { ideal: size.width / size.height },
      // Keep this ideal rather than exact so older browsers can fall back to
      // a native mode instead of rejecting camera access altogether.
      resizeMode: { ideal: 'crop-and-scale' } as const,
    } : {}),
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
    ...(facing === 'user' ? {
      aspectRatio: { ideal: size.height / size.width },
      resizeMode: { ideal: 'crop-and-scale' } as const,
    } : {}),
    advanced: [
      { width: size.height, height: size.width },
      { width: size.width, height: size.height },
    ],
  };
}

function streamIsUltraHD(stream: MediaStream): boolean {
  const settings = stream.getVideoTracks()[0]?.getSettings?.();
  return isFullUltraHDFrame(settings?.width, settings?.height);
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
  quality: CaptureQuality = '4K',
): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
  const base: MediaStreamConstraints = {
    video: captureConstraints(facing, quality),
    audio,
  };
  try {
    let stream = await navigator.mediaDevices.getUserMedia(base);
    if (quality === '4K' && !streamIsUltraHD(stream)) {
      // iOS can resolve a 4K ideal to 1080p (see ultraHDRetryConstraints).
      // Retry ONCE with exact 4K candidates before letting the Camera screen
      // show the "4K not available" notice.
      stream.getTracks().forEach((track) => track.stop());
      try {
        const retry = await navigator.mediaDevices.getUserMedia({
          video: ultraHDRetryConstraints(facing),
          audio,
        });
        if (streamIsUltraHD(retry)) return retry;
        // Still not 4K-class: discard the retry and reopen the base stream so
        // the selected camera owns its normal fallback behavior.
        retry.getTracks().forEach((track) => track.stop());
      } catch { /* retry constraints rejected; reopen the base stream */ }
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
  preview?: HTMLVideoElement | null,
  output?: RecordingFrame,
): Promise<ActiveRecording> {
  const mimeType = pickMimeType();
  const cameraSettings = stream.getVideoTracks()[0]?.getSettings?.();
  const audioSettings = stream.getAudioTracks()[0]?.getSettings?.();
  const cameraNativeOutput = Boolean(preview && output && canRecordCameraTrackDirectly(
    { width: preview.videoWidth, height: preview.videoHeight },
    output,
  ));
  let composition = !cameraNativeOutput && preview && output
    ? composeOutputReadyStream(stream, preview, output, cameraSettings?.frameRate ?? 30)
    : null;
  let recordingStream = composition?.stream ?? stream;
  let videoSettings = recordingStream.getVideoTracks()[0]?.getSettings?.();
  let videoBitsPerSecond = captureVideoBitrate(
    composition ? output?.width : videoSettings?.width,
    composition ? output?.height : videoSettings?.height,
  );
  const captureMode = () => cameraNativeOutput ? 'camera-native' : composition?.mode ?? 'raw';

  const createRecorder = () => new MediaRecorder(recordingStream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond,
    audioBitsPerSecond: 128_000,
  });
  let rec: MediaRecorder;
  try {
    rec = createRecorder();
  } catch (error) {
    if (!composition) throw error;
    // A browser may expose canvas.captureStream yet reject that stream in
    // MediaRecorder. Preserve recording in that case and make the fallback
    // explicit through outputReady=false and the export preflight warning.
    composition.dispose();
    composition = null;
    recordingStream = stream;
    videoSettings = cameraSettings;
    videoBitsPerSecond = captureVideoBitrate(videoSettings?.width, videoSettings?.height);
    rec = createRecorder();
  }
  console.log('[rec] capture=', {
    mimeType,
    cameraSettings,
    recordingSettings: videoSettings,
    output,
    outputReady: cameraNativeOutput || Boolean(composition),
    captureMode: captureMode(),
    audioSettings,
    videoBitsPerSecond,
  });
  console.log(`[rec] capture mode=${captureMode()}`);

  let seq = 0;
  const chunks: Blob[] = [];
  const pendingChunkWrites: Promise<void>[] = [];
  const chunkIntervals: number[] = [];
  let lastChunkAt = performance.now();
  console.log('[rec] recBegin…');
  try {
    await recBegin({ mimeType: rec.mimeType || mimeType, startedAt: Date.now(), facing });
  } catch (error) {
    composition?.dispose();
    throw error;
  }

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
  try {
    rec.start(2000);
  } catch (error) {
    clearInterval(timer);
    composition?.dispose();
    throw error;
  }
  const frameCountAtStart = composition?.frameCount() ?? 0;
  console.log('[rec] started, state=', rec.state);

  return {
    get mimeType() { return rec.mimeType || mimeType; },
    outputReady: cameraNativeOutput || Boolean(composition),
    captureMode: captureMode(),
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
          composition?.dispose();
          reject(new Error('Timed out while stopping the recording'));
        }, 5000);
        rec.onstop = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          clearInterval(timer);
          const capturedFrames = Math.max(0, (composition?.frameCount() ?? 0) - frameCountAtStart);
          composition?.dispose();
          const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
          console.log('[rec] completed=', {
            elapsed,
            bytes: blob.size,
            chunks: chunks.length,
            chunkIntervalsMs: chunkIntervals.map((interval) => Math.round(interval)),
            mimeType: blob.type,
            videoBitsPerSecond: rec.videoBitsPerSecond,
            audioBitsPerSecond: rec.audioBitsPerSecond,
            captureMode: captureMode(),
            capturedFrames,
            measuredFps: elapsed > 0 ? Number((capturedFrames / elapsed).toFixed(1)) : null,
          });
          resolve(blob);
        };
        rec.onerror = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          clearInterval(timer);
          composition?.dispose();
          reject(new Error('The browser failed to stop the recording'));
        };
        try { rec.requestData(); } catch { /* noop */ }
        try {
          rec.stop();
        } catch (error) {
          settled = true;
          window.clearTimeout(timeout);
          clearInterval(timer);
          composition?.dispose();
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
