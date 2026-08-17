import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Film, Images, SwitchCamera, Zap, ZapOff } from 'lucide-react';
import { getCameraStream, startRecording } from '../lib/recorder';
import type { ActiveRecording } from '../lib/recorder';
import { storageMode } from '../lib/db';
import { prepareExportAssets } from '../lib/ffmpeg';
import { useStore } from '../state/store';
import { ASPECT_RATIOS, fmtTime, clipFraming, clipLen, exportDimensions, isUltraHDCapture } from '../types/clip';
import type { AspectRatio, CaptureQuality } from '../types/clip';

type ZoomRange = { min: number; max: number; step: number };
type ExtendedCapabilities = MediaTrackCapabilities & { zoom?: ZoomRange; torch?: boolean };
type ExtendedSettings = MediaTrackSettings & { zoom?: number };
type ExtendedConstraintSet = MediaTrackConstraintSet & { zoom?: number; torch?: boolean };
type ActiveHold = { kind: 'pointer' | 'touch'; id: number } | { kind: 'keyboard'; id: 'keyboard' };

const RATIOS: AspectRatio[] = ['16:9', '4:3', '1:1'];
const QUALITIES: CaptureQuality[] = ['HD', '4K'];

/**
 * Press-duration boundary between the two record gestures (Instagram/TikTok
 * convention): a press released within this window is a TAP — recording
 * continues after the finger lifts and the button becomes an explicit Stop
 * control (tap again to stop). A press held longer is a HOLD — releasing it
 * stops and saves, exactly as before.
 */
const TAP_TOGGLE_MS = 350;

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Wait until the preview reports the frame it will actually display/record. */
async function waitForPreviewMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth && video.videoHeight) return;
  await new Promise<void>((resolve) => {
    let timeout = 0;
    const done = () => {
      video.removeEventListener('loadedmetadata', done);
      window.clearTimeout(timeout);
      resolve();
    };
    video.addEventListener('loadedmetadata', done);
    // A camera stream can occasionally omit the event after a rapid switch.
    // Do not leave the capture UI disabled forever; track settings remain the
    // honest fallback below when intrinsic dimensions are still unavailable.
    timeout = window.setTimeout(done, 2500);
  });
}

export default function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<ActiveRecording | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeHoldRef = useRef<ActiveHold | null>(null);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  /** performance.now() at the press that started the current recording. */
  const pressStartedAtRef = useRef(0);
  /**
   * True when a short tap latched the recording ON: the press has been
   * released but recording deliberately continues until the next tap stops
   * it. Checked by the async start completion so a tap released before the
   * recorder finished starting keeps recording instead of instantly stopping.
   */
  const latchedRef = useRef(false);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const pendingZoomRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const memoryNoticeShownRef = useRef(false);

  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);
  const [zoom, setZoom] = useState(1);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [captureSize, setCaptureSize] = useState<{ width?: number; height?: number; frameRate?: number } | null>(null);
  const [capabilityNotice, setCapabilityNotice] = useState<string | null>(null);
  const savedTimerRef = useRef<number | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [poppedClipId, setPoppedClipId] = useState<string | null>(null);

  const {
    clips, addClipFromBlob, importFiles, setScreen, total,
    aspectRatio, setAspectRatio, captureQuality, setCaptureQuality,
  } = useStore();
  const lastExportQuality = useStore((s) => s.lastExportQuality);

  const showCapabilityNotice = useCallback((message: string, durationMs = 2200) => {
    setCapabilityNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setCapabilityNotice(null), durationMs);
  }, []);

  const openCamera = useCallback(async (nextFacing: 'user' | 'environment', quality: CaptureQuality) => {
    setStreamReady(false);
    setTorchOn(false);
    setError(null);
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await getCameraStream(nextFacing, quality);
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack?.getCapabilities?.() as ExtendedCapabilities | undefined;
      let settings = videoTrack?.getSettings?.() as ExtendedSettings | undefined;
      const nextZoomRange = capabilities?.zoom && capabilities.zoom.max > capabilities.zoom.min
        ? {
            min: capabilities.zoom.min,
            max: capabilities.zoom.max,
            step: capabilities.zoom.step || 0.1,
          }
        : null;

      streamRef.current = stream;
      setZoomRange(nextZoomRange);
      let nextZoom = settings?.zoom ?? nextZoomRange?.min ?? 1;
      // Some phones reopen the front camera at a remembered/default digital
      // zoom above its widest capability. Always start a selfie at the
      // camera's minimum, while leaving pinch zoom available afterwards.
      if (nextFacing === 'user' && nextZoomRange && nextZoom > nextZoomRange.min) {
        try {
          const current = videoTrack.getConstraints?.() ?? {};
          await videoTrack.applyConstraints({
            ...current,
            advanced: [
              ...(current.advanced ?? []),
              { zoom: nextZoomRange.min } as ExtendedConstraintSet,
            ],
          });
          settings = videoTrack.getSettings?.() as ExtendedSettings | undefined;
          nextZoom = settings?.zoom ?? nextZoomRange.min;
        } catch { /* portrait fill still starts from the widest mode the browser supplied */ }
      }
      setZoom(nextZoom);
      setTorchSupported(nextFacing === 'environment' && capabilities?.torch === true);
      const preview = videoRef.current;
      if (preview) {
        preview.srcObject = stream;
        await waitForPreviewMetadata(preview);
        if (streamRef.current !== stream) return;
        await preview.play().catch(() => {});
      }
      // videoWidth/videoHeight describe the actual display-oriented frame.
      // Track settings can claim 1080x1920 while an iOS MediaRecorder blob is
      // still landscape; showing the intrinsic size keeps the badge truthful
      // and waiting for it prevents recording during orientation setup.
      setCaptureSize({
        width: preview?.videoWidth || settings?.width,
        height: preview?.videoHeight || settings?.height,
        frameRate: settings?.frameRate,
      });
      // The capture badge always reflects the size the camera actually
      // delivered; be explicit when a 4K request could not be honored.
      if (quality === '4K' && !isUltraHDCapture(settings?.width, settings?.height)) {
        showCapabilityNotice('4K not available on this camera');
      }
      setStreamReady(true);
      setError(null);
    } catch (cameraError: unknown) {
      setZoomRange(null);
      setTorchSupported(false);
      setCaptureSize(null);
      setError(
        cameraError instanceof DOMException && cameraError.name === 'NotAllowedError'
          ? 'Camera access was denied. Allow camera and microphone permission, then try again.'
          : 'Could not open a camera on this device.',
      );
    }
  }, [showCapabilityNotice]);

  useEffect(() => {
    openCamera(facing, captureQuality);
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [facing, captureQuality, openCamera]);

  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    if (zoomFrameRef.current) window.cancelAnimationFrame(zoomFrameRef.current);
  }, []);

  // Two or more clips will need ffmpeg for either a safe no-reencode join or
  // an AAC render. Pull its 32 MB core forward while the user is still in the
  // capture flow, after recording persistence/finalization has settled. One
  // untouched clip keeps the zero-download native fast path.
  useEffect(() => {
    if (clips.length > 1 && !recording && !starting && !stopping) {
      void prepareExportAssets();
    }
  }, [clips.length, recording, starting, stopping]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden && videoRef.current) videoRef.current.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const finishRecording = useCallback(async (active: ActiveRecording | null) => {
    if (!active || stoppingRef.current) return;
    stoppingRef.current = true;
    latchedRef.current = false;
    setStopping(true);
    if (recRef.current === active) recRef.current = null;
    setRecording(false);
    try {
      const blob = await active.stop();
      if (blob.size > 0) {
        // Camera thumbnails are deferred so mobile decoders are fully
        // available for the next recording instead of competing in parallel.
        // Stamp the recorder's ACTUAL negotiated codec string: provenance
        // trust for remux requires it to match across every clip in the set.
        const clip = await addClipFromBlob(
          blob,
          blob.type,
          false,
          'recording',
          active.mimeType,
          'cover',
        );
        // Unmissable saved confirmation: users reported not knowing whether
        // releasing the button actually kept the clip.
        const count = useStore.getState().clips.length;
        setSavedNotice(`Clip saved ✓ · ${count} clip${count === 1 ? '' : 's'}`);
        setPoppedClipId(clip.id);
        if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => {
          setSavedNotice(null);
          setPoppedClipId(null);
        }, 2600);
        // Clear crash-recovery chunks only after the media and project entry
        // are both safely stored.
        await active.finalize();
        // Private browsing / broken IndexedDB: the clip was kept in memory
        // instead. Say so once, without blocking further recording.
        if (storageMode() === 'memory' && !memoryNoticeShownRef.current) {
          memoryNoticeShownRef.current = true;
          showCapabilityNotice("Private browsing: clips won't survive closing this tab", 6000);
        }
      } else {
        await active.finalize();
        throw new Error('The browser returned an empty recording');
      }
    } catch (recordingError) {
      console.error('[cam] stop recording failed', recordingError);
      // Keep the underlying reason visible: a field screenshot of this alert
      // must be enough to diagnose what actually failed.
      const detail = recordingError instanceof Error && recordingError.message
        ? ` (${recordingError.message})`
        : '';
      setError(`The recording could not be saved. Please try again.${detail}`);
    } finally {
      setElapsed(0);
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [addClipFromBlob, showCapabilityNotice]);

  const startHold = useCallback((source: ActiveHold) => {
    if (
      !streamRef.current || !streamReady || error || stoppingRef.current ||
      startingRef.current || recRef.current || activeHoldRef.current !== null
    ) return;

    // Claim the gesture synchronously so duplicate touch/pointer events cannot
    // start a second recorder before React renders the starting state.
    activeHoldRef.current = source;
    latchedRef.current = false;
    pressStartedAtRef.current = performance.now();
    startingRef.current = true;
    setStarting(true);
    const stream = streamRef.current;
    void (async () => {
      try {
        const output = exportDimensions(aspectRatio, captureQuality === '4K' ? '4K' : '1080p');
        const active = await startRecording(stream, setElapsed, facing, videoRef.current, output);
        recRef.current = active;
        if (!active.outputReady) {
          showCapabilityNotice('This browser will need to render the recording during export', 5000);
        }
        // Released before the recorder finished starting: a hold-release (or a
        // cancel) stops immediately, but a tap-latch keeps recording — the tap
        // gesture's whole point is that the finger has already lifted.
        if (activeHoldRef.current !== source && !latchedRef.current) {
          await finishRecording(active);
          return;
        }
        setRecording(true);
      } catch (recordingError) {
        console.error('[cam] start recording failed', recordingError);
        if (activeHoldRef.current === source) activeHoldRef.current = null;
        latchedRef.current = false;
        setError('Recording is not supported in this browser.');
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    })();
  }, [aspectRatio, captureQuality, error, facing, finishRecording, showCapabilityNotice, streamReady]);

  /**
   * A press while a tap-latched recording runs is the STOP gesture. Everything
   * else starts a recording (or is absorbed by startHold's duplicate guards).
   */
  const handlePressStart = useCallback((source: ActiveHold) => {
    if (latchedRef.current && !activeHoldRef.current && !stoppingRef.current) {
      latchedRef.current = false;
      // If the recorder is still starting (very fast double tap), clearing the
      // latch makes the pending start's completion stop-and-save immediately.
      if (recRef.current) void finishRecording(recRef.current);
      return;
    }
    startHold(source);
  }, [finishRecording, startHold]);

  /**
   * Press released. `cancelled` marks non-deliberate endings (pointercancel /
   * touchcancel / blur): those always stop, never latch. A deliberate release
   * within TAP_TOGGLE_MS latches the recording on (tap-to-record); a longer
   * hold keeps the classic release-to-stop behavior.
   */
  const releaseActiveHold = useCallback((cancelled = false) => {
    if (!activeHoldRef.current) return;
    const heldMs = performance.now() - pressStartedAtRef.current;
    activeHoldRef.current = null;
    if (!cancelled && heldMs < TAP_TOGGLE_MS) {
      latchedRef.current = true;
      return;
    }
    if (recRef.current) void finishRecording(recRef.current);
  }, [finishRecording]);

  const endMatchingHold = useCallback((kind: ActiveHold['kind'], id: number | 'keyboard', cancelled = false) => {
    const active = activeHoldRef.current;
    if (!active || active.kind !== kind || active.id !== id) return;
    releaseActiveHold(cancelled);
  }, [releaseActiveHold]);

  useEffect(() => {
    const endPointerHold = (event: PointerEvent) => endMatchingHold('pointer', event.pointerId);
    const cancelPointerHold = (event: PointerEvent) => endMatchingHold('pointer', event.pointerId, true);
    const endTouchHold = (event: TouchEvent) => {
      const active = activeHoldRef.current;
      if (!active) return;
      if (active.kind === 'touch' && Array.from(event.changedTouches).some((touch) => touch.identifier === active.id)) {
        releaseActiveHold();
      } else if (active.kind === 'pointer' && event.touches.length === 0) {
        // Some mobile WebKit versions omit the final pointerup after capture;
        // touchend remains the reliable release signal.
        releaseActiveHold();
      }
    };
    const cancelTouchHold = () => releaseActiveHold(true);
    const cancelOnBlur = () => releaseActiveHold(true);
    window.addEventListener('pointerup', endPointerHold, true);
    window.addEventListener('pointercancel', cancelPointerHold, true);
    window.addEventListener('touchend', endTouchHold, true);
    window.addEventListener('touchcancel', cancelTouchHold, true);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      window.removeEventListener('pointerup', endPointerHold, true);
      window.removeEventListener('pointercancel', cancelPointerHold, true);
      window.removeEventListener('touchend', endTouchHold, true);
      window.removeEventListener('touchcancel', cancelTouchHold, true);
      window.removeEventListener('blur', cancelOnBlur);
    };
  }, [endMatchingHold, releaseActiveHold]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) {
      showCapabilityNotice('Flash is unavailable on this camera');
      return;
    }
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as ExtendedConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
      showCapabilityNotice('Flash is unavailable on this camera');
    }
  };

  const applyZoom = useCallback((value: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !zoomRange) return;
    const stepped = Math.round(value / zoomRange.step) * zoomRange.step;
    const next = Math.min(zoomRange.max, Math.max(zoomRange.min, stepped));
    pendingZoomRef.current = next;
    if (zoomFrameRef.current) return;
    zoomFrameRef.current = window.requestAnimationFrame(() => {
      zoomFrameRef.current = null;
      const pending = pendingZoomRef.current;
      if (pending === null) return;
      pendingZoomRef.current = null;
      setZoom(pending);
      track.applyConstraints({ advanced: [{ zoom: pending } as ExtendedConstraintSet] }).catch(() => {
        setZoomRange(null);
        showCapabilityNotice('Pinch zoom is unavailable on this camera');
      });
    });
  }, [showCapabilityNotice, zoomRange]);

  const updatePinchStart = () => {
    const points = Array.from(pointersRef.current.values());
    if (points.length === 2) pinchRef.current = { distance: distance(points[0], points[1]), zoom };
  };

  const onPreviewPointerDown = (event: React.PointerEvent) => {
    // Recovery/import controls can appear over the preview. Do not let the
    // pinch-zoom surface capture their pointer before the button can click.
    if (event.target instanceof Element && event.target.closest('button')) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updatePinchStart();
  };

  const onPreviewPointerMove = (event: React.PointerEvent) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(pointersRef.current.values());
    if (points.length !== 2 || !pinchRef.current) return;
    event.preventDefault();
    if (!zoomRange) {
      showCapabilityNotice('Pinch zoom is unavailable on this camera');
      return;
    }
    const scale = distance(points[0], points[1]) / Math.max(1, pinchRef.current.distance);
    applyZoom(pinchRef.current.zoom * scale);
  };

  const onPreviewPointerEnd = (event: React.PointerEvent) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    updatePinchStart();
  };

  const switchCamera = () => {
    if (recording || starting) return;
    // Disable camera-dependent controls in the same event as the label flip;
    // otherwise there is one render where the UI says "rear camera" while
    // the previous stream is still live and tappable.
    setStreamReady(false);
    setFacing((current) => (current === 'user' ? 'environment' : 'user'));
  };

  // Pointer/touch gestures own physical tap-vs-hold recording. Keyboard and
  // assistive technologies activate buttons with a synthetic click (detail 0),
  // so handle that click as a simple record/stop toggle. Pointer-generated
  // clicks are ignored because their down/up events already did the work.
  const onAccessibleRecordClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.detail !== 0 || activeHoldRef.current) return;
    const source: ActiveHold = { kind: 'keyboard', id: 'keyboard' };
    if (latchedRef.current) {
      handlePressStart(source);
      return;
    }
    handlePressStart(source);
    releaseActiveHold();
  };

  const hasClips = clips.length > 0;
  const controlsDisabled = recording || starting || stopping || !streamReady;

  return (
    <div className="fixed inset-0 bg-black text-white select-none overflow-hidden flex flex-col">
      <header className="relative z-20 grid shrink-0 grid-cols-2 items-center gap-x-2 bg-black px-3 pb-2 pt-[max(env(safe-area-inset-top),0.625rem)] sm:grid-cols-[1fr_auto_1fr]">
        <div className="order-1 text-sm font-semibold tracking-tight">Takes</div>
        <div className="order-3 col-span-2 mt-2 flex w-full items-center gap-1.5 sm:order-2 sm:col-span-1 sm:mt-0 sm:w-auto">
          <div className="flex min-w-0 flex-1 items-center rounded-full bg-white/10 p-0.5 sm:flex-none" role="group" aria-label="Aspect ratio">
            {RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                disabled={controlsDisabled}
                aria-pressed={aspectRatio === ratio}
                onClick={() => setAspectRatio(ratio)}
                className={`min-h-11 min-w-11 flex-1 rounded-full px-2 text-[11px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-40 sm:min-h-8 sm:flex-none ${
                  aspectRatio === ratio ? 'bg-white text-black' : 'text-white/70'
                }`}
              >
                {ratio}
              </button>
            ))}
          </div>
          <div className="flex items-center rounded-full bg-white/10 p-0.5" role="group" aria-label="Capture quality">
            {QUALITIES.map((quality) => (
              <button
                key={quality}
                type="button"
                disabled={controlsDisabled}
                aria-pressed={captureQuality === quality}
                onClick={() => setCaptureQuality(quality)}
                className={`min-h-11 min-w-11 flex-1 rounded-full px-2 text-[11px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-40 sm:min-h-8 sm:flex-none ${
                  captureQuality === quality ? 'bg-white text-black' : 'text-white/70'
                }`}
              >
                <span className="relative">
                  {quality}
                  {/* Subtle steer: someone who last exported at 4K but is
                      capturing HD will require a full 4K upscale next time.
                      A dot, not a modal. */}
                  {quality === '4K' && captureQuality === 'HD' && lastExportQuality === '4K' && (
                    <span
                      data-capture-4k-nudge
                      title="You last exported in 4K — capture in 4K to avoid a slower upscale"
                      className="absolute -right-1.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400"
                    />
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="order-2 text-right text-sm tabular-nums text-white/80 sm:order-3">
          {recording ? fmtTime(elapsed) : fmtTime(total)}
        </div>
      </header>

      <main
        className="relative min-h-0 flex-1 flex items-center justify-center overflow-hidden bg-neutral-950 touch-none"
        onPointerDown={onPreviewPointerDown}
        onPointerMove={onPreviewPointerMove}
        onPointerUp={onPreviewPointerEnd}
        onPointerCancel={onPreviewPointerEnd}
      >
        <div
          data-camera-frame
          data-frame-ratio={ASPECT_RATIOS[aspectRatio].outputLabel}
          data-capture-quality={captureQuality}
          data-capture-width={captureSize?.width}
          data-capture-height={captureSize?.height}
          data-capture-frame-rate={captureSize?.frameRate}
          className="relative max-h-full max-w-full overflow-hidden bg-neutral-900"
          style={{
            aspectRatio: ASPECT_RATIOS[aspectRatio].css,
            height: aspectRatio === '16:9' ? '100%' : 'auto',
            width: aspectRatio === '16:9' ? 'auto' : '100%',
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            data-camera-preview
            data-preview-framing="cover"
            className={`absolute inset-0 h-full w-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`}
          />

          <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/50 to-transparent pointer-events-none" />
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent pointer-events-none" />

          <div className="absolute right-3 top-3 rounded-full bg-black/65 px-2.5 py-1.5 text-[10px] font-semibold text-white/80">
            {ASPECT_RATIOS[aspectRatio].outputLabel}
          </div>

          {/* One shared, wrappable bottom row: on narrow frames (320x568) the
              zoom pill wraps to its own line so the capture badge keeps the
              full resolution visible instead of truncating. */}
          <div className="absolute inset-x-2 bottom-3 flex flex-wrap items-center gap-x-2 gap-y-1 pointer-events-none">
            {/* No "Camera" prefix: at 320px-wide viewports the prefix truncated
                the actual resolution away, hiding the honesty affordance. */}
            <div data-capture-badge className="min-w-0 truncate rounded-full bg-black/65 px-2.5 py-1.5 text-[10px] text-white/70">
              {captureSize?.width && captureSize?.height ? `${captureSize.width}×${captureSize.height}` : 'device managed'}
              {captureSize?.frameRate ? ` · ${captureSize.frameRate.toFixed(0)} fps` : ''}
            </div>
            <div className="ml-auto shrink-0 rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold tabular-nums shadow-sm" aria-live="polite">
              {zoom.toFixed(zoom % 1 === 0 ? 0 : 1)}×
              {!zoomRange && <span className="ml-1.5 font-normal text-white/60">fixed</span>}
            </div>
          </div>

          {recording && (
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-red-600 px-3 py-1.5 text-xs font-bold tabular-nums text-white shadow-lg">
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
              REC {fmtTime(elapsed)}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="absolute inset-x-4 top-4 z-20 rounded-xl bg-neutral-900 p-4 text-center text-sm shadow-lg">
            <p>{error}</p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void openCamera(facing, captureQuality)}
                className="min-h-11 rounded-full bg-white px-4 text-xs font-semibold text-black active:bg-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Try camera again
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="min-h-11 rounded-full bg-white/10 px-4 text-xs font-semibold text-white active:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Import video
              </button>
            </div>
          </div>
        )}

        {savedNotice && (
          <div
            data-saved-notice
            role="status"
            className="absolute bottom-4 left-1/2 z-20 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full bg-white px-4 py-2 text-center text-sm font-semibold text-black shadow-lg"
          >
            {savedNotice}
          </div>
        )}

        {capabilityNotice && (
          <div className="absolute left-1/2 top-4 z-20 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-2xl bg-neutral-900 px-3 py-2 text-center text-xs shadow-lg" aria-live="polite">
            {capabilityNotice}
          </div>
        )}
      </main>

      <footer className="relative z-20 shrink-0 bg-black px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3">
        {hasClips && (
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => setScreen('editor')}
            aria-label={`Done recording. Review ${clips.length} clip${clips.length === 1 ? '' : 's'}`}
            data-review-clips
            className="mx-auto mb-3 flex min-h-14 w-full max-w-md items-center gap-3 rounded-xl bg-white px-3 py-2 text-left text-black shadow-lg transition-colors active:bg-white/85 disabled:opacity-40"
          >
            <span className="flex shrink-0 -space-x-2" aria-hidden="true">
              {clips.slice(-3).map((clip, index, shown) => (
                <span
                  key={clip.id}
                  className={`h-8 w-8 overflow-hidden rounded-md border border-white bg-neutral-800 ${
                    clip.id === poppedClipId && index === shown.length - 1 ? 'animate-thumb-pop' : ''
                  }`}
                >
                  {clip.thumbs[0] && (
                    <img
                      src={clip.thumbs[0]}
                      className={`h-full w-full bg-black ${clipFraming(clip) === 'contain' ? 'object-contain' : 'object-cover'}`}
                      alt=""
                    />
                  )}
                </span>
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-medium leading-tight text-black/60">Done recording?</span>
              <span className="mt-0.5 block truncate text-sm font-semibold leading-tight">
                Review {clips.length} clip{clips.length === 1 ? '' : 's'}
                <span className="hidden min-[360px]:inline"> · {fmtTime(clips.reduce((sum, clip) => sum + clipLen(clip), 0))}</span>
              </span>
            </span>
            <ArrowRight className="shrink-0" size={20} strokeWidth={2.25} aria-hidden="true" />
          </button>
        )}

        <div className="grid grid-cols-[3rem_1fr_3rem] items-center gap-5">
          <button
            type="button"
            onClick={toggleTorch}
            disabled={!torchSupported || controlsDisabled}
            aria-label={torchSupported ? (torchOn ? 'Turn flash off' : 'Turn flash on') : 'Flash unavailable'}
            aria-pressed={torchOn}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 transition active:scale-95 disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {torchOn ? <Zap size={21} fill="currentColor" /> : <ZapOff size={21} />}
          </button>

          <div className="flex flex-col items-center">
            <button
              type="button"
              disabled={!streamReady || !!error || stopping}
              aria-label={recording ? 'Stop recording' : 'Tap to record'}
              aria-describedby="record-hint"
              data-record-state={recording ? 'recording' : starting ? 'starting' : stopping ? 'stopping' : 'idle'}
              onContextMenu={(event) => event.preventDefault()}
              onClick={onAccessibleRecordClick}
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                handlePressStart({ kind: 'pointer', id: event.pointerId });
              }}
              onPointerUp={(event) => { event.preventDefault(); endMatchingHold('pointer', event.pointerId); }}
              onPointerCancel={(event) => endMatchingHold('pointer', event.pointerId, true)}
              onLostPointerCapture={(event) => endMatchingHold('pointer', event.pointerId, true)}
              onTouchStart={(event) => {
                const touch = event.changedTouches[0];
                if (touch) handlePressStart({ kind: 'touch', id: touch.identifier });
              }}
              onTouchEnd={(event) => {
                const active = activeHoldRef.current;
                if (active?.kind === 'touch' && Array.from(event.changedTouches).some((touch) => touch.identifier === active.id)) {
                  releaseActiveHold();
                } else if (active?.kind === 'pointer' && event.touches.length === 0) {
                  releaseActiveHold();
                }
              }}
              onTouchCancel={() => {
                if (activeHoldRef.current?.kind !== 'keyboard') releaseActiveHold(true);
              }}
              className={`relative flex h-[78px] w-[78px] touch-none items-center justify-center rounded-full border-[5px] transition-transform duration-150 active:scale-95 disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${recording ? 'scale-110 border-red-500' : 'border-white'}`}
            >
              {recording && (
                <span aria-hidden="true" className="absolute -inset-1.5 animate-record-pulse rounded-full border-2 border-red-500" />
              )}
              {/* While recording the inner shape becomes a rounded square — the
                  universal "stop" glyph — so the button reads as an explicit
                  STOP control (tap to stop; a held press still stops on
                  release), not just in the hint text. */}
              <span className={`block bg-red-500 transition-all duration-150 ${recording ? 'h-[36px] w-[36px] rounded-lg' : 'h-[58px] w-[58px] rounded-full'}`} />
            </button>
            <span
              id="record-hint"
              aria-live="polite"
              className={`mt-2 rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                recording ? 'bg-red-600 font-bold text-white' : 'font-medium text-white/60'
              }`}
            >
              {recording ? 'Tap to stop' : 'Tap to record'}
            </span>
          </div>

          <button
            type="button"
            onClick={switchCamera}
            disabled={controlsDisabled}
            aria-label={facing === 'environment' ? 'Switch to front camera' : 'Switch to rear camera'}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 transition active:scale-95 disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <SwitchCamera size={22} />
          </button>
        </div>

        <div className="mt-1 grid grid-cols-[5rem_1fr_5rem] items-center">
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => fileRef.current?.click()}
            className="flex min-h-11 items-center justify-self-start gap-2 rounded-full px-3 text-xs font-semibold text-white/75 active:bg-white/10 disabled:opacity-35"
            aria-label="Import videos"
          >
            <Images size={18} /> Import
          </button>
          <div className="flex items-center justify-self-center gap-1 whitespace-nowrap text-[11px] text-white/60">
            <Film size={13} aria-hidden="true" /> Stored locally
          </div>
          {/* The review action directly above is the single timeline entry point;
              keeping another “Timeline” button here crowded the trust copy at
              320px and created two equally loud routes to the same screen. */}
          <span aria-hidden="true" />
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) importFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </footer>
    </div>
  );
}
