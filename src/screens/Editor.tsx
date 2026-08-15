import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Undo2, Redo2, Scissors, Copy, Trash2, Play, Share2, Plus,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useStore } from '../state/store';
import { ASPECT_RATIOS, clipLen, totalDuration, fmtTime, FRAME } from '../types/clip';
import type { Clip } from '../types/clip';
import { getBlob } from '../lib/db';
import { locate, clipStart } from '../lib/editor';
import ExportSheet from '../components/ExportSheet';

const PX_PER_SEC = 44;

export default function Editor() {
  const {
    clips, selectedId, select, setScreen, playhead, setPlayhead,
    undo, redo, canUndo, canRedo, splitSelected, deleteSelected, duplicateSelected,
    trimSelected, reorder, importFiles,
    aspectRatio,
  } = useStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [clipUrls, setClipUrls] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const total = useMemo(() => totalDuration(clips), [clips]);
  const selected = clips.find((c) => c.id === selectedId) ?? null;
  const selIdx = clips.findIndex((c) => c.id === selectedId);

  // object URLs for all clips
  useEffect(() => {
    let alive = true;
    (async () => {
      const urls: Record<string, string> = {};
      for (const c of clips) {
        if (clipUrls[c.blobKey]) { urls[c.blobKey] = clipUrls[c.blobKey]; continue; }
        const b = await getBlob(c.blobKey);
        if (b) urls[c.blobKey] = URL.createObjectURL(b);
      }
      if (alive) setClipUrls((prev) => {
        Object.values(prev).forEach((u) => { if (!Object.values(urls).includes(u)) URL.revokeObjectURL(u); });
        return urls;
      });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.map((c) => c.blobKey).join(',')]);

  // position video element at playhead
  const syncVideo = useCallback(async (t: number, autoplay = false) => {
    const v = videoRef.current;
    const loc = locate(clips, t);
    if (!v || !loc) return;
    const clip = clips[loc.index];
    const url = clipUrls[clip.blobKey];
    if (!url) return;
    if (urlRef.current !== url) {
      urlRef.current = url;
      v.src = url;
      await new Promise<void>((res) => {
        if (v.readyState >= 1) return res();
        v.onloadedmetadata = () => res();
      });
    }
    v.currentTime = clip.trimIn + loc.offset;
    if (autoplay) v.play().catch(() => {});
  }, [clips, clipUrls]);

  useEffect(() => { syncVideo(playhead); }, [playhead, selectedId, syncVideo]);

  // playback loop across clips
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const loc = locate(clips, playheadRef.current);
      if (!loc) return;
      const clip = clips[loc.index];
      if (urlRef.current !== clipUrls[clip.blobKey]) return; // src switched; onTime from old
      const offset = v.currentTime - clip.trimIn;
      const global = clipStart(clips, loc.index) + Math.max(0, offset);
      setPlayhead(global);
      if (v.currentTime >= clip.trimOut - 0.02) {
        const nextIdx = loc.index + 1;
        if (nextIdx < clips.length) {
          select(clips[nextIdx].id);
          syncVideo(clipStart(clips, nextIdx), true);
        } else {
          setPlaying(false);
          v.pause();
        }
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [clips, clipUrls, select, setPlayhead, syncVideo]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  const togglePlay = async () => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
    } else {
      if (playhead >= total - 0.05) setPlayhead(0);
      await syncVideo(playhead >= total - 0.05 ? 0 : playhead, true);
      setPlaying(true);
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => setPlaying(false);
    v.addEventListener('pause', onPause);
    return () => v.removeEventListener('pause', onPause);
  }, []);

  return (
    <div className="fixed inset-0 bg-neutral-950 text-white flex flex-col select-none">
      {/* header */}
      <div className="pt-[env(safe-area-inset-top)] px-3 py-2.5 flex items-center justify-between border-b border-white/10">
        <button onClick={() => { setPlaying(false); setScreen('camera'); }}
          className="flex items-center gap-1 text-sm text-white/80 active:opacity-60 px-2 py-1.5">
          <ArrowLeft size={18} /> Camera
        </button>
        <div className="text-center text-sm tabular-nums text-white/70">
          <div>{fmtTime(playhead)} <span className="text-white/40">/ {fmtTime(total)}</span></div>
          <div className="text-[10px] font-semibold text-white/45">{aspectRatio}</div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={undo} disabled={!canUndo} aria-label="Undo"
            className="p-2 rounded-lg active:bg-white/10 disabled:opacity-30"><Undo2 size={18} /></button>
          <button onClick={redo} disabled={!canRedo} aria-label="Redo"
            className="p-2 rounded-lg active:bg-white/10 disabled:opacity-30"><Redo2 size={18} /></button>
          <button onClick={() => setExportOpen(true)} disabled={!clips.length}
            className="ml-1 bg-white text-black text-sm font-semibold px-3.5 py-1.5 rounded-full active:scale-95 disabled:opacity-30 flex items-center gap-1.5">
            <Share2 size={15} /> Export
          </button>
        </div>
      </div>

      {/* preview */}
      <div className="relative flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
        <div className="relative max-h-full max-w-full overflow-hidden bg-neutral-900" style={{
          aspectRatio: ASPECT_RATIOS[aspectRatio].css,
          height: aspectRatio === '16:9' ? '100%' : 'auto',
          width: aspectRatio === '16:9' ? 'auto' : '100%',
        }}>
          <video ref={videoRef} playsInline className="absolute inset-0 h-full w-full object-cover" />
        </div>
        <button onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center group"
          aria-label={playing ? 'Pause' : 'Play'}>
          {!playing && (
            <span className="w-16 h-16 rounded-full bg-black/60 backdrop-blur flex items-center justify-center border border-white/20">
              <Play size={26} className="ml-1" />
            </span>
          )}
        </button>
      </div>

      {/* action row */}
      <div className="px-3 py-2 flex items-center justify-center gap-2 border-t border-white/10">
        <Action icon={<Scissors size={17} />} label="Split" onClick={splitSelected} disabled={!selected || playing} />
        <Action icon={<Copy size={17} />} label="Duplicate" onClick={duplicateSelected} disabled={!selected} />
        <Action icon={<Trash2 size={17} />} label="Delete" onClick={deleteSelected} disabled={!selected} />
        <Action icon={<Plus size={17} />} label="Import" onClick={() => fileRef.current?.click()} disabled={false} />
        {selected && (
          <div className="flex items-center gap-1 ml-1 border-l border-white/10 pl-2">
            <button aria-label="Trim in -1 frame" className="p-1.5 active:bg-white/10 rounded"
              onClick={() => trimSelected(selected.trimIn - FRAME, selected.trimOut)}>
              <ChevronLeft size={16} /></button>
            <span className="text-[11px] tabular-nums text-white/60 w-14 text-center">
              {clipLen(selected).toFixed(2)}s
            </span>
            <button aria-label="Trim in +1 frame" className="p-1.5 active:bg-white/10 rounded"
              onClick={() => trimSelected(selected.trimIn + FRAME, selected.trimOut)}>
              <ChevronRight size={16} /></button>
          </div>
        )}
      </div>

      {/* timeline */}
      <Timeline
        clips={clips}
        selectedId={selectedId}
        playhead={playhead}
        onSelect={(id, offset) => { select(id); setPlayhead(clipStart(clips, clips.findIndex((c) => c.id === id)) + offset); syncVideo(clipStart(clips, clips.findIndex((c) => c.id === id)) + offset); }}
        trimSelected={trimSelected}
        onReorder={reorder}
        selIdx={selIdx}
      />

      <input ref={fileRef} type="file" accept="video/*" multiple hidden
        onChange={(e) => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />

      {exportOpen && <ExportSheet onClose={() => setExportOpen(false)} />}
    </div>
  );
}

function Action({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-lg active:bg-white/10 disabled:opacity-30 min-w-[56px]">
      {icon}
      <span className="text-[10px] text-white/70">{label}</span>
    </button>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

function Timeline({
  clips, selectedId, playhead, onSelect, trimSelected, onReorder, selIdx,
}: {
  clips: Clip[];
  selectedId: string | null;
  playhead: number;
  onSelect: (id: string, offset: number) => void;
  trimSelected: (ti: number, to: number) => void;
  onReorder: (from: number, to: number) => void;
  selIdx: number;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ idx: number; startX: number; mode: 'none' | 'maybe' | 'move'; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const trimDrag = useRef<{ side: 'in' | 'out'; startX: number; origIn: number; origOut: number } | null>(null);

  const width = (c: Clip) => Math.max(48, clipLen(c) * PX_PER_SEC);

  const onClipPointerDown = (e: React.PointerEvent, idx: number) => {
    if (trimDrag.current) return;
    const startX = e.clientX;
    dragState.current = {
      idx, startX, mode: 'maybe',
      timer: setTimeout(() => {
        if (dragState.current) { dragState.current.mode = 'move'; setDragIdx(idx); }
      }, 350),
    };

    const onMove = (ev: PointerEvent) => {
      const st = dragState.current;
      if (!st) return;
      if (st.mode === 'maybe' && Math.abs(ev.clientX - st.startX) > 8) {
        clearTimeout(st.timer);
        dragState.current = null;
      }
      if (st.mode === 'move') {
        // target index by pointer x over strip
        const strip = stripRef.current!;
        const children = Array.from(strip.querySelectorAll<HTMLElement>('[data-clip]'));
        let target = children.length - 1;
        for (let i = 0; i < children.length; i++) {
          const r = children[i].getBoundingClientRect();
          if (ev.clientX < r.left + r.width / 2) { target = i; break; }
        }
        if (target !== st.idx) {
          onReorder(st.idx, target);
          st.idx = target;
          setDragIdx(target);
        }
      }
    };
    const onUp = () => {
      if (dragState.current) clearTimeout(dragState.current.timer);
      if (dragState.current?.mode !== 'move') {
        // simple tap → select & move playhead to clip start
        onSelect(clips[idx].id, 0);
      }
      dragState.current = null;
      setDragIdx(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onHandleDown = (e: React.PointerEvent, side: 'in' | 'out') => {
    e.stopPropagation();
    const clip = clips[selIdx];
    if (!clip) return;
    trimDrag.current = { side, startX: e.clientX, origIn: clip.trimIn, origOut: clip.trimOut };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const td = trimDrag.current;
      if (!td) return;
      const dt = (ev.clientX - td.startX) / PX_PER_SEC;
      // snap to frame
      const snapped = Math.round(dt / FRAME) * FRAME;
      if (td.side === 'in') trimSelected(td.origIn + snapped, td.origOut);
      else trimSelected(td.origIn, td.origOut + snapped);
    };
    const onUp = () => {
      trimDrag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const playheadX = playhead * PX_PER_SEC;

  return (
    <div className="border-t border-white/10 bg-neutral-900/60 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
      <div className="text-[10px] text-white/40 px-3 pt-1.5 flex justify-between">
        <span>Tap to select · drag edges to trim · hold &amp; drag to reorder</span>
      </div>
      <div ref={stripRef} className="relative overflow-x-auto overflow-y-hidden px-3 py-2 flex items-center gap-1 min-h-[76px]">
        {clips.map((c, i) => {
          const w = width(c);
          const selected = c.id === selectedId;
          return (
            <div
              key={c.id}
              data-clip
              onPointerDown={(e) => onClipPointerDown(e, i)}
              className={`relative shrink-0 h-14 rounded-lg overflow-hidden border-2 transition-colors touch-none
                ${selected ? 'border-amber-400' : 'border-white/15'}
                ${dragIdx === i ? 'opacity-60 scale-95' : ''}`}
              style={{ width: w }}
            >
              <div className="absolute inset-0 flex">
                {c.thumbs.length > 0 ? (
                  Array.from({ length: Math.max(1, Math.round(w / 44)) }).map((_, k) => (
                    <img key={k} src={c.thumbs[k % c.thumbs.length]} alt=""
                      className="h-full flex-1 object-cover pointer-events-none" draggable={false} />
                  ))
                ) : (
                  <div className="w-full h-full bg-neutral-800" />
                )}
              </div>
              <span className="absolute bottom-0.5 right-1 text-[9px] tabular-nums bg-black/60 rounded px-1">
                {clipLen(c).toFixed(1)}s
              </span>
              {selected && (
                <>
                  <div onPointerDown={(e) => onHandleDown(e, 'in')}
                    className="absolute left-0 top-0 bottom-0 w-4 bg-amber-400 flex items-center justify-center cursor-ew-resize">
                    <div className="w-0.5 h-5 bg-black/70 rounded" />
                  </div>
                  <div onPointerDown={(e) => onHandleDown(e, 'out')}
                    className="absolute right-0 top-0 bottom-0 w-4 bg-amber-400 flex items-center justify-center cursor-ew-resize">
                    <div className="w-0.5 h-5 bg-black/70 rounded" />
                  </div>
                </>
              )}
            </div>
          );
        })}
        {/* playhead */}
        <div className="absolute top-1 bottom-1 w-0.5 bg-white pointer-events-none"
          style={{ left: 12 + playheadX }} />
      </div>
    </div>
  );
}
