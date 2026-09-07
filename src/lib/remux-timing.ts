export interface RemuxVideoTiming {
  /** Duration occupied by actual video samples, excluding an empty edit. */
  sampleDurationSeconds: number;
  /** Initial empty edit that delays the first displayed video frame. */
  leadingEmptyEditSeconds: number;
}

type Mp4TrackTiming = {
  samples_duration?: number;
  duration?: number;
  timescale?: number;
  movie_timescale?: number;
  edits?: Array<{ segment_duration?: number; media_time?: number }>;
};

/** Read the two values needed to remove MP4 edit-list pauses at copied joins. */
export function remuxVideoTiming(track?: Mp4TrackTiming | null): RemuxVideoTiming | null {
  const timescale = track?.timescale ?? 0;
  const samplesDuration = track?.samples_duration || track?.duration || 0;
  if (!(timescale > 0) || !(samplesDuration > 0)) return null;

  let leadingEmptyEditSeconds = 0;
  for (const edit of track?.edits ?? []) {
    if (edit.media_time !== -1) break;
    const movieTimescale = track?.movie_timescale ?? 0;
    const segmentDuration = edit.segment_duration ?? 0;
    if (!(movieTimescale > 0) || !(segmentDuration >= 0)) return null;
    leadingEmptyEditSeconds += segmentDuration / movieTimescale;
  }

  const sampleDurationSeconds = samplesDuration / timescale;
  if (!Number.isFinite(sampleDurationSeconds) || !Number.isFinite(leadingEmptyEditSeconds)) return null;
  return { sampleDurationSeconds, leadingEmptyEditSeconds };
}

/**
 * Build an ffconcat manifest that treats each clip as video-only time.
 *
 * MP4 files commonly end audio a packet after video and can begin video with
 * a short empty edit. The concat demuxer's default file-duration offsets keep
 * both pauses, producing a visible 50-60 ms hold at an otherwise copied cut.
 * `inpoint` removes the leading empty edit and `duration` advances the next
 * clip by exactly the current video sample duration, without decoding frames.
 */
export function concatVideoManifest(
  inputs: string[],
  timings?: Array<RemuxVideoTiming | null> | null,
): string {
  const complete = timings?.length === inputs.length && timings.every((timing) =>
    !!timing && Number.isFinite(timing.sampleDurationSeconds) && Number.isFinite(timing.leadingEmptyEditSeconds)
      && timing.sampleDurationSeconds > 0 && timing.leadingEmptyEditSeconds >= 0,
  );
  if (!complete) return inputs.map((name) => `file '${name}'`).join('\n');

  return inputs.flatMap((name, index) => {
    const timing = timings[index]!;
    const lines = [
      `file '${name}'`,
      `inpoint ${timing.leadingEmptyEditSeconds.toFixed(6)}`,
    ];
    if (index + 1 < inputs.length) lines.push(`duration ${timing.sampleDurationSeconds.toFixed(6)}`);
    return lines;
  }).join('\n');
}
