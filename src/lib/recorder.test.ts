import { describe, it, expect } from 'vitest';
import { captureConstraints, captureVideoBitrate, ultraHDRetryConstraints } from './recorder';
import { CAPTURE_DIMENSIONS, isUltraHDCapture } from '../types/clip';

describe('captureConstraints', () => {
  it('requests portrait 1080x1920 at 30fps for HD', () => {
    const c = captureConstraints('environment', 'HD');
    expect(c.width).toEqual({ ideal: 1080 });
    expect(c.height).toEqual({ ideal: 1920 });
    expect(c.frameRate).toEqual({ ideal: 30, max: 30 });
    expect(c.facingMode).toEqual({ ideal: 'environment' });
  });
  it('requests the front 4K sensor in its primary landscape orientation', () => {
    const c = captureConstraints('user', '4K');
    expect(c.width).toEqual({ ideal: 3840 });
    expect(c.height).toEqual({ ideal: 2160 });
    expect(c.aspectRatio).toEqual({ ideal: 16 / 9 });
    expect(c.frameRate).toEqual({ ideal: 30, max: 30 });
    expect(c.facingMode).toEqual({ ideal: 'user' });
    expect(c.resizeMode).toEqual({ exact: 'none' });
  });
  it('lets WebKit rotate a native front-camera mode instead of boxing a landscape stream', () => {
    const front = captureConstraints('user', 'HD');
    expect(front.width).toEqual({ ideal: 1920 });
    expect(front.height).toEqual({ ideal: 1080 });
    expect(front.aspectRatio).toEqual({ ideal: 16 / 9 });
    expect(front.resizeMode).toEqual({ exact: 'none' });
    expect(captureConstraints('environment', 'HD').resizeMode).toBeUndefined();
  });
  it('capture dimensions stay portrait (width < height)', () => {
    for (const { width, height } of Object.values(CAPTURE_DIMENSIONS)) {
      expect(width).toBeLessThan(height);
    }
  });
});

describe('ultraHDRetryConstraints', () => {
  it('retries with landscape 3840x2160 ideals (iOS lists camera modes in landscape)', () => {
    const c = ultraHDRetryConstraints('environment');
    expect(c.width).toEqual({ ideal: 3840 });
    expect(c.height).toEqual({ ideal: 2160 });
    expect(c.facingMode).toEqual({ ideal: 'environment' });
  });
  it('keeps the 30fps ceiling on the retry', () => {
    expect(ultraHDRetryConstraints('user').frameRate).toEqual({ ideal: 30, max: 30 });
    expect(ultraHDRetryConstraints('user').resizeMode).toEqual({ exact: 'none' });
  });
  it('offers advanced sets for both orientations, landscape first', () => {
    const c = ultraHDRetryConstraints('user');
    expect(c.advanced).toEqual([
      { width: 3840, height: 2160 },
      { width: 2160, height: 3840 },
    ]);
    for (const set of c.advanced ?? []) {
      expect(isUltraHDCapture(set.width as number, set.height as number)).toBe(true);
    }
  });
});

describe('isUltraHDCapture', () => {
  it('accepts portrait and landscape 4K-class sizes', () => {
    expect(isUltraHDCapture(2160, 3840)).toBe(true);
    expect(isUltraHDCapture(3840, 2160)).toBe(true);
  });
  it('rejects HD, missing, and partial sizes', () => {
    expect(isUltraHDCapture(1080, 1920)).toBe(false);
    expect(isUltraHDCapture(1920, 3840)).toBe(false);
    expect(isUltraHDCapture(undefined, undefined)).toBe(false);
    expect(isUltraHDCapture(2160, undefined)).toBe(false);
  });
});

describe('captureVideoBitrate', () => {
  it('uses ~30 Mbps for delivered 4K frames', () => {
    expect(captureVideoBitrate(2160, 3840)).toBe(30_000_000);
    expect(captureVideoBitrate(3840, 2160)).toBe(30_000_000);
  });
  it('keeps the proven 6 Mbps rate when the camera fell back below 4K', () => {
    expect(captureVideoBitrate(1080, 1920)).toBe(6_000_000);
    expect(captureVideoBitrate(1280, 720)).toBe(6_000_000);
    expect(captureVideoBitrate(undefined, undefined)).toBe(6_000_000);
  });
});
