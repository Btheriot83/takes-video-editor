import { create } from 'zustand';
import { totalDuration, clipLen, DEFAULT_ASPECT_RATIO } from '../types/clip';
import type { AspectRatio, Clip } from '../types/clip';
import { History, trimClip, splitClip, moveClip, duplicateClip, uid } from '../lib/editor';
import {
  saveProject, loadProject, saveBlob, getBlob, deleteBlob, recRecover, gcBlobs, clearProject,
} from '../lib/db';
import { probeVideo } from '../lib/recorder';
import { makeThumbs } from '../lib/thumbs';

export type Screen = 'camera' | 'editor';

interface State {
  ready: boolean;
  screen: Screen;
  clips: Clip[];
  selectedId: string | null;
  playhead: number; // global timeline seconds
  canUndo: boolean;
  canRedo: boolean;
  recoveredNotice: string | null;
  total: number;
  aspectRatio: AspectRatio;

  init: () => Promise<void>;
  addClipFromBlob: (blob: Blob, mimeType: string) => Promise<Clip>;
  importFiles: (files: FileList | File[]) => Promise<void>;
  select: (id: string | null) => void;
  setScreen: (s: Screen) => void;
  setPlayhead: (t: number) => void;
  setAspectRatio: (aspectRatio: AspectRatio) => void;

  commit: (next: Clip[], selectId?: string | null) => void;
  undo: () => void;
  redo: () => void;
  trimSelected: (trimIn: number, trimOut: number) => void;
  splitSelected: () => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  reorder: (from: number, to: number) => void;
  newProject: () => Promise<void>;
  dismissNotice: () => void;
}

const history = new History();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(clips: Clip[], aspectRatio: AspectRatio) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveProject(clips, aspectRatio).catch(() => {});
    // NOTE: no blob GC here — undo/redo can restore clips referencing older
    // blobs. Orphaned blobs are reclaimed on newProject / clearAllData.
  }, 400);
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  screen: 'camera',
  clips: [],
  selectedId: null,
  playhead: 0,
  canUndo: false,
  canRedo: false,
  recoveredNotice: null,
  total: 0,
  aspectRatio: DEFAULT_ASPECT_RATIO,

  init: async () => {
    // crash/interruption recovery: an unfinished recording session?
    let notice: string | null = null;
    try {
      const rec = await recRecover();
      if (rec && rec.blob.size > 10_000) {
        try {
          const clip = await get().addClipFromBlob(rec.blob, rec.mimeType);
          notice = `Recovered an interrupted recording (${clipLen(clip).toFixed(1)}s).`;
        } catch {
          notice = null;
        }
      }
    } catch { /* ignore */ }

    const p = await loadProject().catch(() => undefined);
    if (p && p.clips.length) {
      const existing: Clip[] = [];
      for (const c of p.clips) {
        if (await getBlob(c.blobKey)) existing.push(c);
      }
      set({
        clips: existing,
        total: totalDuration(existing),
        selectedId: existing[0]?.id ?? null,
        screen: existing.length ? 'editor' : 'camera',
        recoveredNotice: notice,
        aspectRatio: p.aspectRatio ?? DEFAULT_ASPECT_RATIO,
        ready: true,
      });
    } else {
      set({ ready: true, recoveredNotice: notice });
    }
  },

  addClipFromBlob: async (blob, mimeType) => {
    const meta = await probeVideo(blob);
    const blobKey = uid();
    await saveBlob(blobKey, blob);
    let thumbs: string[] = [];
    try { thumbs = await makeThumbs(blob, 4); } catch { /* non-fatal */ }
    const clip: Clip = {
      id: uid(),
      blobKey,
      mimeType,
      duration: meta.duration,
      trimIn: 0,
      trimOut: meta.duration,
      width: meta.width,
      height: meta.height,
      createdAt: Date.now(),
      thumbs,
    };
    const clips = [...get().clips, clip];
    history.push(get().clips);
    set({ clips, selectedId: clip.id, total: totalDuration(clips), canUndo: history.canUndo, canRedo: false });
    persist(clips, get().aspectRatio);
    return clip;
  },

  importFiles: async (files) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('video/')) continue;
      await get().addClipFromBlob(f, f.type);
    }
    if (get().clips.length) set({ screen: 'editor' });
  },

  select: (id) => set({ selectedId: id }),
  setScreen: (s) => set({ screen: s }),
  setPlayhead: (t) => set({ playhead: t }),
  setAspectRatio: (aspectRatio) => {
    set({ aspectRatio });
    persist(get().clips, aspectRatio);
  },

  commit: (next, selectId) => {
    history.push(get().clips);
    set({
      clips: next,
      total: totalDuration(next),
      selectedId: selectId !== undefined ? selectId : get().selectedId,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
    persist(next, get().aspectRatio);
  },

  undo: () => {
    const prev = history.undo(get().clips);
    if (!prev) return;
    set({ clips: prev, total: totalDuration(prev), canUndo: history.canUndo, canRedo: history.canRedo });
    persist(prev, get().aspectRatio);
  },
  redo: () => {
    const next = history.redo(get().clips);
    if (!next) return;
    set({ clips: next, total: totalDuration(next), canUndo: history.canUndo, canRedo: history.canRedo });
    persist(next, get().aspectRatio);
  },

  trimSelected: (trimIn, trimOut) => {
    const { clips, selectedId } = get();
    const next = clips.map((c) => (c.id === selectedId ? trimClip(c, trimIn, trimOut) : c));
    get().commit(next);
  },

  splitSelected: () => {
    const { clips, selectedId, playhead } = get();
    const idx = clips.findIndex((c) => c.id === selectedId);
    if (idx < 0) return;
    const start = clips.slice(0, idx).reduce((s, c) => s + clipLen(c), 0);
    const offset = playhead - start;
    const res = splitClip(clips[idx], offset);
    if (!res) return;
    const next = [...clips.slice(0, idx), res[0], res[1], ...clips.slice(idx + 1)];
    get().commit(next, res[1].id);
  },

  deleteSelected: () => {
    const { clips, selectedId } = get();
    const idx = clips.findIndex((c) => c.id === selectedId);
    if (idx < 0) return;
    const next = clips.filter((c) => c.id !== selectedId);
    // keep the blob: undo must restore the clip *with* its media
    get().commit(next, next[Math.min(idx, next.length - 1)]?.id ?? null);
    if (!next.length) set({ screen: 'camera' });
  },

  duplicateSelected: () => {
    const { clips, selectedId } = get();
    const idx = clips.findIndex((c) => c.id === selectedId);
    if (idx < 0) return;
    const copy = duplicateClip(clips[idx]);
    copy.blobKey = clips[idx].blobKey; // share the same blob (immutable)
    const next = [...clips.slice(0, idx + 1), copy, ...clips.slice(idx + 1)];
    get().commit(next, copy.id);
  },

  reorder: (from, to) => {
    const next = moveClip(get().clips, from, to);
    if (next !== get().clips) get().commit(next);
  },

  newProject: async () => {
    const keep = new Set(get().clips.map((c) => c.blobKey));
    gcBlobs(keep).catch(() => {});
    for (const c of get().clips) deleteBlob(c.blobKey).catch(() => {});
    await clearProject().catch(() => {});
    history.clear();
    set({ clips: [], selectedId: null, screen: 'camera', playhead: 0, total: 0, canUndo: false, canRedo: false });
    await saveProject([], get().aspectRatio);
  },

  dismissNotice: () => set({ recoveredNotice: null }),
}));
