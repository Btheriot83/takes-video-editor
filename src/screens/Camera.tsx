import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Images, SwitchCamera, Zap, ZapOff } from 'lucide-react';
import { getCameraStream, startRecording } from '../lib/recorder';
import type { ActiveRecording } from '../lib/recorder';
import { useStore } from '../state/store';
import { ASPECT_RATIOS, fmtTime, clipLen, isUltraHDCapture } from '../types/clip';
import type { AspectRatio, CaptureQuality } from '../types/clip';

type ZoomRange = { min: number; max: number; step: number };
type ExtendedCapabilities = MediaTrackCapabilities & { zoom?: ZoomRange; torch?: boolean };
type ExtendedSettings = MediaTrackSettings & { zoom?: number };
type ExtendedConstraintSet = MediaTrackConstraintSet & { zoom?: number; torch?: boolean };
type ActiveHold = { kind: 'pointer' | 'touch'; id: number } | { kind: 'keyboard'; id: 'keyboard' };

const RATIOS: AspectRatio[] = ['16:9', '4:3', '1:1'];
const QUALITIES: CaptureQuality[] = ['HD', '4K'];

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<ActiveRecording | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeHoldRef = useRef<ActiveHold | null>(null);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const pendingZoomRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

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

  const {
    clips, addClipFromBlob, importFiles, setScreen, total,
    aspectRatio, setAspectRatio, captureQuality, setCaptureQuality,
  } = useStore();

  const showCapabilityNotice = useCallback((message: string) => {
    setCapabilityNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setCapabilityNotice(null), 2200);
  }, []);

  const openCamera = useCallback(async (nextFacing: 'user' | 'environment', quality: CaptureQuality) => {
    setStreamReady(false);
    setTorchOn(false);
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await getCameraStream(nextFacing, quality);
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack?.getCapabilities?.() as ExtendedCapabilities | undefined;
      const settings = videoTrack?.getSettings?.() as ExtendedSettings | undefined;
      const nextZoomRange = capabilities?.zoom && capabilities.zoom.max > capabilities.zoom.min
        ? {
            min: capabilities.zoom.min,
            max: capabilities.zoom.max,
            step: capabilities.zoom.step || 0.1,
          }
        : null;

      streamRef.current = stream;
      setZoomRange(nextZoomRange);
      setZoom(settings?.zoom ?? nextZoomRange?.min ?? 1);
      setTorchSupported(nextFacing === 'environment' && capabilities?.torch === true);
      setCaptureSize({ width: settings?.width, height: settings?.height, frameRate: settings?.frameRate });
      // The capture badge always reflects the size the camera actually
      // delivered; be explicit when a 4K request could not be honored.
      if (quality === '4K' && !isUltraHDCapture(settings?.width, settings?.height)) {
        showCapabilityNotice('4K not available on this camera');
      }
      setStreamReady(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
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
    if (zoomFrameRef.current) window.cancelAnimationFrame(zoomFrameRef.current);
  }, []);

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
    setStopping(true);
    if (recRef.current === active) recRef.current = null;
    setRecording(false);
    try {
      const blob = await active.stop();
      if (blob.size > 0) {
        // Camera thumbnails are deferred so mobile decoders are fully
        // available for the next recording instead of competing in parallel.
        await addClipFromBlob(blob, blob.type, false);
        // Clear crash-recovery chunks only after the media and project entry
        // are both safely stored.
        await active.finalize();
      } else {
        await active.finalize();
        throw new Error('The browser returned an empty recording');
      }
    } catch (recordingError) {
      console.error('[cam] stop recording failed', recordingError);
      setError('The recording could not be saved. Please try again.');
    } finally {
      setElapsed(0);
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [addClipFromBlob]);

  const startHold = useCallback((source: ActiveHold) => {
    if (
      !streamRef.current || !streamReady || error || stoppingRef.current ||
      startingRef.current || recRef.current || activeHoldRef.current !== null
    ) return;

    // Claim the gesture synchronously so duplicate touch/pointer events cannot
    // start a second recorder before React renders the starting state.
    activeHoldRef.current = source;
    startingRef.current = true;
    setStarting(true);
    const stream = streamRef.current;
    void (async () => {
      try {
        const active = await startRecording(stream, setElapsed, facing);
        recRef.current = active;
        if (activeHoldRef.current !== source) {
          await finishRecording(active);
          return;
        }
        setRecording(true);
      } catch (recordingError) {
        console.error('[cam] start recording failed', recordingError);
        if (activeHoldRef.current === source) activeHoldRef.current = null;
        setError('Recording is not supported in this browser.');
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    })();
  }, [error, facing, finishRecording, streamReady]);

  const stopActiveHold = useCallback(() => {
    if (!activeHoldRef.current) return;
    activeHoldRef.current = null;
    if (recRef.current) void finishRecording(recRef.current);
  }, [finishRecording]);

  const endMatchingHold = useCallback((kind: ActiveHold['kind'], id: number | 'keyboard') => {
    const active = activeHoldRef.current;
    if (!active || active.kind !== kind || active.id !== id) return;
    stopActiveHold();
  }, [stopActiveHold]);

  useEffect(() => {
    const endPointerHold = (event: PointerEvent) => endMatchingHold('pointer', event.pointerId);
    const endTouchHold = (event: TouchEvent) => {
      const active = activeHoldRef.current;
      if (!active) return;
      if (active.kind === 'touch' && Array.from(event.changedTouches).some((touch) => touch.identifier === active.id)) {
        stopActiveHold();
      } else if (active.kind === 'pointer' && event.touches.length === 0) {
        // Some mobile WebKit versions omit the final pointerup after capture;
        // touchend remains the reliable release signal.
        stopActiveHold();
      }
    };
    const cancelTouchHold = () => stopActiveHold();
    window.addEventListener('pointerup', endPointerHold, true);
    window.addEventListener('pointercancel', endPointerHold, true);
    window.addEventListener('touchend', endTouchHold, true);
    window.addEventListener('touchcancel', cancelTouchHold, true);
    window.addEventListener('blur', stopActiveHold);
    return () => {
      window.removeEventListener('pointerup', endPointerHold, true);
      window.removeEventListener('pointercancel', endPointerHold, true);
      window.removeEventListener('touchend', endTouchHold, true);
      window.removeEventListener('touchcancel', cancelTouchHold, true);
      window.removeEventListener('blur', stopActiveHold);
    };
  }, [endMatchingHold, stopActiveHold]);

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
    setFacing((current) => (current === 'user' ? 'environment' : 'user'));
  };

  const hasClips = clips.length > 0;
  const controlsDisabled = recording || starting || stopping;

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
                {quality}
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
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold tabular-nums">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              {fmtTime(elapsed)}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="absolute inset-x-4 top-4 z-20 rounded-xl bg-neutral-900 p-4 text-center text-sm shadow-lg">
            {error}
          </div>
        )}

        {capabilityNotice && (
          <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2 whitespace-nowrap rounded-full bg-neutral-900 px-3 py-2 text-xs shadow-lg" aria-live="polite">
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
            className="mx-auto mb-3 flex min-h-11 max-w-full items-center gap-2 rounded-full bg-white/10 px-2 pr-4 text-left transition-colors active:bg-white/15 disabled:opacity-40"
          >
            <span className="flex -space-x-2">
              {clips.slice(-3).map((clip) => (
                <span key={clip.id} className="h-8 w-8 overflow-hidden rounded-md border border-black bg-neutral-800">
                  {clip.thumbs[0] && <img src={clip.thumbs[0]} className="h-full w-full object-cover" alt="" />}
                </span>
              ))}
            </span>
            <span className="truncate text-xs font-medium">
              {clips.length} clip{clips.length === 1 ? '' : 's'} · {fmtTime(clips.reduce((sum, clip) => sum + clipLen(clip), 0))}
            </span>
            <span className="ml-auto text-xs font-semibold">Edit</span>
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
              aria-label={recording ? 'Release to stop recording' : 'Hold to record'}
              aria-describedby="record-hint"
              data-record-state={recording ? 'recording' : starting ? 'starting' : stopping ? 'stopping' : 'idle'}
              onContextMenu={(event) => event.preventDefault()}
              onClick={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                startHold({ kind: 'pointer', id: event.pointerId });
              }}
              onPointerUp={(event) => { event.preventDefault(); endMatchingHold('pointer', event.pointerId); }}
              onPointerCancel={(event) => endMatchingHold('pointer', event.pointerId)}
              onLostPointerCapture={(event) => endMatchingHold('pointer', event.pointerId)}
              onTouchStart={(event) => {
                const touch = event.changedTouches[0];
                if (touch) startHold({ kind: 'touch', id: touch.identifier });
              }}
              onTouchEnd={(event) => {
                const active = activeHoldRef.current;
                if (active?.kind === 'touch' && Array.from(event.changedTouches).some((touch) => touch.identifier === active.id)) {
                  stopActiveHold();
                } else if (active?.kind === 'pointer' && event.touches.length === 0) {
                  stopActiveHold();
                }
              }}
              onTouchCancel={() => {
                if (activeHoldRef.current?.kind !== 'keyboard') stopActiveHold();
              }}
              onKeyDown={(event) => {
                if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                  event.preventDefault();
                  startHold({ kind: 'keyboard', id: 'keyboard' });
                }
              }}
              onKeyUp={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  endMatchingHold('keyboard', 'keyboard');
                }
              }}
              onBlur={() => endMatchingHold('keyboard', 'keyboard')}
              className={`relative flex h-[78px] w-[78px] touch-none items-center justify-center rounded-full border-[5px] border-white transition-transform duration-150 active:scale-95 disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${recording ? 'scale-110' : ''}`}
            >
              <span className={`block bg-red-500 transition-all duration-150 ${recording ? 'h-[62px] w-[62px]' : 'h-[58px] w-[58px] rounded-full'}`} />
            </button>
            <span id="record-hint" className="mt-2 text-[11px] font-medium text-white/60">
              {recording ? 'Release to stop' : 'Hold to record'}
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

        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => fileRef.current?.click()}
            className="flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-semibold text-white/75 active:bg-white/10 disabled:opacity-35"
            aria-label="Import videos"
          >
            <Images size={18} /> Import
          </button>
          <div className="flex items-center gap-1 text-[11px] text-white/60">
            <Film size={13} aria-hidden="true" /> Local to this device
          </div>
          {hasClips ? (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setScreen('editor')}
              className="min-h-11 rounded-full px-3 text-xs font-semibold text-white/75 active:bg-white/10 disabled:opacity-35"
            >
              Timeline
            </button>
          ) : (
            <span className="w-[72px]" />
          )}
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
