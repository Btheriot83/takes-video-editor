import { describe, it, expect } from 'vitest';
import { trimClip, splitClip, moveClip, History, locate, clipStart } from './editor';
import { ASPECT_RATIOS, clipLen, totalDuration, FRAME } from '../types/clip';
import type { Clip } from '../types/clip';

const mk = (id: string, dur: number, trimIn = 0, trimOut?: number): Clip => ({
  id, blobKey: 'b' + id, mimeType: 'video/webm', duration: dur,
  trimIn, trimOut: trimOut ?? dur, width: 1080, height: 1920, createdAt: 0, thumbs: [],
});

describe('trimClip', () => {
  it('trims within bounds', () => {
    const c = trimClip(mk('a', 10), 2, 8);
    expect(c.trimIn).toBe(2);
    expect(c.trimOut).toBe(8);
    expect(clipLen(c)).toBe(6);
  });
  it('clamps to [0, duration] and keeps >= 1 frame', () => {
    const c = trimClip(mk('a', 10), -5, 99);
    expect(c.trimIn).toBe(0);
    expect(c.trimOut).toBe(10);
    const tiny = trimClip(mk('a', 1), 0.999, 0.9995);
    expect(clipLen(tiny)).toBeGreaterThanOrEqual(FRAME - 0.001);
  });
  it('never inverts the range', () => {
    const c = trimClip(mk('a', 10), 8, 3);
    expect(c.trimOut).toBeGreaterThan(c.trimIn);
  });
});

describe('splitClip', () => {
  it('splits at an offset inside the trimmed range', () => {
    const c = mk('a', 10, 2, 8); // visible 6s
    const res = splitClip(c, 3)!;
    expect(res).not.toBeNull();
    expect(res[0].trimIn).toBe(2);
    expect(res[0].trimOut).toBe(5);
    expect(res[1].trimIn).toBe(5);
    expect(res[1].trimOut).toBe(8);
    expect(totalDuration(res)).toBeCloseTo(6);
    expect(res[0].id).not.toBe(res[1].id);
  });
  it('refuses to split at the edges', () => {
    expect(splitClip(mk('a', 10), 0)).toBeNull();
    expect(splitClip(mk('a', 10), 10)).toBeNull();
    expect(splitClip(mk('a', 10), FRAME / 2)).toBeNull();
  });
});

describe('moveClip', () => {
  it('reorders', () => {
    const cs = [mk('a', 1), mk('b', 1), mk('c', 1)];
    expect(moveClip(cs, 0, 2).map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(moveClip(cs, 2, 0).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('ignores invalid indices', () => {
    const cs = [mk('a', 1)];
    expect(moveClip(cs, 0, 5)).toBe(cs);
  });
});

describe('History', () => {
  it('undo/redo round trips', () => {
    const h = new History();
    const s0 = [mk('a', 1)];
    const s1 = [mk('a', 1), mk('b', 2)];
    h.push(s0);
    expect(h.canUndo).toBe(true);
    expect(h.undo(s1)).toBe(s0);
    expect(h.canRedo).toBe(true);
    expect(h.redo(s0)).toBe(s1);
  });
  it('new edit clears redo stack', () => {
    const h = new History();
    const s0 = [mk('a', 1)];
    h.push(s0);
    h.undo([mk('a', 1), mk('b', 2)]);
    h.push(s0);
    expect(h.canRedo).toBe(false);
  });
  it('clears both stacks for a new project', () => {
    const h = new History();
    const s0 = [mk('a', 1)];
    h.push(s0);
    h.undo([mk('b', 1)]);
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});

describe('locate / clipStart', () => {
  const cs = [mk('a', 4), mk('b', 6, 1, 4), mk('c', 2)]; // visible: 4, 3, 2
  it('maps global time to clip + offset', () => {
    expect(locate(cs, 0)).toEqual({ index: 0, offset: 0 });
    expect(locate(cs, 4.5)).toEqual({ index: 1, offset: 0.5 });
    expect(locate(cs, 8)).toEqual({ index: 2, offset: 1 });
  });
  it('clipStart sums visible durations', () => {
    expect(clipStart(cs, 0)).toBe(0);
    expect(clipStart(cs, 1)).toBe(4);
    expect(clipStart(cs, 2)).toBe(7);
    expect(totalDuration(cs)).toBe(9);
  });
});

describe('aspect-ratio export targets', () => {
  it('keeps every supported frame mapped to its intended output size', () => {
    expect(ASPECT_RATIOS['16:9']).toMatchObject({ css: '9 / 16', outputLabel: '9:16 portrait', width: 1080, height: 1920 });
    expect(ASPECT_RATIOS['4:3']).toMatchObject({ css: '3 / 4', outputLabel: '3:4 portrait', width: 1080, height: 1440 });
    expect(ASPECT_RATIOS['1:1']).toMatchObject({ css: '1 / 1', outputLabel: '1:1 square', width: 1080, height: 1080 });
  });
});
