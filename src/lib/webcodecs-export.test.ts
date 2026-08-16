import { describe, expect, it } from 'vitest';
import { avcLevelFor } from './webcodecs-export';

// H.264 Annex A, Table A-1: level must satisfy both MaxFS (frame size in
// macroblocks) and MaxMBPS (macroblocks per second).
describe('avcLevelFor', () => {
  it('selects level 4.0 for 1080x1920 at 30fps', () => {
    // 68x120 = 8160 MBs <= 8192; 244,800 MB/s <= 245,760.
    expect(avcLevelFor(1080, 1920, 30)).toBe(0x28);
  });

  it('selects level 4.2 for 1080x1920 at 60fps', () => {
    // 8160 MBs, 489,600 MB/s: exceeds 4.0's 245,760, fits 4.2's 522,240.
    expect(avcLevelFor(1080, 1920, 60)).toBe(0x2a);
  });

  it('selects level 5.1 for 2160x3840 at 30fps', () => {
    // 135x240 = 32,400 MBs <= 36,864; 972,000 MB/s <= 983,040 (98.9% of cap).
    expect(avcLevelFor(2160, 3840, 30)).toBe(0x33);
  });

  it('selects level 5.2 for 2160x3840 at 60fps', () => {
    // 1,944,000 MB/s exceeds 5.1's 983,040 — the exact conformance violation
    // the derivation exists to prevent.
    expect(avcLevelFor(2160, 3840, 60)).toBe(0x34);
  });

  it('escalates to level 6.x for rates beyond 5.2', () => {
    expect(avcLevelFor(2160, 3840, 120)).toBe(0x3c); // 3,888,000 MB/s -> 6.0
    expect(avcLevelFor(4320, 7680, 30)).toBe(0x3c); // 8K frame size -> 6.0
  });

  it('clamps to the highest table entry rather than failing', () => {
    expect(avcLevelFor(4320, 7680, 120)).toBe(0x3d);
  });

  it('treats a zero/fractional fps as at least one frame per second', () => {
    expect(avcLevelFor(2160, 3840, 0)).toBe(0x33);
  });
});
