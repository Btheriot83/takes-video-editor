import { create } from 'zustand';
import { totalDuration, clipLen, DEFAULT_ASPECT_RATIO, DEFAULT_CAPTURE_QUALITY } from '../types/clip';
import type { AspectRatio, CaptureQuality, Clip, ClipSource, ExportQuality } from '../types/clip';
import { History, trimClip, splitClip, moveClip, duplicateClip, uid } from '../lib/editor';
import {
  saveProject, loadProject, saveBlob, getBlob, deleteBlob, recRecover, recFinalize, gcBlobs, clearProject,
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
  captureQuality: CaptureQuality;
  /**
   * Last export quality the user explicitly chose, persisted across sessions.
   * Read by the Camera screen to badge the 4K capture toggle when someone who
   * exports at 4K is still capturing HD (an HD capture forces an upscale
   * transcode instead of the instant copy-path 4K export).
   */
  lastExportQuality: ExportQuality | null;
  setLastExportQuality: (quality: ExportQuality) => void;

  init: () => Promise<void>;
  addClipFromBlob: (blob: Blob, mimeType: string, generateThumbs?: boolean, source?: ClipSource, recorderMimeType?: string) => Promise<Clip>;
  importFiles: (files: FileList | File[]) => Promise<void>;
  select: (id: string | null) => void;
  setScreen: (s: Screen) => void;
  setPlayhead: (t: number) => void;
  setAspectRatio: (aspectRatio: AspectRatio) => void;
  setCaptureQuality: (captureQuality: CaptureQuality) => void;

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

const LAST_EXPORT_QUALITY_KEY = 'takes.lastExportQuality';

/** localStorage can throw (Safari private mode); the preference is optional. */
function readLastExportQuality(): ExportQuality | null {
  try {
    const value = localStorage.getItem(LAST_EXPORT_QUALITY_KEY);
    return value === '4K' || value === '1080p' ? value : null;
  } catch {
    return null;
  }
}

const history = new History();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(clips: Clip[], aspectRatio: AspectRatio, captureQuality: CaptureQuality) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProject(clips, aspectRatio, captureQuality).catch(() => {});
    // NOTE: no blob GC here — undo/redo can restore clips referencing older
    // blobs. Orphaned blobs are reclaimed on newProject / clearAllData.
  }, 400);
}

async function persistNow(clips: Clip[], aspectRatio: AspectRatio, captureQuality: CaptureQuality) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await saveProject(clips, aspectRatio, captureQuality);
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
  captureQuality: DEFAULT_CAPTURE_QUALITY,
  lastExportQuality: readLastExportQuality(),

  init: async () => {
    let notice: string | null = null;
    try {
      // Restore completed clips first so an interrupted recording is appended
      // instead of being replaced by the older saved project.
      const p = await loadProject().catch(() => undefined);
      const existing: Clip[] = [];
      if (p?.clips.length) {
        for (const clip of p.clips) {
          try {
            // Legacy clips (saved before provenance existed) load as 'import'
            // so they never receive recorder-provenance remux trust.
            if (await getBlob(clip.blobKey)) existing.push({ ...clip, source: clip.source ?? 'import' });
          } catch {
            // A single damaged entry must not leave the whole app on Loading.
          }
        }
      }
      set({
        clips: existing,
        total: totalDuration(existing),
        selectedId: existing[0]?.id ?? null,
        screen: existing.length ? 'editor' : 'camera',
        // Empty projects always open in the requested vertical default.
        // Existing projects retain their chosen frame for editing/export.
        aspectRatio: existing.length ? (p?.aspectRatio ?? DEFAULT_ASPECT_RATIO) : DEFAULT_ASPECT_RATIO,
        // Capture quality is a camera preference, not a project frame, so it
        // is restored even when the project itself is empty.
        captureQuality: p?.captureQuality ?? DEFAULT_CAPTURE_QUALITY,
      });

      const rec = await recRecover();
      if (rec && rec.blob.size > 10_000) {
        // Crash-recovered chunks came from this app's own recorder; the meta
        // mimeType stored by recBegin IS the recorder's negotiated stamp.
        const clip = await get().addClipFromBlob(rec.blob, rec.mimeType, true, 'recording', rec.mimeType);
        await recFinalize();
        notice = `Recovered an interrupted recording (${clipLen(clip).toFixed(1)}s).`;
      }
    } catch (error) {
      console.error('[store] restore failed', error);
      notice = 'Some saved media could not be restored. New recordings are still available.';
    } finally {
      set({ ready: true, recoveredNotice: notice });
    }
  },

  addClipFromBlob: async (blob, mimeType, generateThumbs = true, source = 'import', recorderMimeType) => {
    const blobKey = uid();
    // Persist the irreplaceable media before doing any decoder work. Camera
    // recovery data is kept until this clip and its project entry are durable.
    await saveBlob(blobKey, blob);
    const meta = await probeVideo(blob);
    const clip: Clip = {
      id: uid(),
      blobKey,
      mimeType,
      source,
      // Only recordings carry the stamp; an empty string is stored as absent
      // so it can never satisfy the non-empty equality the remux trust needs.
      ...(source === 'recording' && recorderMimeType ? { recorderMimeType } : {}),
      duration: meta.duration,
      trimIn: 0,
      trimOut: meta.duration,
      width: meta.width,
      height: meta.height,
      createdAt: Date.now(),
      thumbs: [],
    };
    const clips = [...get().clips, clip];
    await persistNow(clips, get().aspectRatio, get().captureQuality);
    history.push(get().clips);
    set({ clips, selectedId: clip.id, total: totalDuration(clips), canUndo: history.canUndo, canRedo: false });

    // Thumbnail decoding is expensive and can monopolize iPhone media
    // decoders. It must never keep the record button in a stopping state.
    if (generateThumbs) void makeThumbs(blob, 4).then(async (thumbs) => {
      const latest = get().clips;
      if (!latest.some((item) => item.id === clip.id)) return;
      const withThumbs = latest.map((item) => (item.id === clip.id ? { ...item, thumbs } : item));
      set({ clips: withThumbs });
      persist(withThumbs, get().aspectRatio, get().captureQuality);
    }).catch(() => { /* thumbnails are non-essential */ });
    return clip;
  },

  importFiles: async (files) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('video/')) continue;
      await get().addClipFromBlob(f, f.type, true, 'import');
    }
    if (get().clips.length) set({ screen: 'editor' });
  },

  select: (id) => set({ selectedId: id }),
  setScreen: (s) => set({ screen: s }),
  setPlayhead: (t) => set({ playhead: t }),
  setAspectRatio: (aspectRatio) => {
    set({ aspectRatio });
    persist(get().clips, aspectRatio, get().captureQuality);
  },
  setCaptureQuality: (captureQuality) => {
    set({ captureQuality });
    persist(get().clips, get().aspectRatio, captureQuality);
  },
  setLastExportQuality: (quality) => {
    set({ lastExportQuality: quality });
    try {
      localStorage.setItem(LAST_EXPORT_QUALITY_KEY, quality);
    } catch { /* private mode: keep it session-only */ }
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
    persist(next, get().aspectRatio, get().captureQuality);
  },

  undo: () => {
    const prev = history.undo(get().clips);
    if (!prev) return;
    set({ clips: prev, total: totalDuration(prev), canUndo: history.canUndo, canRedo: history.canRedo });
    persist(prev, get().aspectRatio, get().captureQuality);
  },
  redo: () => {
    const next = history.redo(get().clips);
    if (!next) return;
    set({ clips: next, total: totalDuration(next), canUndo: history.canUndo, canRedo: history.canRedo });
    persist(next, get().aspectRatio, get().captureQuality);
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
    set({
      clips: [], selectedId: null, screen: 'camera', playhead: 0, total: 0,
      canUndo: false, canRedo: false, aspectRatio: DEFAULT_ASPECT_RATIO,
    });
    // Capture quality is a device preference, so it survives New project.
    await saveProject([], DEFAULT_ASPECT_RATIO, get().captureQuality);
  },

  dismissNotice: () => set({ recoveredNotice: null }),
}));
