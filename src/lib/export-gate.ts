import { clipMatchesOutput } from '../types/clip';
import type { Clip } from '../types/clip';
import type { Mp4CopySafety } from './mp4-meta';

/**
 * Trim tolerance (seconds) for the no-re-encode copy paths.
 *
 * Why not exact equality: real-phone recordings are variable frame rate, and
 * the duration probeVideo reads (HTMLVideoElement metadata) can drift from the
 * container-derived trim bounds by tens of milliseconds on iOS Safari
 * MediaRecorder files — the old 1/60s (16.7ms) tolerance silently disqualified
 * genuinely untrimmed recordings and pushed 1080p exports onto the slow
 * transcode path.
 *
 * Why 0.03 and not exactly 1/30: the editor's single-frame trim step is
 * round3(1/30) = 0.033s. The tolerance must stay strictly BELOW that so a
 * deliberate one-frame trim still forces the render; 0.03 is wide enough for
 * observed VFR probe drift (~1 frame at 30fps) while preserving that boundary.
 *
 * 60fps sources: every user trim path quantizes to the editor's FRAME = 1/30
 * grid (drag handles snap with Math.round(dt / FRAME) * FRAME, the +/- buttons
 * step by FRAME), so no deliberate trim smaller than 0.033s can exist — the
 * tolerance cannot swallow a real edit even on 60fps recordings. If a
 * finer-than-FRAME trim UI is ever added, this constant must be compared
 * against the clip's actual frame interval instead.
 */
export const COPY_TRIM_TOLERANCE = 0.03;

/** The subset of Clip the copy-path gate reads (keeps tests light). */
export type GateClip = Pick<Clip, 'mimeType' | 'duration' | 'trimIn' | 'trimOut' | 'width' | 'height' | 'source' | 'recorderMimeType'>;

/**
 * Recorder-provenance trust for the remux gate. 'recording' provenance alone
 * is NOT sufficient: it persists across sessions and browser/OS updates, so
 * two clips recorded either side of a MediaRecorder codec change (avc1 ->
 * hvc1) can both be 'recording' with bare "video/mp4" mimeTypes; if the probe
 * fails on one, blind trust would concat "-c copy" mixed codecs — which
 * ffmpeg exits 0 on, producing a silently corrupt file the exit-code backstop
 * cannot catch. Trust therefore additionally requires every clip to carry the
 * recorder's ACTUAL negotiated codec string (Clip.recorderMimeType, stamped
 * at record time from MediaRecorder.mimeType), non-empty and identical across
 * the whole set. Legacy recordings without the stamp fall back to the strict
 * probe path, exactly like imports.
 */
export function recorderProvenanceTrust(clips: GateClip[]): { trusted: boolean; reason: string } {
  if (!clips.length || !clips.every((clip) => clip.source === 'recording')) {
    return { trusted: false, reason: 'set includes imported clips' };
  }
  const stamps = clips.map((clip) => clip.recorderMimeType ?? '');
  const missing = stamps.findIndex((stamp) => !stamp);
  if (missing >= 0) {
    return { trusted: false, reason: `clip ${missing + 1} has no recorder codec stamp (legacy recording)` };
  }
  const drift = stamps.findIndex((stamp) => stamp !== stamps[0]);
  if (drift >= 0) {
    return {
      trusted: false,
      reason: `recorder codec drift: clip ${drift + 1} recorded as "${stamps[drift]}" vs clip 1 "${stamps[0]}"`,
    };
  }
  return { trusted: true, reason: `all clips recorded in-app as "${stamps[0]}"` };
}

/** True when the clip's trim bounds cover the whole source (within tolerance). */
export const isUntrimmed = (clip: Pick<GateClip, 'trimIn' | 'trimOut' | 'duration'>): boolean =>
  clip.trimIn <= COPY_TRIM_TOLERANCE && Math.abs(clip.trimOut - clip.duration) <= COPY_TRIM_TOLERANCE;

/**
 * Every reason this clip set cannot take a copy path (native return / concat
 * "-c copy" remux), each one named specifically enough that a phone screenshot
 * of the export log pinpoints the disqualifying clip and condition. An empty
 * array means the set is copy-eligible (the multi-clip remux additionally
 * needs the codec/matrix probe or recorder provenance — see remuxProbeDecision).
 */
export function copyPathRejections(
  clips: GateClip[],
  blobTypes: string[],
  output: { width: number; height: number },
): string[] {
  const reasons: string[] = [];
  clips.forEach((clip, i) => {
    const n = i + 1;
    const mime = clip.mimeType || blobTypes[i] || '';
    if (!(clip.mimeType.includes('mp4') || (blobTypes[i] ?? '').includes('mp4'))) {
      reasons.push(`clip ${n} is not MP4 (${mime || 'unknown type'})`);
    }
    if (!isUntrimmed(clip)) {
      reasons.push(
        `clip ${n} trimmed (in=${clip.trimIn.toFixed(3)}s out=${clip.trimOut.toFixed(3)}s of ${clip.duration.toFixed(3)}s, tolerance=${COPY_TRIM_TOLERANCE}s)`,
      );
    }
    if (!clipMatchesOutput(clip, output)) {
      reasons.push(`clip ${n} dims ${clip.width}x${clip.height} vs output ${output.width}x${output.height}`);
    }
    if (clips.length > 1 && clip.mimeType !== clips[0].mimeType) {
      reasons.push(`clip ${n} mimeType "${clip.mimeType}" vs clip 1 "${clips[0].mimeType}"`);
    }
  });
  return reasons;
}

export type ExportPathPreview = {
  path: 'native' | 'join' | 'render';
  headline: string;
  detail: string;
  rejections: string[];
};

/**
 * Honest preflight copy for the export sheet. This is deliberately based on
 * the same gate as exportMp4: the UI must never label an export "fast" while
 * the worker already knows it will rebuild every frame. A multi-clip join is
 * still described as a candidate because its codec/rotation probe happens
 * after the blobs are opened.
 */
export function previewExportPath(
  clips: GateClip[],
  blobTypes: string[],
  output: { width: number; height: number },
): ExportPathPreview {
  const rejections = copyPathRejections(clips, blobTypes, output);
  if (!rejections.length && clips.length === 1) {
    return {
      path: 'native',
      headline: 'Fast export ready',
      detail: 'Uses the camera file without re-encoding the video.',
      rejections,
    };
  }
  if (!rejections.length && clips.length > 1) {
    return {
      path: 'join',
      headline: 'Fast join available',
      detail: 'Copies compatible video frames and smooths audio at each clip boundary.',
      rejections,
    };
  }

  let detail = 'This edit must rebuild the video on this device and may take longer than the recorded clip.';
  if (rejections.some((reason) => reason.includes('trimmed'))) {
    detail = 'A clip was trimmed or split, so this device must rebuild the edited frames.';
  } else if (rejections.some((reason) => reason.includes(' dims '))) {
    detail = 'The recorded frame does not match this output size, so this device must resize and rebuild it.';
  } else if (rejections.some((reason) => reason.includes('not MP4'))) {
    detail = 'A source clip is not MP4, so this device must convert it.';
  } else if (rejections.some((reason) => reason.includes('mimeType'))) {
    detail = 'The clips use different recording formats, so this device must convert them.';
  }
  return { path: 'render', headline: 'Full render required', detail, rejections };
}

/**
 * Multi-clip remux verdict from the mp4box probe classification plus recorder
 * provenance. Clips recorded in-app with the SAME stamped recorder codec are
 * uniform by construction, so a probe that merely FAILED to parse them must
 * not veto the remux — that failure mode is common on real iOS Safari
 * MediaRecorder files and was silently forcing slow transcodes. A probe that
 * positively found a mismatch always vetoes; imports and unstamped/codec-drifted
 * recordings (see recorderProvenanceTrust) always require the full strict probe.
 */
export function remuxProbeDecision(
  classification: Mp4CopySafety,
  provenance: { trusted: boolean; reason: string },
): { allow: boolean; reason: string } {
  if (classification === 'uniform') {
    return { allow: true, reason: 'probe uniform (codec+dims+rotation matrix) — copy-safe' };
  }
  if (classification === 'mismatch') {
    return { allow: false, reason: 'probe found codec/dims/rotation-matrix mismatch — transcoding' };
  }
  if (provenance.trusted) {
    return {
      allow: true,
      reason: `probe inconclusive, but recorder provenance is trusted (${provenance.reason}) — copy-safe`,
    };
  }
  return { allow: false, reason: `probe inconclusive and provenance untrusted (${provenance.reason}) — transcoding` };
}
