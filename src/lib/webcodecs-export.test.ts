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

import { bitstreamIsSync, naluLengthSize } from './webcodecs-export';

const nalu = (lengthSize: number, header: number, payload = 2) => {
  const len = payload + 1;
  const bytes = [];
  for (let i = lengthSize - 1; i >= 0; i--) bytes.push((len >> (8 * i)) & 0xff);
  bytes.push(header);
  for (let i = 0; i < payload; i++) bytes.push(0);
  return bytes;
};

describe('bitstreamIsSync', () => {
  it('detects an H.264 IDR slice as sync', () => {
    // SPS (7) + PPS (8) + IDR (5)
    const data = new Uint8Array([...nalu(4, 0x67), ...nalu(4, 0x68), ...nalu(4, 0x65)]);
    expect(bitstreamIsSync(data, 4, 'avc')).toBe(true);
  });

  it('detects an H.264 non-IDR slice as delta — the fMP4 all-sync trap', () => {
    // Fragmented MP4 default sample flags can mark every sample sync; the
    // bitstream (non-IDR slice, type 1) is authoritative.
    const data = new Uint8Array(nalu(4, 0x41)); // nal_ref_idc=2, type 1
    expect(bitstreamIsSync(data, 4, 'avc')).toBe(false);
  });

  it('honors non-default NAL length prefix sizes', () => {
    const data = new Uint8Array(nalu(2, 0x65));
    expect(bitstreamIsSync(data, 2, 'avc')).toBe(true);
  });

  it('detects HEVC IRAP as sync and non-IRAP as delta', () => {
    const idr = new Uint8Array(nalu(4, 19 << 1)); // IDR_W_RADL (19)
    const trail = new Uint8Array(nalu(4, 1 << 1)); // TRAIL_R (1)
    expect(bitstreamIsSync(idr, 4, 'hevc')).toBe(true);
    expect(bitstreamIsSync(trail, 4, 'hevc')).toBe(false);
  });

  it('returns null on unparsable bitstreams (fallback to container flag)', () => {
    expect(bitstreamIsSync(new Uint8Array([0, 0, 0, 200, 0x65]), 4, 'avc')).toBe(null);
    expect(bitstreamIsSync(new Uint8Array([]), 4, 'avc')).toBe(null);
  });
});

describe('naluLengthSize', () => {
  it('reads lengthSizeMinusOne from avcC byte 4', () => {
    const avcC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff]); // 0xff & 3 = 3 -> 4
    expect(naluLengthSize(avcC, 'avc')).toBe(4);
    const avcC2 = new Uint8Array([1, 0x64, 0x00, 0x28, 0xfd]); // & 3 = 1 -> 2
    expect(naluLengthSize(avcC2, 'avc')).toBe(2);
  });

  it('defaults to 4 without a description', () => {
    expect(naluLengthSize(undefined, 'avc')).toBe(4);
  });
});
