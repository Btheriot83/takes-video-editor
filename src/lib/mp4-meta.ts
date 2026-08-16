export interface Mp4VideoMeta {
  /** Full codec string of the first video track, e.g. "avc1.640028". */
  codec: string | null;
  /** Encoded (pre-rotation) sample dimensions. */
  codedWidth: number | null;
  codedHeight: number | null;
  /**
   * tkhd display/rotation matrix of the video track (9 fixed-point values).
   * null = unknown (probe could not read it) — treated as doubt.
   */
  matrix: number[] | null;
}

/**
 * Codecs the concat "-c copy" join may carry. avc/hevc are the camera-capture
 * codecs on phones; vp09 appears when Chrome muxes MediaRecorder VP9 into MP4
 * (bare "video/mp4" mimeType). Including it keeps the multi-clip join
 * consistent with the single-clip native path, which already returns such a
 * recording unchanged. Uniformity across clips is still required.
 */
const COPYABLE_CODEC = /^(avc1|avc3|hvc1|hev1|vp09)/;

/**
 * Decide whether a set of same-mimeType MP4 clips is uniform enough for the
 * concat "-c copy" remux when the mimeType itself carries no codec parameters
 * (iOS can report bare "video/mp4"). The metas come from the single mp4box
 * probe pass each blob already gets for fps/audio planning (probeMp4Blob), so
 * no extra parse happens for this check. Requires every clip to have probed
 * successfully with the SAME copy-safe codec string, identical encoded
 * dimensions AND an identical tkhd display/rotation matrix; any doubt (null
 * meta, missing codec/dims/matrix, mixed values) returns false and the caller
 * transcodes.
 *
 * The matrix requirement is load-bearing: two clips can share codec and coded
 * dimensions yet carry different rotation matrices (e.g. one recorded at 90°
 * and one at 270° — both DISPLAY portrait, so both pass clipMatchesOutput).
 * The concat "-c copy" output keeps only the first clip's tkhd matrix, so the
 * other clip would play 180° wrong. Confirmed by repro: rotation=90 +
 * rotation=270 clips concat-copy to a single rotation=90 file.
 */
export function mp4MetasShareCopyableCodec(metas: (Mp4VideoMeta | null)[]): boolean {
  if (!metas.length) return false;
  for (const meta of metas) {
    if (!meta?.codec || !COPYABLE_CODEC.test(meta.codec)) return false;
    if (!meta.codedWidth || !meta.codedHeight) return false;
    if (!meta.matrix || meta.matrix.length !== 9) return false;
  }
  const first = metas[0]!;
  return metas.every((meta) =>
    meta!.codec === first.codec &&
    meta!.codedWidth === first.codedWidth &&
    meta!.codedHeight === first.codedHeight &&
    meta!.matrix!.every((value, i) => value === first.matrix![i]),
  );
}
