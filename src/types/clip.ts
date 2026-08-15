export interface Clip {
  id: string;
  /** key into the blobs store in IndexedDB */
  blobKey: string;
  mimeType: string;
  /** source duration in seconds (untrimmed) */
  duration: number;
  /** trim range within the source, seconds */
  trimIn: number;
  trimOut: number;
  width: number;
  height: number;
  createdAt: number;
  /** thumbnails (jpeg dataURLs), sparse */
  thumbs: string[];
}

export interface Project {
  id: string;
  clips: Clip[];
  updatedAt: number;
  name: string;
}

export const FRAME = 1 / 30;

export function clipLen(c: Clip): number {
  return Math.max(0, c.trimOut - c.trimIn);
}

export function totalDuration(clips: Clip[]): number {
  return clips.reduce((s, c) => s + clipLen(c), 0);
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
