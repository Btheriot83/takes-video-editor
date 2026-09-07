/** Generate N evenly-spaced thumbnails for a video blob. */
export async function makeThumbs(blob: Blob, count = 4, w = 72): Promise<string[]> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  try {
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    await new Promise<void>((res, rej) => {
      const timeout = window.setTimeout(() => rej(new Error('thumb load timed out')), 4000);
      v.onloadeddata = () => { window.clearTimeout(timeout); res(); };
      v.onerror = () => { window.clearTimeout(timeout); rej(new Error('thumb load failed')); };
    });
    let dur = v.duration;
    if (dur === Infinity || isNaN(dur)) {
      await seek(v, 1e7);
      dur = v.currentTime;
    }
    const scale = v.videoWidth ? w / v.videoWidth : 1;
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(dur - 0.05, (dur * (i + 0.5)) / count);
      await seek(v, Math.max(0, t));
      ctx.drawImage(v, 0, 0, w, h);
      out.push(canvas.toDataURL('image/jpeg', 0.6));
    }
    return out;
  } finally {
    // Release the mobile decoder promptly; revoking the URL alone can leave
    // the media resource retained until garbage collection.
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const to = setTimeout(() => res(), 1500); // don't hang on broken seeks
    v.onseeked = () => { clearTimeout(to); res(); };
    v.currentTime = t;
  });
}
