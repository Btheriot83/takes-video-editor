export type AspectRatio = '16:9' | '4:3' | '1:1';
export type ExportQuality = '1080p' | '4K';
/** `HD` remains only so legacy saved projects can still be read safely. */
export type CaptureQuality = 'HD' | '4K';
export type ClipFraming = 'cover' | 'contain';

export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9';
export const DEFAULT_CAPTURE_QUALITY: CaptureQuality = '4K';

/** Requested capture size per quality, portrait convention (width < height). */
export const CAPTURE_DIMENSIONS: Record<CaptureQuality, { width: number; height: number }> = {
  HD: { width: 1080, height: 1920 },
  '4K': { width: 2160, height: 3840 },
};

/** True when a saved/output frame belongs to the 2160px 4K export class. */
export function isUltraHDCapture(width?: number, height?: number): boolean {
  return Math.min(width ?? 0, height ?? 0) >= 2160;
}

/** True only for a complete UHD camera raster in either orientation. */
export function isFullUltraHDFrame(width?: number, height?: number): boolean {
  return Math.min(width ?? 0, height ?? 0) >= 2160 && Math.max(width ?? 0, height ?? 0) >= 3840;
}

/**
 * A 4K-shaped output is not proof of a 4K camera source. Verify both the
 * camera track contract and the display-oriented preview before recording.
 */
export function isVerifiedUltraHDCapture(
  track: { width?: number; height?: number },
  preview: { width?: number; height?: number },
): boolean {
  return isFullUltraHDFrame(track.width, track.height) && isFullUltraHDFrame(preview.width, preview.height);
}

/**
 * True when a clip's stored dimensions equal the export output frame, i.e. the
 * copy paths (return-unchanged / concat "-c copy" remux) can serve it without
 * re-encoding.
 *
 * Clip dimensions are DISPLAY dimensions: probeVideo reads
 * HTMLVideoElement.videoWidth/videoHeight, which apply the container's
 * rotation matrix. Verified in Chromium: an mp4 encoded 640x360 with a 90°
 * displaymatrix reports videoWidth=360, videoHeight=640. Consequences:
 *
 * - A 4K capture stored landscape-encoded (3840x2160) WITH a 90° rotation
 *   matrix — what the iOS landscape-mode 4K retry produces — is stored here
 *   as 2160x3840 and matches portrait 4K output. Remuxing it is safe: stream
 *   copy preserves the display matrix, so players still show it upright.
 * - A true landscape-encoded stream with NO rotation flag is stored as
 *   3840x2160 and does NOT match 2160x3840. That is deliberate: a remux
 *   cannot rotate pixels, so accepting bare transposed dimensions would ship
 *   a sideways video. Such sources must transcode.
 * - Same-width different-aspect sources (e.g. 2160x2160 vs 2160x3840) never
 *   match; they need the scale/crop render, not a remux.
 */
export function clipMatchesOutput(
  clip: { width: number; height: number },
  output: { width: number; height: number },
): boolean {
  return clip.width === output.width && clip.height === output.height;
}

export const ASPECT_RATIOS: Record<AspectRatio, { css: string; outputLabel: string }> = {
  '16:9': { css: '9 / 16', outputLabel: '9:16 portrait' },
  '4:3': { css: '3 / 4', outputLabel: '3:4 portrait' },
  '1:1': { css: '1 / 1', outputLabel: '1:1 square' },
};

const EXPORT_WIDTHS: Record<ExportQuality, number> = { '1080p': 1080, '4K': 2160 };

export function exportDimensions(aspectRatio: AspectRatio, quality: ExportQuality) {
  const width = EXPORT_WIDTHS[quality];
  const height = aspectRatio === '16:9' ? width * 16 / 9 : aspectRatio === '4:3' ? width * 4 / 3 : width;
  return { width, height: Math.round(height) };
}

/**
 * Clip provenance. 'recording' = captured by this app's own MediaRecorder in
 * this session (uniform by construction: same recorder, same session settings),
 * which lets the multi-clip remux gate trust the set when the mp4box probe
 * cannot prove uniformity. 'import' = arrived via file import (or a legacy
 * clip saved before this field existed) — such clips keep the full strict
 * codec+dims+rotation-matrix probe requirement.
 */
export type ClipSource = 'recording' | 'import';

export interface Clip {
  id: string;
  /** key into the blobs store in IndexedDB */
  blobKey: string;
  mimeType: string;
  /** Provenance; legacy clips loaded without it default to 'import' for safety. */
  source: ClipSource;
  /**
   * How the source is placed inside the selected project frame. Camera clips
   * use `cover` for a true vertical composition. `contain` remains available
   * for imported media that explicitly opts into a fit-with-padding layout.
   */
  framing?: ClipFraming;
  /**
   * MediaRecorder.mimeType stamped at record time — the recorder's ACTUAL
   * negotiated codec string, distinct from `mimeType` (which comes from
   * blob.type and can be bare "video/mp4"). Provenance-trusted remux requires
   * an identical NON-EMPTY stamp across the whole set: 'recording' provenance
   * alone persists across sessions and browser updates, so without the stamp
   * an avc1-session clip and an hvc1-session clip (both bare "video/mp4",
   * probe inconclusive) could concat "-c copy" into a corrupt file — ffmpeg
   * exits 0 on mixed-codec concats, so the exit-code backstop does not catch
   * it. Absent on imports and on legacy clips (which therefore never receive
   * provenance trust and keep the strict probe).
   */
  recorderMimeType?: string;
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

/**
 * Runtime-safe framing for persisted clips. A short-lived release stored
 * front-camera recordings as `contain`, producing a landscape strip inside
 * the portrait frame; normalize those recordings back to vertical fill.
 */
export function clipFraming(clip: { framing?: ClipFraming; source?: ClipSource }): ClipFraming {
  if (clip.source === 'recording') return 'cover';
  return clip.framing === 'contain' ? 'contain' : 'cover';
}

export interface Project {
  id: string;
  clips: Clip[];
  updatedAt: number;
  name: string;
  aspectRatio?: AspectRatio;
  captureQuality?: CaptureQuality;
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
