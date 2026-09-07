import { clipLen, FRAME } from '../types/clip';
import type { Clip } from '../types/clip';

export const TIMELINE_PX_PER_SEC = 44;
export const TIMELINE_MIN_CLIP_PX = 88;
export const TIMELINE_GAP_PX = 4;

/** Width used by the visual timeline, including a usable minimum trim target. */
export function timelineClipWidth(c: Clip): number {
  return Math.max(TIMELINE_MIN_CLIP_PX, clipLen(c) * TIMELINE_PX_PER_SEC);
}

export function clampTimelineTime(clips: Clip[], time: number): number {
  const duration = clips.reduce((sum, clip) => sum + clipLen(clip), 0);
  return Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0));
}

/**
 * Map timeline seconds to the rendered strip. A simple `time * pxPerSec`
 * drifts as soon as a short clip is widened to its minimum touch-friendly
 * width, and it also ignores the gaps between clips.
 */
export function timelinePlayheadX(clips: Clip[], time: number): number {
  if (!clips.length) return 0;
  const target = clampTimelineTime(clips, time);
  let elapsed = 0;
  let x = 0;

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const length = clipLen(clip);
    const width = timelineClipWidth(clip);
    const isLast = index === clips.length - 1;
    if (target < elapsed + length || isLast) {
      const progress = length > 0 ? Math.max(0, Math.min(1, (target - elapsed) / length)) : 0;
      return x + width * progress;
    }
    elapsed += length;
    x += width + TIMELINE_GAP_PX;
  }

  return x;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Clamp trim values: keep >= FRAME visible, inside [0, duration]. */
export function trimClip(c: Clip, trimIn: number, trimOut: number): Clip {
  const lo = Math.min(Math.max(0, trimIn), c.duration - FRAME);
  const hi = Math.max(Math.min(c.duration, trimOut), lo + FRAME);
  return { ...c, trimIn: round3(lo), trimOut: round3(hi) };
}

export function splitClip(c: Clip, at: number): [Clip, Clip] | null {
  // `at` is relative to the *visible* (trimmed) range
  const abs = c.trimIn + at;
  if (abs < c.trimIn + FRAME || abs > c.trimOut - FRAME) return null;
  const a: Clip = { ...c, id: uid(), trimOut: round3(abs) };
  const b: Clip = { ...c, id: uid(), trimIn: round3(abs), thumbs: [...c.thumbs] };
  return [a, b];
}

export function moveClip(clips: Clip[], from: number, to: number): Clip[] {
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return clips;
  const next = clips.slice();
  const [c] = next.splice(from, 1);
  next.splice(to, 0, c);
  return next;
}

export function duplicateClip(c: Clip): Clip {
  return { ...c, id: uid(), thumbs: [...c.thumbs] };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Undo/redo history over immutable clip arrays. */
export class History {
  private past: Clip[][] = [];
  private future: Clip[][] = [];
  private limit = 60;
  constructor(limit = 60) { this.limit = limit; }

  push(state: Clip[]) {
    this.past.push(state);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: Clip[]): Clip[] | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }
  redo(current: Clip[]): Clip[] | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

/** Map a global timeline time to (clipIndex, offset inside trimmed clip). */
export function locate(clips: Clip[], t: number): { index: number; offset: number } | null {
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const len = clipLen(clips[i]);
    if (t < acc + len || i === clips.length - 1) {
      return { index: i, offset: Math.max(0, Math.min(len, t - acc)) };
    }
    acc += len;
  }
  return null;
}

/** Start time of clip i on the global timeline. */
export function clipStart(clips: Clip[], i: number): number {
  return clips.slice(0, i).reduce((s, c) => s + clipLen(c), 0);
}
