import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Undo2, Redo2, Scissors, Copy, Trash2, Play, Download, Plus,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useStore } from '../state/store';
import { ASPECT_RATIOS, clipLen, totalDuration, fmtTime, FRAME, exportDimensions, isUltraHDCapture } from '../types/clip';
import type { Clip, ExportQuality } from '../types/clip';
import { getBlob } from '../lib/db';
import { locate, clipStart } from '../lib/editor';
import ExportSheet from '../components/ExportSheet';

const PX_PER_SEC = 44;
// How far before a clip boundary the preloaded slot starts playing muted, so
// the swap at the boundary is a mute/visibility flip instead of a cold play().
const PREROLL_SEC = 0.1;
type VideoSlot = 0 | 1;

function waitForMedia(v: HTMLVideoElement, timeoutMs = 1800): Promise<void> {
  if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timeout);
      v.removeEventListener('canplay', done);
      v.removeEventListener('error', done);
      resolve();
    };
    const timeout = window.setTimeout(done, timeoutMs);
    v.addEventListener('canplay', done, { once: true });
    v.addEventListener('error', done, { once: true });
  });
}

function seekMedia(v: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(v.currentTime - time) < 0.02) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timeout);
      v.removeEventListener('seeked', done);
      resolve();
    };
    const timeout = window.setTimeout(done, 900);
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  });
}

export default function Editor() {
  const {
    clips, selectedId, select, setScreen, playhead, setPlayhead,
    undo, redo, canUndo, canRedo, splitSelected, deleteSelected, duplicateSelected,
    trimSelected, reorder, importFiles,
    aspectRatio,
  } = useStore();

  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const activeSlotRef = useRef<VideoSlot>(0);
  const activeIndexRef = useRef(0);
  const slotIndexRef = useRef<[number | null, number | null]>([null, null]);
  const handoffRef = useRef(false);
  // Index of the clip currently pre-rolling (playing muted in the spare slot
  // just before its boundary), or null when no pre-roll is in flight.
  const prerollForRef = useRef<number | null>(null);
  const lastUiUpdateRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [activeSlot, setActiveSlot] = useState<VideoSlot>(0);
  const [handoffGapMs, setHandoffGapMs] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Export quality defaults to the highest source class: 4K only when a clip
  // actually carries 4K-class frames, else 1080p so all-HD projects keep the
  // native/remux fast paths instead of a forced upscale transcode. An explicit
  // user choice always wins.
  const exportQualityTouchedRef = useRef(false);
  const [exportQuality, setExportQuality] = useState<ExportQuality>('1080p');
  const [clipUrls, setClipUrls] = useState<Record<string, string>>({});
  const clipUrlsRef = useRef<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  clipUrlsRef.current = clipUrls;

  useEffect(() => () => {
    Object.values(clipUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    clipUrlsRef.current = {};
  }, []);

  useEffect(() => {
    if (exportQualityTouchedRef.current) return;
    setExportQuality(clips.some((c) => isUltraHDCapture(c.width, c.height)) ? '4K' : '1080p');
  }, [clips]);

  const setLastExportQuality = useStore((s) => s.setLastExportQuality);
  const chooseExportQuality = useCallback((quality: ExportQuality) => {
    exportQualityTouchedRef.current = true;
    setExportQuality(quality);
    // Remembered so the Camera screen can nudge habitual 4K exporters toward
    // 4K capture (which unlocks the instant no-re-encode export paths).
    setLastExportQuality(quality);
  }, [setLastExportQuality]);

  const total = useMemo(() => totalDuration(clips), [clips]);
  const selected = clips.find((c) => c.id === selectedId) ?? null;
  const selIdx = clips.findIndex((c) => c.id === selectedId);
  const output = exportDimensions(aspectRatio, exportQuality);

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

  const loadSlot = useCallback(async (slot: VideoSlot, index: number, offset = 0) => {
    const v = videoRefs.current[slot];
    const clip = clips[index];
    const url = clip && clipUrls[clip.blobKey];
    if (!v || !clip || !url) return false;
    if (slotIndexRef.current[slot] !== index || v.src !== url) {
      v.pause();
      v.muted = slot !== activeSlotRef.current;
      v.src = url;
      v.load();
      slotIndexRef.current[slot] = index;
      await waitForMedia(v);
    }
    await seekMedia(v, clip.trimIn + offset);
    return v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }, [clips, clipUrls]);

  const preloadAfter = useCallback((index: number) => {
    const nextIndex = index + 1;
    if (nextIndex >= clips.length) return;
    const slot = (activeSlotRef.current === 0 ? 1 : 0) as VideoSlot;
    void (async () => {
      if (!await loadSlot(slot, nextIndex, 0)) return;
      const v = videoRefs.current[slot];
      if (!v || activeSlotRef.current === slot || slotIndexRef.current[slot] !== nextIndex) return;
      // Prime the decoder: a muted play()+pause() spins up the decode pipeline
      // now, so the boundary swap doesn't pay that cost. Skip the pause if a
      // pre-roll grabbed this slot while the play() promise was in flight, and
      // bail entirely if a scrub made this slot active in the meantime.
      try {
        v.muted = true;
        await v.play();
        if (activeSlotRef.current === slot) return;
        if (prerollForRef.current !== nextIndex) {
          v.pause();
          await seekMedia(v, clips[nextIndex].trimIn);
        }
      } catch { /* autoplay refused or load interrupted; handoff still works, just colder */ }
    })();
  }, [clips, loadSlot]);

  // Position one video while the second slot preloads the adjacent clip.
  const syncVideo = useCallback(async (t: number, autoplay = false) => {
    const loc = locate(clips, t);
    if (!loc) return;
    const loadedSlot = slotIndexRef.current.findIndex((index) => index === loc.index);
    const slot = (loadedSlot >= 0 ? loadedSlot : activeSlotRef.current) as VideoSlot;
    prerollForRef.current = null;
    videoRefs.current.forEach((video) => video?.pause());
    if (!await loadSlot(slot, loc.index, loc.offset)) return;
    activeSlotRef.current = slot;
    activeIndexRef.current = loc.index;
    setActiveSlot(slot);
    videoRefs.current.forEach((video, index) => { if (video) video.muted = index !== slot; });
    if (autoplay) {
      try { await videoRefs.current[slot]?.play(); } catch { return; }
    }
    preloadAfter(loc.index);
  }, [clips, loadSlot, preloadAfter]);

  // External scrubs/selections seek the media element. Native playback owns
  // currentTime while playing; seeking it again after every timeupdate turns
  // playback into a slow seek loop on mobile browsers.
  useEffect(() => {
    if (!playing) void syncVideo(playhead);
  }, [playhead, selectedId, playing, syncVideo]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  // During an export the preview players are parked (sources unloaded): two
  // AVPlayer-backed elements with loaded data pin decoder/GPU resources that
  // the export's own 4K decoder+encoder need on iOS.
  const parkPreviews = useCallback(() => {
    setPlaying(false);
    prerollForRef.current = null;
    videoRefs.current.forEach((video) => {
      if (!video) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
    });
    slotIndexRef.current = [null, null];
  }, []);

  const resumePreviews = useCallback(() => {
    void syncVideo(playheadRef.current);
  }, [syncVideo]);

  // Start the preloaded slot playing muted shortly before the boundary so the
  // handoff itself is just a mute/visibility flip.
  const preroll = useCallback((nextIndex: number) => {
    if (prerollForRef.current === nextIndex || handoffRef.current) return;
    const slot = (activeSlotRef.current === 0 ? 1 : 0) as VideoSlot;
    const incoming = videoRefs.current[slot];
    if (!incoming || slotIndexRef.current[slot] !== nextIndex) return;
    if (incoming.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
    prerollForRef.current = nextIndex;
    incoming.muted = true;
    if (incoming.paused) {
      incoming.play().catch(() => {
        if (prerollForRef.current === nextIndex) prerollForRef.current = null;
      });
    }
  }, []);

  const handoff = useCallback(async (fromIndex: number) => {
    if (handoffRef.current) return;
    const nextIndex = fromIndex + 1;
    if (nextIndex >= clips.length) return;
    handoffRef.current = true;
    // The timer starts at boundary detection so the reported gap includes any
    // cold load/seek work — it must stay honest about what the viewer saw.
    const boundaryStarted = performance.now();
    const fromSlot = activeSlotRef.current;
    const toSlot = (fromSlot === 0 ? 1 : 0) as VideoSlot;
    let incoming = videoRefs.current[toSlot];
    const warm = !!incoming && slotIndexRef.current[toSlot] === nextIndex
      && incoming.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (!warm) {
      // Cold path (preload failed or was interrupted): load and seek now.
      await loadSlot(toSlot, nextIndex, 0);
      incoming = videoRefs.current[toSlot];
    }
    if (!incoming) { handoffRef.current = false; return; }
    const outgoing = videoRefs.current[fromSlot];
    // Swap synchronously: unmute the (already playing, pre-rolled) incoming
    // slot first, then silence the outgoing one — a few ms of overlap beats a
    // few ms of gap.
    incoming.muted = false;
    if (outgoing) { outgoing.muted = true; outgoing.pause(); }
    activeSlotRef.current = toSlot;
    activeIndexRef.current = nextIndex;
    setActiveSlot(toSlot);
    select(clips[nextIndex].id);
    setPlayhead(clipStart(clips, nextIndex));
    try {
      if (incoming.paused) await incoming.play();
      setHandoffGapMs(performance.now() - boundaryStarted);
    } catch {
      setPlaying(false);
    }
    prerollForRef.current = null;
    handoffRef.current = false;
    preloadAfter(nextIndex);
  }, [clips, loadSlot, preloadAfter, select, setPlayhead]);

  // Frame-timed playback avoids the coarse 200–250ms cadence of timeupdate.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (now: number) => {
      const index = activeIndexRef.current;
      const clip = clips[index];
      const v = videoRefs.current[activeSlotRef.current];
      if (!clip || !v) return;
      const global = clipStart(clips, index) + Math.max(0, v.currentTime - clip.trimIn);
      playheadRef.current = global;
      if (now - lastUiUpdateRef.current >= 80) {
        lastUiUpdateRef.current = now;
        setPlayhead(global);
      }
      if (index + 1 < clips.length && v.currentTime >= clip.trimOut - PREROLL_SEC) {
        preroll(index + 1);
      }
      if (v.currentTime >= clip.trimOut - FRAME / 2) {
        if (index + 1 < clips.length) void handoff(index);
        else {
          v.pause();
          setPlayhead(totalDuration(clips));
          setPlaying(false);
          return;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [clips, handoff, playing, preroll, setPlayhead]);

  // iOS WebKit grants audible playback per media element per user gesture.
  // The spare slot only ever plays muted before a handoff unmutes it, so
  // without its own activation iOS would pause it at the first clip boundary.
  // Inside the first play gesture, synchronously run an unmuted play()+pause()
  // on both slot elements at volume 0: each gains its per-element activation
  // for the session with no audible glitch. Once per element per mount.
  const gestureActivatedRef = useRef(false);
  const activateSlotsInGesture = () => {
    if (gestureActivatedRef.current) return;
    gestureActivatedRef.current = true;
    videoRefs.current.forEach((video) => {
      if (!video) return;
      const wasMuted = video.muted;
      const wasVolume = video.volume;
      try {
        video.volume = 0;
        video.muted = false;
        const activation = video.play();
        video.pause();
        activation?.catch(() => { /* no source yet or aborted by the pause */ });
      } catch { /* element not ready; normal playback still activates it */ }
      video.muted = wasMuted;
      video.volume = wasVolume;
    });
  };

  const togglePlay = async () => {
    if (playing) {
      prerollForRef.current = null;
      videoRefs.current.forEach((video) => video?.pause());
      setPlaying(false);
    } else {
      activateSlotsInGesture();
      if (playhead >= total - 0.05) setPlayhead(0);
      await syncVideo(playhead >= total - 0.05 ? 0 : playhead, true);
      setPlaying(true);
    }
  };

  return (
    <div data-editor-playhead={playhead.toFixed(3)} data-editor-active-slot={activeSlot}
      data-last-handoff-gap-ms={handoffGapMs?.toFixed(1) ?? ''}
      className="fixed inset-0 bg-neutral-950 text-white flex flex-col select-none">
      {/* header */}
      <div className="pt-[env(safe-area-inset-top)] px-2 py-1.5 flex items-center justify-between gap-1 border-b border-white/10">
        <button onClick={() => { videoRefs.current.forEach((video) => video?.pause()); setPlaying(false); setScreen('camera'); }}
          aria-label="Back to camera"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/80 active:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
          <ArrowLeft size={20} />
        </button>
        <div className="whitespace-nowrap text-center text-xs min-[360px]:text-sm tabular-nums text-white/70">
          {fmtTime(playhead)} <span className="text-white/55">/ {fmtTime(total)}</span>
        </div>
        <div className="flex shrink-0 items-center">
          <button onClick={undo} disabled={!canUndo} aria-label="Undo"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg active:bg-white/10 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"><Undo2 size={18} /></button>
          <button onClick={redo} disabled={!canRedo} aria-label="Redo"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg active:bg-white/10 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"><Redo2 size={18} /></button>
          <button onClick={() => setExportOpen(true)} disabled={!clips.length}
            className="ml-1 flex min-h-11 items-center gap-1.5 rounded-full bg-white px-3.5 text-sm font-semibold text-black active:scale-95 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
            <Download size={15} className="hidden min-[360px]:block" /><span className="hidden min-[360px]:inline">Export video</span><span className="min-[360px]:hidden">Export</span>
          </button>
        </div>
      </div>

      {/* preview */}
      <div className="relative flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
        <div data-editor-frame data-export-width={output.width}
          data-export-height={output.height}
          data-export-quality={exportQuality}
          className="relative max-h-full max-w-full overflow-hidden bg-neutral-900" style={{
          aspectRatio: ASPECT_RATIOS[aspectRatio].css,
          height: aspectRatio === '16:9' ? '100%' : 'auto',
          width: aspectRatio === '16:9' ? 'auto' : '100%',
        }}>
          {[0, 1].map((slot) => (
            <video key={slot} ref={(video) => { videoRefs.current[slot as VideoSlot] = video; }}
              data-editor-video-slot={slot} playsInline preload="auto" muted={slot !== activeSlot}
              className={`absolute inset-0 h-full w-full object-cover transition-none ${slot === activeSlot ? 'opacity-100' : 'opacity-0'}`} />
          ))}
        </div>
        <button onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center group focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
          aria-label={playing ? 'Pause' : 'Play'}>
          {!playing && (
            <span className="w-16 h-16 rounded-full bg-black/60 backdrop-blur flex items-center justify-center border border-white/20">
              <Play size={26} className="ml-1" />
            </span>
          )}
        </button>
      </div>

      {/* action row — flex-wrap keeps every control on-screen and >=44px at
          narrow widths (320px): the trim group wraps to a second row instead
          of clipping off the right edge. */}
      <div className="border-t border-white/10">
        <div className="mx-auto flex w-max max-w-full flex-wrap items-center justify-center gap-1 px-2 py-1 min-[360px]:px-3">
          <Action icon={<Scissors size={17} />} label="Split" onClick={splitSelected} disabled={!selected || playing} />
          <Action icon={<Copy size={17} />} label="Duplicate" onClick={duplicateSelected} disabled={!selected} />
          <Action icon={<Trash2 size={17} />} label="Delete" onClick={deleteSelected} disabled={!selected} />
          <Action icon={<Plus size={17} />} label="Import" onClick={() => fileRef.current?.click()} disabled={false} />
          {selected && (
            <div className="flex items-center ml-1 border-l border-white/10 pl-1.5">
              <button aria-label="Trim in -1 frame"
                className="flex h-11 w-11 items-center justify-center rounded active:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                onClick={() => trimSelected(selected.trimIn - FRAME, selected.trimOut)}>
                <ChevronLeft size={16} /></button>
              <span className="text-[11px] tabular-nums text-white/60 w-12 text-center">
                {clipLen(selected).toFixed(2)}s
              </span>
              <button aria-label="Trim in +1 frame"
                className="flex h-11 w-11 items-center justify-center rounded active:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                onClick={() => trimSelected(selected.trimIn + FRAME, selected.trimOut)}>
                <ChevronRight size={16} /></button>
            </div>
          )}
        </div>
      </div>

      {/* timeline */}
      <Timeline
        clips={clips}
        selectedId={selectedId}
        playhead={playhead}
        onSelect={(id, offset) => {
          videoRefs.current.forEach((video) => video?.pause());
          setPlaying(false);
          select(id);
          const nextPlayhead = clipStart(clips, clips.findIndex((c) => c.id === id)) + offset;
          setPlayhead(nextPlayhead);
          void syncVideo(nextPlayhead);
        }}
        trimSelected={trimSelected}
        onReorder={reorder}
        selIdx={selIdx}
      />

      <input ref={fileRef} type="file" accept="video/*" multiple hidden
        onChange={(e) => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />

      {exportOpen && (
        <ExportSheet
          quality={exportQuality}
          onQualityChange={chooseExportQuality}
          onClose={() => setExportOpen(false)}
          onExportStart={parkPreviews}
          onExportEnd={resumePreviews}
        />
      )}
    </div>
  );
}

function Action({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 px-1.5 py-1 rounded-lg active:bg-white/10 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
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
      <div className="text-[10px] text-white/60 px-3 pt-1.5 flex justify-between">
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
