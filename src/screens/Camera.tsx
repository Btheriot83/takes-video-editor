import { useCallback, useEffect, useRef, useState } from 'react';
import { FlipHorizontal2, Upload, Pause, Play, Film } from 'lucide-react';
import { getCameraStream, startRecording } from '../lib/recorder';
import type { ActiveRecording } from '../lib/recorder';
import { useStore } from '../state/store';
import { fmtTime, clipLen } from '../types/clip';

export default function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<ActiveRecording | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [streamReady, setStreamReady] = useState(false);

  const { clips, addClipFromBlob, importFiles, setScreen, total } = useStore();

  const openCamera = useCallback(async (f: 'user' | 'environment') => {
    setStreamReady(false);
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const s = await getCameraStream(f);
      streamRef.current = s;
      setStreamReady(true);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.play().catch(() => {});
      }
      setError(null);
    } catch (error: unknown) {
      setError(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Camera access was denied. Allow camera & mic permission and try again.'
          : 'Could not open a camera on this device.',
      );
    }
  }, []);

  useEffect(() => {
    openCamera(facing);
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing, openCamera]);

  // keep recording alive if the tab is hidden (iOS may freeze preview, not the recorder)
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && videoRef.current) videoRef.current.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const toggleRecord = async () => {
    if (recording) {
      setRecording(false);
      setPaused(false);
      const blob = await recRef.current?.stop();
      recRef.current = null;
      setElapsed(0);
      if (blob && blob.size > 0) {
        await addClipFromBlob(blob, blob.type);
      }
      return;
    }
    if (!streamRef.current) { setError('Camera is still starting — try again in a moment.'); return; }
    setStarting(true);
    console.log('[cam] startRecording begin');
    try {
      recRef.current = await startRecording(streamRef.current, setElapsed);
      console.log('[cam] startRecording ok');
      setRecording(true);
    } catch (err) {
      console.log('[cam] startRecording failed', String(err));
      setError('Recording is not supported in this browser.');
    } finally {
      setStarting(false);
    }
  };

  const flip = () => setFacing((f) => (f === 'user' ? 'environment' : 'user'));

  return (
    <div className="fixed inset-0 bg-black text-white select-none overflow-hidden">
      {/* live preview */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`}
      />

      {/* top bar */}
      <div className="absolute top-0 inset-x-0 pt-[env(safe-area-inset-top)] px-4 py-3 flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent">
        <div className="text-sm font-semibold tracking-wide text-white/90">Takes</div>
        <div className="flex items-center gap-2 text-sm tabular-nums">
          {recording && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
          <span className="text-white/90">{recording ? fmtTime(elapsed) : fmtTime(0)}</span>
          <span className="text-white/50">/ {fmtTime(total)}</span>
        </div>
      </div>

      {error && (
        <div className="absolute top-16 inset-x-4 bg-neutral-900/95 border border-neutral-700 rounded-xl p-4 text-sm text-center z-20">
          {error}
        </div>
      )}

      {/* bottom controls */}
      <div className="absolute bottom-0 inset-x-0 pb-[max(env(safe-area-inset-bottom),1rem)] bg-gradient-to-t from-black/70 via-black/30 to-transparent">
        {/* clip tray */}
        {clips.length > 0 && (
          <button
            onClick={() => setScreen('editor')}
            className="mx-auto mb-3 flex items-center gap-1.5 bg-neutral-900/80 backdrop-blur rounded-full pl-1.5 pr-3 py-1.5 border border-white/10 active:scale-95 transition"
          >
            <span className="flex -space-x-2">
              {clips.slice(0, 3).map((c) => (
                <span key={c.id} className="w-7 h-7 rounded-md overflow-hidden border border-black/60 bg-neutral-800">
                  {c.thumbs[0] && <img src={c.thumbs[0]} className="w-full h-full object-cover" alt="" />}
                </span>
              ))}
            </span>
            <span className="text-xs font-medium">
              {clips.length} clip{clips.length > 1 ? 's' : ''} · {fmtTime(clips.reduce((s, c) => s + clipLen(c), 0))} — Edit
            </span>
          </button>
        )}

        <div className="flex items-center justify-between px-8">
          {/* import */}
          <button
            onClick={() => fileRef.current?.click()}
            className="w-12 h-12 rounded-full bg-white/10 backdrop-blur flex items-center justify-center active:scale-90 transition"
            aria-label="Import video"
          >
            <Upload size={20} />
          </button>

          {/* record */}
          <button
            onClick={toggleRecord}
            disabled={starting || !streamReady || !!error}
            aria-label={recording ? 'Stop recording' : 'Start recording'}
            className="relative w-[76px] h-[76px] rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition disabled:opacity-40"
          >
            <span
              className={`block bg-red-500 transition-all duration-200 ${
                recording ? 'w-7 h-7 rounded-md' : 'w-[58px] h-[58px] rounded-full'
              }`}
            />
          </button>

          {/* flip / pause */}
          {recording ? (
            <button
              onClick={() => {
                if (!recRef.current) return;
                if (paused) { recRef.current.resume(); setPaused(false); }
                else { recRef.current.pause(); setPaused(true); }
              }}
              className="w-12 h-12 rounded-full bg-white/10 backdrop-blur flex items-center justify-center active:scale-90 transition"
              aria-label={paused ? 'Resume' : 'Pause'}
            >
              {paused ? <Play size={20} /> : <Pause size={20} />}
            </button>
          ) : (
            <button
              onClick={flip}
              className="w-12 h-12 rounded-full bg-white/10 backdrop-blur flex items-center justify-center active:scale-90 transition"
              aria-label="Flip camera"
            >
              <FlipHorizontal2 size={20} />
            </button>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) importFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {clips.length === 0 && !recording && !error && (
        <div className="absolute bottom-32 inset-x-0 text-center text-white/70 text-sm pointer-events-none px-8">
          Tap the red button to record your first clip
          <div className="mt-1 text-white/40 text-xs flex items-center justify-center gap-1">
            <Film size={12} /> or import videos with the left button
          </div>
        </div>
      )}
    </div>
  );
}
