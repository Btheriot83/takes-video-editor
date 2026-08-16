import { describe, it, expect } from 'vitest';
import { mp4MetasShareCopyableCodec } from './mp4-meta';
import type { Mp4VideoMeta } from './mp4-meta';

// Real tkhd matrices as mp4box reports them (fixed-point 16.16 / 2.30).
const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
const ROT90 = [0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824];
const ROT270 = [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824];

const meta = (overrides: Partial<Mp4VideoMeta> = {}): Mp4VideoMeta => ({
  codec: 'avc1.640028',
  codedWidth: 3840,
  codedHeight: 2160,
  matrix: [...ROT90],
  ...overrides,
});

describe('mp4MetasShareCopyableCodec', () => {
  it('accepts identical codec + coded dims + rotation matrix', () => {
    expect(mp4MetasShareCopyableCodec([meta(), meta()])).toBe(true);
  });

  it('rejects mixed rotation matrices even when codec and coded dims match', () => {
    // 90° and 270° clips both DISPLAY portrait (they pass clipMatchesOutput),
    // but a concat "-c copy" keeps only the first tkhd matrix, so the 270°
    // clip would play 180° wrong. Must transcode.
    expect(mp4MetasShareCopyableCodec([meta({ matrix: [...ROT90] }), meta({ matrix: [...ROT270] })])).toBe(false);
  });

  it('rejects identity vs rotated matrix mixes', () => {
    expect(mp4MetasShareCopyableCodec([meta({ matrix: [...IDENTITY] }), meta({ matrix: [...ROT90] })])).toBe(false);
  });

  it('treats a missing or malformed matrix as doubt', () => {
    expect(mp4MetasShareCopyableCodec([meta(), meta({ matrix: null })])).toBe(false);
    expect(mp4MetasShareCopyableCodec([meta({ matrix: [65536, 0, 0] })])).toBe(false);
  });

  it('rejects null metas, codec mismatches, and coded-dim mismatches', () => {
    expect(mp4MetasShareCopyableCodec([meta(), null])).toBe(false);
    expect(mp4MetasShareCopyableCodec([meta(), meta({ codec: 'hvc1.1.6.L120' })])).toBe(false);
    expect(mp4MetasShareCopyableCodec([meta(), meta({ codedWidth: 2160, codedHeight: 3840 })])).toBe(false);
    expect(mp4MetasShareCopyableCodec([])).toBe(false);
  });

  it('rejects non-copy-safe codecs outright', () => {
    expect(mp4MetasShareCopyableCodec([meta({ codec: 'mp4v.20.9' })])).toBe(false);
  });

  it('accepts uniform vp09 (Chrome MediaRecorder vp9-in-mp4)', () => {
    const vp9 = meta({ codec: 'vp09.00.51.08', matrix: [...IDENTITY] });
    expect(mp4MetasShareCopyableCodec([vp9, meta({ codec: 'vp09.00.51.08', matrix: [...IDENTITY] })])).toBe(true);
  });
});
