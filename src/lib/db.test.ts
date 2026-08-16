import { describe, it, expect } from 'vitest';
import {
  isStorageFallbackError, storageMode,
  saveBlob, getBlob, deleteBlob, saveProject, loadProject,
  recBegin, recChunk, recRecover, recFinalize, gcBlobs,
} from './db';

describe('isStorageFallbackError (fallback decision)', () => {
  it('falls back on quota errors', () => {
    expect(isStorageFallbackError(new DOMException('Quota exceeded.', 'QuotaExceededError'))).toBe(true);
  });

  it('falls back on private-browsing security errors', () => {
    expect(isStorageFallbackError(new DOMException('Access denied.', 'SecurityError'))).toBe(true);
  });

  it('falls back on the Firefox/Safari private-mode error shapes', () => {
    expect(isStorageFallbackError(new DOMException('mutation not allowed', 'InvalidStateError'))).toBe(true);
    expect(isStorageFallbackError(new DOMException('database backend error', 'UnknownError'))).toBe(true);
  });

  it('falls back when the message points at IndexedDB itself', () => {
    expect(isStorageFallbackError(new ReferenceError('indexedDB is not defined'))).toBe(true);
    expect(isStorageFallbackError(new Error('Internal error opening backing store'))).toBe(true);
  });

  it('does NOT swallow unrelated application errors', () => {
    expect(isStorageFallbackError(new Error('probeVideo: cannot read video file'))).toBe(false);
    expect(isStorageFallbackError(new TypeError('x is not a function'))).toBe(false);
    expect(isStorageFallbackError('string failure')).toBe(false);
    expect(isStorageFallbackError(undefined)).toBe(false);
  });
});

// This suite runs in Node, which has no global indexedDB — exactly the
// "IndexedDB unavailable" private-browsing shape. Every operation must
// transparently switch to the in-memory session store instead of throwing.
describe('in-memory storage fallback', () => {
  it('starts in idb mode and flips to memory on the first failed operation', async () => {
    await saveBlob('clip-a', new Blob(['aaaa'], { type: 'video/mp4' }));
    expect(storageMode()).toBe('memory');
  });

  it('round-trips blobs through the in-memory store', async () => {
    await saveBlob('clip-b', new Blob(['bbbb'], { type: 'video/mp4' }));
    const blob = await getBlob('clip-b');
    expect(blob?.size).toBe(4);
    expect(await getBlob('missing-key')).toBeUndefined();
    await deleteBlob('clip-b');
    expect(await getBlob('clip-b')).toBeUndefined();
  });

  it('round-trips the project through the in-memory store', async () => {
    await saveProject([], '4:3', '4K');
    const p = await loadProject();
    expect(p?.aspectRatio).toBe('4:3');
    expect(p?.captureQuality).toBe('4K');
  });

  it('silently no-ops crash recovery in memory mode', async () => {
    await expect(recBegin({ mimeType: 'video/mp4', startedAt: 1, facing: 'user' })).resolves.toBeUndefined();
    await expect(recChunk(0, new Blob(['chunk']))).resolves.toBeUndefined();
    // nothing recoverable: recovery data would die with the tab anyway
    expect(await recRecover()).toBeNull();
    await expect(recFinalize()).resolves.toBeUndefined();
  });

  it('garbage-collects unreferenced in-memory blobs', async () => {
    await saveBlob('keep', new Blob(['k']));
    await saveBlob('drop', new Blob(['d']));
    await gcBlobs(new Set(['keep']));
    expect((await getBlob('keep'))?.size).toBe(1);
    expect(await getBlob('drop')).toBeUndefined();
  });
});
