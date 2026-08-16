import { describe, it, expect } from 'vitest';
import { clipFraming, clipMatchesOutput, exportDimensions, isUltraHDCapture } from './clip';

const out4kPortrait = exportDimensions('16:9', '4K'); // 2160x3840

describe('clipMatchesOutput (display-dimension copy-path predicate)', () => {
  it('matches a portrait 4K capture to portrait 4K output', () => {
    expect(clipMatchesOutput({ width: 2160, height: 3840 }, out4kPortrait)).toBe(true);
  });

  it('matches a rotation-flagged landscape 4K capture (stored as display dims)', () => {
    // The iOS 4K landscape retry records 3840x2160 pixels with a 90° rotation
    // matrix. probeVideo stores DISPLAY dims (videoWidth/videoHeight apply the
    // matrix), so such a clip arrives here already as 2160x3840 and may remux.
    const rotatedClipAsStored = { width: 2160, height: 3840 };
    expect(clipMatchesOutput(rotatedClipAsStored, out4kPortrait)).toBe(true);
  });

  it('rejects a true landscape-encoded stream without a rotation flag (transposed dims)', () => {
    // No rotation matrix -> display dims stay landscape. A remux cannot rotate
    // pixels, so this must transcode even though it is "4K-sized".
    expect(clipMatchesOutput({ width: 3840, height: 2160 }, out4kPortrait)).toBe(false);
  });

  it('rejects same-width different-aspect sources (2160x2160 vs 2160x3840)', () => {
    // The 4K e2e fake capture records 2160x2160; a 16:9 portrait export needs
    // the scale/crop render — remuxing mismatched aspect would be wrong.
    expect(clipMatchesOutput({ width: 2160, height: 2160 }, out4kPortrait)).toBe(false);
  });

  it('matches 1:1 output only when the source is square at the same size', () => {
    const outSquare = exportDimensions('1:1', '4K'); // 2160x2160
    expect(clipMatchesOutput({ width: 2160, height: 2160 }, outSquare)).toBe(true);
    expect(clipMatchesOutput({ width: 2160, height: 3840 }, outSquare)).toBe(false);
  });

  it('rejects HD sources for 4K output (upscale must transcode)', () => {
    expect(clipMatchesOutput({ width: 1080, height: 1920 }, out4kPortrait)).toBe(false);
  });
});

describe('isUltraHDCapture', () => {
  it('accepts both orientations of 4K and rejects HD', () => {
    expect(isUltraHDCapture(2160, 3840)).toBe(true);
    expect(isUltraHDCapture(3840, 2160)).toBe(true);
    expect(isUltraHDCapture(2160, 2160)).toBe(true);
    expect(isUltraHDCapture(1080, 1920)).toBe(false);
    expect(isUltraHDCapture(undefined, undefined)).toBe(false);
  });
});

describe('clipFraming', () => {
  it('keeps legacy clips on cover and honors full-frame selfie clips', () => {
    expect(clipFraming({})).toBe('cover');
    expect(clipFraming({ framing: 'cover' })).toBe('cover');
    expect(clipFraming({ framing: 'contain' })).toBe('contain');
  });
});
