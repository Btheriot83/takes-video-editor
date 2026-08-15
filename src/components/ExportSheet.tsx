import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, Share2, CheckCircle2 } from 'lucide-react';
import { useStore } from '../state/store';
import { getBlob } from '../lib/db';
import { exportMp4, shareFile, downloadBlob } from '../lib/ffmpeg';
import { totalDuration, fmtTime } from '../types/clip';
import { ASPECT_RATIOS } from '../types/clip';

type Phase = 'idle' | 'working' | 'done' | 'error';

export default function ExportSheet({ onClose }: { onClose: () => void }) {
  const clips = useStore((s) => s.clips);
  const aspectRatio = useStore((s) => s.aspectRatio);
  const [phase, setPhase] = useState<Phase>('idle');
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<Blob | null>(null);
  const startedRef = useRef(false);

  const filenameRef = useRef(`take-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`);
  const filename = filenameRef.current;

  const start = useCallback(async () => {
    setPhase('working');
    setError(null);
    try {
      const res = await exportMp4(clips, getBlob, aspectRatio, (l, p) => { setLabel(l); setProgress(p); });
      resultRef.current = res.blob;
      downloadBlob(res.blob, filename);
      setPhase('done');
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'Export failed');
      setPhase('error');
    }
  }, [aspectRatio, clips, filename]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const timer = window.setTimeout(() => void start(), 0);
    return () => window.clearTimeout(timer);
  }, [start]);

  const share = async () => {
    if (!resultRef.current) return;
    const r = await shareFile(resultRef.current, filename);
    if (r === 'unavailable') downloadBlob(resultRef.current, filename);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={phase !== 'working' ? onClose : undefined} />
      <div role="dialog" aria-modal="true" aria-labelledby="export-title"
        className="relative w-full sm:max-w-sm bg-neutral-900 rounded-t-2xl sm:rounded-2xl border border-white/10 p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
        <div className="flex items-center justify-between mb-4">
          <h2 id="export-title" className="font-semibold">Save video</h2>
          {phase !== 'working' && (
            <button onClick={onClose} className="p-1.5 rounded-lg active:bg-white/10" aria-label="Close">
              <X size={18} />
            </button>
          )}
        </div>

        <div className="text-sm text-white/60 mb-4 space-y-1">
          <div className="flex justify-between"><span>Format</span><span className="text-white/90">MP4 · H.264 + AAC</span></div>
          <div className="flex justify-between"><span>Frame</span><span className="text-white/90">{ASPECT_RATIOS[aspectRatio].outputLabel}</span></div>
          <div className="flex justify-between"><span>Resolution</span><span className="text-white/90">{ASPECT_RATIOS[aspectRatio].width} × {ASPECT_RATIOS[aspectRatio].height}</span></div>
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

        {phase === 'done' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <CheckCircle2 size={18} /> Saved to this device
            </div>
            <button onClick={share}
              className="w-full bg-white text-black font-semibold py-3 rounded-xl active:scale-[0.98] flex items-center justify-center gap-2">
              <Share2 size={17} /> Share
            </button>
            <button onClick={() => resultRef.current && downloadBlob(resultRef.current, filename)}
              className="w-full bg-white/10 font-medium py-3 rounded-xl active:scale-[0.98] flex items-center justify-center gap-2">
              <Download size={17} /> Download MP4
            </button>
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
