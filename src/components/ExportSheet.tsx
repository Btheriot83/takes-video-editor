import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, Share2, CheckCircle2 } from 'lucide-react';
import { useStore } from '../state/store';
import { getBlob } from '../lib/db';
import { exportMp4, shareFile, downloadBlob } from '../lib/ffmpeg';
import { totalDuration, fmtTime, exportDimensions } from '../types/clip';
import { ASPECT_RATIOS } from '../types/clip';
import type { ExportQuality } from '../types/clip';

type Phase = 'idle' | 'working' | 'ready' | 'shared' | 'error';

export default function ExportSheet({ onClose, quality }: { onClose: () => void; quality: ExportQuality }) {
  const clips = useStore((s) => s.clips);
  const aspectRatio = useStore((s) => s.aspectRatio);
  const [phase, setPhase] = useState<Phase>('idle');
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<'native' | 'remuxed' | 'transcoded' | null>(null);
  const resultRef = useRef<Blob | null>(null);
  const startedRef = useRef(false);

  const filenameRef = useRef(`take-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`);
  const filename = filenameRef.current;

  const start = useCallback(async () => {
    setPhase('working');
    setError(null);
    try {
      const res = await exportMp4(clips, getBlob, aspectRatio, quality, (l, p) => { setLabel(l); setProgress(p); });
      resultRef.current = res.blob;
      setExportMode(res.mode);
      setPhase('ready');
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'Export failed');
      setPhase('error');
    }
  }, [aspectRatio, clips, quality]);

  const output = exportDimensions(aspectRatio, quality);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const timer = window.setTimeout(() => void start(), 0);
    return () => window.clearTimeout(timer);
  }, [start]);

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
      <div className="absolute inset-0 bg-black/70" onClick={phase !== 'working' ? onClose : undefined} />
      <div role="dialog" aria-modal="true" aria-labelledby="export-title"
        className="relative w-full sm:max-w-sm bg-neutral-900 rounded-t-2xl sm:rounded-2xl border border-white/10 p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
        <div className="flex items-center justify-between mb-4">
          <h2 id="export-title" className="font-semibold">Export video</h2>
          {phase !== 'working' && (
            <button onClick={onClose} className="p-1.5 rounded-lg active:bg-white/10" aria-label="Close">
              <X size={18} />
            </button>
          )}
        </div>

        <div className="text-sm text-white/60 mb-4 space-y-1">
          <div className="flex justify-between"><span>Format</span><span className="text-white/90">MP4 · H.264 + AAC</span></div>
          <div className="flex justify-between"><span>Frame</span><span className="text-white/90">{ASPECT_RATIOS[aspectRatio].outputLabel}</span></div>
          <div className="flex justify-between"><span>Export</span><span className="text-white/90">{quality} · {output.width} × {output.height}</span></div>
          <div className="text-[11px] leading-snug text-white/40">Export resolution is independent of camera capture. Source detail is limited by the device and browser.</div>
          <div className="flex justify-between"><span>Duration</span><span className="text-white/90">{fmtTime(totalDuration(clips))}</span></div>
          <div className="flex justify-between"><span>Watermark / metadata</span><span className="text-white/90">None</span></div>
        </div>

        {phase === 'idle' && <p className="text-sm text-white/60">Preparing your video…</p>}

        {phase === 'working' && (
          <div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-amber-400 transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="mt-2 text-xs text-white/60 flex justify-between">
              <span>{label}…</span><span>{Math.round(progress * 100)}%</span>
            </div>
            <p className="mt-3 text-[11px] text-white/40">Keep this tab open until the export finishes.</p>
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
              className="w-full bg-white text-black font-semibold py-3 rounded-xl active:scale-[0.98] flex items-center justify-center gap-2">
              <Share2 size={17} /> Share
            </button>
            <button onClick={download}
              className="w-full bg-white/10 font-medium py-3 rounded-xl active:scale-[0.98] flex items-center justify-center gap-2">
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
            <button onClick={start} className="w-full bg-white text-black font-semibold py-3 rounded-xl active:scale-[0.98]">
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
