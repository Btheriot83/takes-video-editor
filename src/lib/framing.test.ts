import { describe, expect, it } from 'vitest';
import { framePlacement } from './framing';

describe('framePlacement', () => {
  it('keeps the complete 3:4 selfie frame inside a 9:16 output', () => {
    expect(framePlacement(1080, 1440, 1080, 1920, 'contain')).toEqual({
      source: { x: 0, y: 0, width: 1080, height: 1440 },
      output: { x: 0, y: 240, width: 1080, height: 1440 },
    });
  });

  it('retains the existing centered cover crop for rear and legacy clips', () => {
    expect(framePlacement(1080, 1440, 1080, 1920, 'cover')).toEqual({
      source: { x: 135, y: 0, width: 810, height: 1440 },
      output: { x: 0, y: 0, width: 1080, height: 1920 },
    });
  });

  it('rejects missing dimensions instead of emitting invalid draw math', () => {
    expect(() => framePlacement(0, 1440, 1080, 1920, 'contain')).toThrow('frame dimensions must be positive');
  });
});
