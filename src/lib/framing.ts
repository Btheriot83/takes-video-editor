import type { ClipFraming } from '../types/clip';

export interface FramePlacement {
  source: { x: number; y: number; width: number; height: number };
  output: { x: number; y: number; width: number; height: number };
}

/**
 * Maps a source frame into an output frame using CSS-compatible cover/contain
 * semantics. Keeping this math shared prevents the WebGL, Canvas, and ffmpeg
 * export paths from drifting away from what the camera/editor previews show.
 */
export function framePlacement(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  framing: ClipFraming,
): FramePlacement {
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('frame dimensions must be positive');
  }

  if (framing === 'contain') {
    const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
    const width = Math.min(outputWidth, Math.max(1, Math.round(sourceWidth * scale)));
    const height = Math.min(outputHeight, Math.max(1, Math.round(sourceHeight * scale)));
    return {
      source: { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
      output: {
        x: Math.floor((outputWidth - width) / 2),
        y: Math.floor((outputHeight - height) / 2),
        width,
        height,
      },
    };
  }

  const scale = Math.max(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const width = Math.min(sourceWidth, Math.max(1, Math.round(outputWidth / scale)));
  const height = Math.min(sourceHeight, Math.max(1, Math.round(outputHeight / scale)));
  return {
    source: {
      x: Math.floor((sourceWidth - width) / 2),
      y: Math.floor((sourceHeight - height) / 2),
      width,
      height,
    },
    output: { x: 0, y: 0, width: outputWidth, height: outputHeight },
  };
}
