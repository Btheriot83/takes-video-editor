import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { AspectRatio, Clip, Project } from '../types/clip';
import { DEFAULT_ASPECT_RATIO } from '../types/clip';

const DB_NAME = 'takes-db';
const PROJECT_ID = 'current';

type TakeDB = IDBPDatabase;

let dbp: Promise<TakeDB> | null = null;

function db(): Promise<TakeDB> {
  if (!dbp) {
    dbp = openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore('project');
        d.createObjectStore('blobs');
        // in-progress recording chunks, keyed by sequence number
        d.createObjectStore('rec');
        d.createObjectStore('recmeta');
      },
    }) as Promise<TakeDB>;
  }
  return dbp;
}

export async function saveBlob(key: string, blob: Blob): Promise<void> {
  await (await db()).put('blobs', blob, key);
}
export async function getBlob(key: string): Promise<Blob | undefined> {
  return (await db()).get('blobs', key);
}
export async function deleteBlob(key: string): Promise<void> {
  await (await db()).delete('blobs', key);
}

export async function saveProject(clips: Clip[], aspectRatio: AspectRatio = DEFAULT_ASPECT_RATIO): Promise<void> {
  const p: Project = { id: PROJECT_ID, clips, updatedAt: Date.now(), name: 'Untitled take', aspectRatio };
  await (await db()).put('project', p, PROJECT_ID);
}

export async function loadProject(): Promise<Project | undefined> {
  return (await db()).get('project', PROJECT_ID);
}

export async function clearProject(): Promise<void> {
  await (await db()).delete('project', PROJECT_ID);
}

// ---- interruption-safe in-progress recording ----

export async function recBegin(meta: { mimeType: string; startedAt: number; facing: string }): Promise<void> {
  const d = await db();
  await d.clear('rec');
  await d.put('recmeta', meta, 'active');
}
export async function recChunk(seq: number, chunk: Blob): Promise<void> {
  await (await db()).put('rec', chunk, seq);
}
export async function recFinalize(): Promise<void> {
  const d = await db();
  await d.clear('rec');
  await d.delete('recmeta', 'active');
}
export async function recRecover(): Promise<{ mimeType: string; blob: Blob } | null> {
  const d = await db();
  const meta = await d.get('recmeta', 'active');
  if (!meta) return null;
  const keys = (await d.getAllKeys('rec')) as number[];
  if (!keys.length) { await recFinalize(); return null; }
  keys.sort((a, b) => a - b);
  const parts: Blob[] = [];
  for (const k of keys) parts.push(await d.get('rec', k));
  const blob = new Blob(parts, { type: meta.mimeType });
  await recFinalize();
  return { mimeType: meta.mimeType, blob };
}

/** Delete blobs not referenced by any clip (orphan GC). */
export async function gcBlobs(keepKeys: Set<string>): Promise<void> {
  const d = await db();
  const keys = (await d.getAllKeys('blobs')) as string[];
  for (const k of keys) if (!keepKeys.has(k)) await d.delete('blobs', k);
}
