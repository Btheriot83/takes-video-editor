import { describe, expect, it } from 'vitest';
import { concatVideoManifest, remuxVideoTiming } from './remux-timing';

describe('remuxVideoTiming', () => {
  it('reads video sample duration and a leading empty edit', () => {
    expect(remuxVideoTiming({
      samples_duration: 330_373,
      timescale: 57_600,
      movie_timescale: 1_000,
      edits: [
        { segment_duration: 16, media_time: -1 },
        { segment_duration: 5_736, media_time: 0 },
      ],
    })).toEqual({
      sampleDurationSeconds: 330_373 / 57_600,
      leadingEmptyEditSeconds: 0.016,
    });
  });

  it('does not treat a positive media edit as a leading pause', () => {
    expect(remuxVideoTiming({
      duration: 108_544,
      timescale: 15_360,
      movie_timescale: 1_000,
      edits: [{ segment_duration: 7_067, media_time: 1_024 }],
    })?.leadingEmptyEditSeconds).toBe(0);
  });

  it('rejects incomplete timing metadata', () => {
    expect(remuxVideoTiming({ samples_duration: 100 })).toBeNull();
    expect(remuxVideoTiming({ samples_duration: 100, timescale: 0 })).toBeNull();
  });
});

describe('concatVideoManifest', () => {
  it('normalizes copied clip starts and advances by video sample duration', () => {
    expect(concatVideoManifest(['in0.mp4', 'in1.mp4'], [
      { sampleDurationSeconds: 5.735729, leadingEmptyEditSeconds: 0 },
      { sampleDurationSeconds: 5.735642, leadingEmptyEditSeconds: 0.016 },
    ])).toBe([
      "file 'in0.mp4'",
      'inpoint 0.000000',
      'duration 5.735729',
      "file 'in1.mp4'",
      'inpoint 0.016000',
    ].join('\n'));
  });

  it('falls back to the basic manifest when any timing is unknown', () => {
    expect(concatVideoManifest(['in0.mp4', 'in1.mp4'], [
      { sampleDurationSeconds: 1, leadingEmptyEditSeconds: 0 },
      null,
    ])).toBe("file 'in0.mp4'\nfile 'in1.mp4'");
  });
});
