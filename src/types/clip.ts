export type AspectRatio = '16:9' | '4:3' | '1:1';

export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9';

export const ASPECT_RATIOS: Record<AspectRatio, { css: string; width: number; height: number }> = {
  '16:9': { css: '9 / 16', width: 1080, height: 1920 },
  '4:3': { css: '3 / 4', width: 1080, height: 1440 },
  '1:1': { css: '1 / 1', width: 1080, height: 1080 },
};

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
  aspectRatio?: AspectRatio;
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
