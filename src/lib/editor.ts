import { clipLen, FRAME } from '../types/clip';
import type { Clip } from '../types/clip';

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
