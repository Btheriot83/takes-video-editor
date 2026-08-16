import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, Share2, CheckCircle2 } from 'lucide-react';
import { useStore } from '../state/store';
import { getBlob } from '../lib/db';
import { exportMp4, shareFile, downloadBlob } from '../lib/ffmpeg';
import { exportLogTail } from '../lib/export-log';
import { totalDuration, fmtTime, exportDimensions, isUltraHDCapture } from '../types/clip';
import { ASPECT_RATIOS } from '../types/clip';
import type { ExportQuality } from '../types/clip';

type Phase = 'idle' | 'working' | 'ready' | 'shared' | 'error';

const QUALITIES: ExportQuality[] = ['1080p', '4K'];

export default function ExportSheet({ onClose, quality, onQualityChange, onExportStart, onExportEnd }: {
  onClose: () => void;
  quality: ExportQuality;
  onQualityChange: (quality: ExportQuality) => void;
  /** Called before an export starts — the editor parks its preview players. */
  onExportStart?: () => void;
  /** Called when the export settles (success, error, or cancel). */
  onExportEnd?: () => void;
}) {
  const clips = useStore((s) => s.clips);
  const aspectRatio = useStore((s) => s.aspectRatio);
  const [phase, setPhase] = useState<Phase>('idle');
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<'native' | 'remuxed' | 'transcoded' | null>(null);
  const resultRef = useRef<Blob | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const filenameRef = useRef(`take-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`);
  const filename = filenameRef.current;

  const start = useCallback(async () => {
    setPhase('working');
    setError(null);
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    onExportStart?.();
    try {
      const res = await exportMp4(clips, getBlob, aspectRatio, quality,
        (l, p) => { setLabel(l); setProgress(p); }, controller.signal);
      resultRef.current = res.blob;
      setExportMode(res.mode);
      setPhase('ready');
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Cancelled by the user: back to the choose-quality state.
        setPhase('idle');
        return;
      }
      setError(error instanceof Error ? error.message : 'Export failed');
      setPhase('error');
    } finally {
      abortRef.current = null;
      onExportEnd?.();
    }
  }, [aspectRatio, clips, quality, onExportStart, onExportEnd]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Closing while an export runs cancels it first, so the sheet never traps
  // the user behind a running export.
  const requestClose = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    onClose();
  }, [onClose]);

  // An abandoned unmount (parent closed the sheet) must not leave an export
  // burning CPU in the background.
  useEffect(() => () => abortRef.current?.abort(), []);

  const output = exportDimensions(aspectRatio, quality);

  // The quality decision lives here, where the export starts; Escape always
  // closes the sheet, cancelling a running export on the way out.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const share = async () => {
    if (!resultRef.current) return;
    setHandoffNotice(null);
    const r = await shareFile(resultRef.current, filename);
    if (r === 'shared') setPhase('shared');
    else if (r === 'cancelled') setHandoffNotice('Share cancelled. Your source clips are still saved in this session.');
    else if (r === 'unavailable') setHandoffNotice('File sharing is unavailable here. Use Download MP4 instead.');
    else setHandoffNotice('The share handoff failed. Try again or use Download MP4.');
  };

  const download = () => {
    if (!resultRef.current) return;
    const requested = downloadBlob(resultRef.current, filename);
    setHandoffNotice(requested
      ? 'Download requested. On iPhone, check Files › Downloads. The browser cannot confirm placement in Photos.'
      : 'The browser could not start the download. Try Share instead.');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* While an export runs, a stray backdrop tap must not silently discard
          minutes of encoding — cancelling stays an explicit act (Cancel/X). */}
      <div className="absolute inset-0 bg-black/70" onClick={phase === 'working' ? undefined : requestClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="export-title"
        className="relative w-full sm:max-w-sm bg-neutral-900 rounded-t-2xl sm:rounded-2xl border border-white/10 p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
        <div className="flex items-center justify-between mb-4">
          <h2 id="export-title" className="font-semibold">Export video</h2>
          <button onClick={requestClose}
            className="-m-2 flex h-11 w-11 items-center justify-center rounded-lg active:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="text-sm text-white/60 mb-4 space-y-1">
          <div className="flex justify-between"><span>Format</span><span className="text-white/90">MP4 · H.264 + AAC</span></div>
          <div className="flex justify-between"><span>Frame</span><span className="text-white/90">{ASPECT_RATIOS[aspectRatio].outputLabel}</span></div>
          <div className="flex justify-between"><span>Export</span><span className="text-white/90">{quality} · {output.width} × {output.height}</span></div>
          <div className="text-[11px] leading-snug text-white/55">Export resolution is independent of camera capture. Source detail is limited by the device and browser.</div>
          <div className="flex justify-between"><span>Duration</span><span className="text-white/90">{fmtTime(totalDuration(clips))}</span></div>
          <div className="flex justify-between"><span>Watermark / metadata</span><span className="text-white/90">None</span></div>
        </div>

        {(phase === 'idle' || phase === 'error') && (
          <div className="mb-4">
            <div className="mb-1.5 text-sm text-white/60">Quality</div>
            <div className="flex w-full items-center rounded-full bg-white/10 p-0.5" role="group" aria-label="Export quality">
              {QUALITIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={quality === option}
                  onClick={() => onQualityChange(option)}
                  className={`min-h-11 flex-1 rounded-full px-2 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                    quality === option ? 'bg-white text-black' : 'text-white/70'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-white/55">1080p exports faster. 4K is larger and can take much longer on this device.</p>
            {/* 4K-capture clips can export at 4K instantly (no re-encode);
                HD-capture clips forced to 4K take the slow upscale render.
                Say so before the user commits to the wait. */}
            {quality === '4K' && !clips.some((c) => isUltraHDCapture(c.width, c.height)) && (
              <p data-upscale-hint className="mt-1.5 text-[11px] leading-snug text-amber-300/90">
                Recorded in 1080p — 4K will upscale and render slower. Record with the 4K camera toggle for instant 4K export.
              </p>
            )}
          </div>
        )}

        {phase === 'idle' && (
          <button onClick={() => void start()}
            className="w-full bg-white text-black font-semibold py-3 rounded-xl active:scale-[0.98] flex items-center justify-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
            <Download size={17} /> Start export
          </button>
        )}

        {phase === 'working' && (
          <div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-amber-400 transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="mt-2 text-xs text-white/60 flex justify-between">
              <span>{label}…</span><span>{Math.round(progress * 100)}%</span>
            </div>
            <p className="mt-3 text-[11px] text-white/60">Keep this tab open until the export finishes.</p>
            <button onClick={cancel}
              className="mt-3 w-full bg-white/10 font-medium py-3 rounded-xl active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              Cancel export
            </button>
          </div>
        )}

        {phase === 'ready' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <CheckCircle2 size={18} /> Video ready to share or download
            </div>
            <p className="text-xs text-white/50">
              {exportMode === 'native' && 'Camera original preserved without re-encoding.'}
              {exportMode === 'remuxed' && 'Clips joined without re-encoding.'}
              {exportMode === 'transcoded' && `Rendered at ${quality} output resolution.`}
            </p>
            <button onClick={share}
              className="w-full bg-white text-black font-semibold py-3 rounded-xl active:scale-[0.98] flex items-center justify-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <Share2 size={17} /> Save to Photos / Share
            </button>
            <p className="text-[11px] leading-snug text-white/50">
              Opens the system sheet — save to Photos, iCloud Drive, Google Drive, AirDrop, or send it anywhere.
            </p>
            <button onClick={download}
              className="w-full bg-white/10 font-medium py-3 rounded-xl active:scale-[0.98] flex items-center justify-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <Download size={17} /> Download MP4
            </button>
            {handoffNotice && <p role="status" className="text-xs leading-relaxed text-white/55">{handoffNotice}</p>}
          </div>
        )}

        {phase === 'shared' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <CheckCircle2 size={18} /> Share handoff completed
            </div>
            <p className="text-xs leading-relaxed text-white/50">The operating system completed the share action. Takes cannot see which destination you chose.</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-2">
            <p className="text-sm text-red-400">{error}</p>
            {/* The breadcrumb tail turns a field failure report (often a
                screenshot from a phone) into an actionable diagnosis. */}
            <details className="text-[10px] text-white/40">
              <summary className="cursor-pointer select-none py-1">Technical details</summary>
              <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 leading-relaxed">{exportLogTail().join('\n') || 'no log entries'}</pre>
            </details>
            <button onClick={() => void start()}
              className="w-full bg-white text-black font-semibold py-3 rounded-xl active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
