import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { AspectRatio, CaptureQuality, Clip, Project } from '../types/clip';
import { DEFAULT_ASPECT_RATIO, DEFAULT_CAPTURE_QUALITY } from '../types/clip';
import { exportLog } from './export-log';

const DB_NAME = 'takes-db';
const PROJECT_ID = 'current';

type TakeDB = IDBPDatabase;

let dbp: Promise<TakeDB> | null = null;

function db(): Promise<TakeDB> {
  if (!dbp) {
    try {
      dbp = openDB(DB_NAME, 1, {
        upgrade(d) {
          d.createObjectStore('project');
          d.createObjectStore('blobs');
          // in-progress recording chunks, keyed by sequence number
          d.createObjectStore('rec');
          d.createObjectStore('recmeta');
        },
      }) as Promise<TakeDB>;
    } catch (error) {
      // indexedDB missing entirely (some private-browsing modes) throws
      // synchronously; keep the failure as a rejected promise so every call
      // site funnels through the same fallback decision.
      dbp = Promise.reject(error);
    }
    dbp.catch(() => { /* inspected at await sites; avoid unhandled rejection */ });
  }
  return dbp;
}

// ---- in-memory session fallback (private browsing / broken IndexedDB) ----

export type StorageMode = 'idb' | 'memory';

let mode: StorageMode = 'idb';
const memBlobs = new Map<string, Blob>();
let memProject: Project | undefined;

/** 'memory' once IndexedDB proved unusable — clips live only for this tab. */
export function storageMode(): StorageMode {
  return mode;
}

const FALLBACK_ERROR_NAMES = new Set([
  'QuotaExceededError', // quota-limited incognito / storage pressure
  'SecurityError', // Firefox private mode, blocked third-party contexts
  'InvalidStateError', // Firefox private mode via idb open
  'UnknownError', // Safari private mode / dead backing store
  'NotFoundError', // object store vanished (partially evicted DB)
  'VersionError',
]);

/**
 * Storage failures that mean "IndexedDB is unusable here" (private browsing,
 * quota lockdown, evicted backing store) rather than a bug in calling code.
 * These switch the session to the in-memory fallback instead of surfacing
 * "could not be saved" to someone who cannot do anything about it.
 */
export function isStorageFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (FALLBACK_ERROR_NAMES.has(error.name)) return true;
  return /indexeddb|quota|backing store|database/i.test(error.message);
}

function enterMemoryMode(context: string, error: unknown): void {
  if (mode === 'memory') return;
  mode = 'memory';
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.warn(
    `[db] ${context} — falling back to in-memory session storage; clips will not survive closing this tab.`,
    error,
  );
  try {
    exportLog(`storage fallback (${context}): ${detail}`);
  } catch { /* diagnostics must never break saving */ }
}

/**
 * Run an IndexedDB operation, or its in-memory equivalent when the session is
 * (or just became) memory-only. Any open failure and any recoverable write
 * failure flips the session to memory mode; unexpected errors still throw so
 * real bugs stay visible.
 */
async function withFallback<T>(context: string, op: (d: TakeDB) => Promise<T>, mem: () => T): Promise<T> {
  if (mode === 'memory') return mem();
  let d: TakeDB;
  try {
    d = await db();
  } catch (error) {
    enterMemoryMode('IndexedDB could not be opened', error);
    return mem();
  }
  try {
    return await op(d);
  } catch (error) {
    if (!isStorageFallbackError(error)) throw error;
    enterMemoryMode(context, error);
    return mem();
  }
}

/** Best-effort IndexedDB read for data persisted before a mid-session fallback. */
async function idbReadBestEffort<T>(op: (d: TakeDB) => Promise<T>): Promise<T | undefined> {
  try {
    return await op(await db());
  } catch {
    return undefined;
  }
}

export async function saveBlob(key: string, blob: Blob): Promise<void> {
  await withFallback(
    'media write failed',
    async (d) => { await d.put('blobs', blob, key); },
    () => { memBlobs.set(key, blob); },
  );
}
export async function getBlob(key: string): Promise<Blob | undefined> {
  const inMemory = memBlobs.get(key);
  if (inMemory) return inMemory;
  if (mode === 'memory') return idbReadBestEffort((d) => d.get('blobs', key));
  return withFallback('media read failed', (d) => d.get('blobs', key), () => undefined);
}
export async function deleteBlob(key: string): Promise<void> {
  memBlobs.delete(key);
  await withFallback('media delete failed', async (d) => { await d.delete('blobs', key); }, () => {});
}

export async function saveProject(
  clips: Clip[],
  aspectRatio: AspectRatio = DEFAULT_ASPECT_RATIO,
  captureQuality: CaptureQuality = DEFAULT_CAPTURE_QUALITY,
): Promise<void> {
  const p: Project = { id: PROJECT_ID, clips, updatedAt: Date.now(), name: 'Untitled take', aspectRatio, captureQuality };
  await withFallback(
    'project write failed',
    async (d) => { await d.put('project', p, PROJECT_ID); },
    () => { memProject = p; },
  );
}

export async function loadProject(): Promise<Project | undefined> {
  if (memProject) return memProject;
  if (mode === 'memory') return idbReadBestEffort((d) => d.get('project', PROJECT_ID));
  return withFallback('project read failed', (d) => d.get('project', PROJECT_ID), () => undefined);
}

export async function clearProject(): Promise<void> {
  memProject = undefined;
  await withFallback('project clear failed', async (d) => { await d.delete('project', PROJECT_ID); }, () => {});
}

// ---- interruption-safe in-progress recording ----
// In memory mode these silently no-op: crash recovery is meaningless when the
// recovery data itself would die with the tab.

export async function recBegin(meta: { mimeType: string; startedAt: number; facing: string }): Promise<void> {
  await withFallback(
    'recovery write failed',
    async (d) => {
      await d.clear('rec');
      await d.put('recmeta', meta, 'active');
    },
    () => {},
  );
}
export async function recChunk(seq: number, chunk: Blob): Promise<void> {
  await withFallback('recovery chunk write failed', async (d) => { await d.put('rec', chunk, seq); }, () => {});
}
export async function recFinalize(): Promise<void> {
  await withFallback(
    'recovery clear failed',
    async (d) => {
      await d.clear('rec');
      await d.delete('recmeta', 'active');
    },
    () => {},
  );
}
export async function recRecover(): Promise<{ mimeType: string; blob: Blob } | null> {
  return withFallback(
    'recovery read failed',
    async (d) => {
      const meta = await d.get('recmeta', 'active');
      if (!meta) return null;
      const keys = (await d.getAllKeys('rec')) as number[];
      if (!keys.length) { await recFinalize(); return null; }
      keys.sort((a, b) => a - b);
      const parts: Blob[] = [];
      for (const k of keys) parts.push(await d.get('rec', k));
      const blob = new Blob(parts, { type: meta.mimeType });
      // The caller clears recovery only after the reconstructed clip is durable.
      return { mimeType: meta.mimeType, blob };
    },
    () => null,
  );
}

/** Delete blobs not referenced by any clip (orphan GC). */
export async function gcBlobs(keepKeys: Set<string>): Promise<void> {
  for (const k of [...memBlobs.keys()]) if (!keepKeys.has(k)) memBlobs.delete(k);
  await withFallback(
    'media GC failed',
    async (d) => {
      const keys = (await d.getAllKeys('blobs')) as string[];
      for (const k of keys) if (!keepKeys.has(k)) await d.delete('blobs', k);
    },
    () => {},
  );
}
