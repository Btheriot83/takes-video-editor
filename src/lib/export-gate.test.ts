import { describe, it, expect } from 'vitest';
import { COPY_TRIM_TOLERANCE, copyPathRejections, isUntrimmed, previewExportPath, recorderProvenanceTrust, remuxProbeDecision } from './export-gate';
import type { GateClip } from './export-gate';

const clip = (overrides: Partial<GateClip> = {}): GateClip => ({
  mimeType: 'video/mp4',
  source: 'recording',
  recorderMimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
  duration: 4.2,
  trimIn: 0,
  trimOut: 4.2,
  width: 1080,
  height: 1920,
  ...overrides,
});

const out1080 = { width: 1080, height: 1920 };

describe('isUntrimmed (widened copy-path trim tolerance)', () => {
  it('accepts exact untrimmed bounds', () => {
    expect(isUntrimmed({ trimIn: 0, trimOut: 4.2, duration: 4.2 })).toBe(true);
  });

  it('tolerates VFR probe drift up to ~one 30fps frame on real recordings', () => {
    // iOS Safari MediaRecorder: probeVideo's element duration can drift from
    // container trim bounds by more than the old 1/60s. 25ms must now pass.
    expect(isUntrimmed({ trimIn: 0, trimOut: 4.175, duration: 4.2 })).toBe(true);
    expect(isUntrimmed({ trimIn: 0.025, trimOut: 4.2, duration: 4.2 })).toBe(true);
    // The old tolerance would have rejected this (0.02 > 1/60).
    expect(0.02).toBeGreaterThan(1 / 60);
    expect(isUntrimmed({ trimIn: 0, trimOut: 4.18, duration: 4.2 })).toBe(true);
  });

  it('still rejects a deliberate one-frame trim (editor step = round3(1/30) = 0.033)', () => {
    expect(COPY_TRIM_TOLERANCE).toBeLessThan(0.033);
    expect(isUntrimmed({ trimIn: 0.033, trimOut: 4.2, duration: 4.2 })).toBe(false);
    expect(isUntrimmed({ trimIn: 0, trimOut: 4.167, duration: 4.2 })).toBe(false);
  });

  it('rejects clearly trimmed clips', () => {
    expect(isUntrimmed({ trimIn: 0.5, trimOut: 4.2, duration: 4.2 })).toBe(false);
    expect(isUntrimmed({ trimIn: 0, trimOut: 3.0, duration: 4.2 })).toBe(false);
  });
});

describe('copyPathRejections (named gate decisions)', () => {
  it('returns no rejections for a uniform untrimmed matching set', () => {
    expect(copyPathRejections([clip(), clip()], ['video/mp4', 'video/mp4'], out1080)).toEqual([]);
  });

  it('names the trimmed clip', () => {
    const reasons = copyPathRejections([clip(), clip({ trimIn: 0.5 })], ['video/mp4', 'video/mp4'], out1080);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^clip 2 trimmed/);
  });

  it('names the dims mismatch with both sizes', () => {
    const reasons = copyPathRejections([clip()], ['video/mp4'], { width: 2160, height: 3840 });
    expect(reasons).toEqual(['clip 1 dims 1080x1920 vs output 2160x3840']);
  });

  it('names non-MP4 clips', () => {
    const reasons = copyPathRejections([clip({ mimeType: 'video/webm' })], ['video/webm'], out1080);
    expect(reasons.some((r) => r.startsWith('clip 1 is not MP4'))).toBe(true);
  });

  it('falls back to the blob type when the clip mimeType is empty', () => {
    // iOS can hand back a Blob with a type even when the recorder reported ''.
    const reasons = copyPathRejections([clip({ mimeType: '' })], ['video/mp4'], out1080);
    expect(reasons.filter((r) => r.includes('not MP4'))).toEqual([]);
  });

  it('names mimeType disagreement across a multi-clip set', () => {
    const reasons = copyPathRejections(
      [clip(), clip({ mimeType: 'video/mp4;codecs=avc1' })],
      ['video/mp4', 'video/mp4'],
      out1080,
    );
    expect(reasons).toEqual(['clip 2 mimeType "video/mp4;codecs=avc1" vs clip 1 "video/mp4"']);
  });

  it('collects multiple named reasons at once', () => {
    const reasons = copyPathRejections(
      [clip({ trimIn: 1 }), clip({ width: 2160, height: 3840 })],
      ['video/mp4', 'video/mp4'],
      out1080,
    );
    expect(reasons.some((r) => r.startsWith('clip 1 trimmed'))).toBe(true);
    expect(reasons.some((r) => r === 'clip 2 dims 2160x3840 vs output 1080x1920')).toBe(true);
  });
});

describe('previewExportPath (honest pre-export UI)', () => {
  it('labels one untouched matching recording as a native fast export', () => {
    expect(previewExportPath([clip()], ['video/mp4'], out1080)).toMatchObject({
      path: 'native',
      headline: 'Fast export ready',
      rejections: [],
    });
  });

  it('labels a matching recording set as a candidate fast join', () => {
    expect(previewExportPath([clip(), clip()], ['video/mp4', 'video/mp4'], out1080)).toMatchObject({
      path: 'join',
      headline: 'Fast join available',
      rejections: [],
    });
  });

  it('warns before a dimension-mismatch render starts', () => {
    const plan = previewExportPath([clip({ width: 1440, height: 1920 })], ['video/mp4'], out1080);
    expect(plan.path).toBe('render');
    expect(plan.detail).toMatch(/does not match this output size/);
    expect(plan.rejections).toEqual(['clip 1 dims 1440x1920 vs output 1080x1920']);
  });

  it('explains that a trim or split requires rebuilt frames', () => {
    const plan = previewExportPath([clip({ trimIn: 0.5 })], ['video/mp4'], out1080);
    expect(plan.path).toBe('render');
    expect(plan.detail).toMatch(/trimmed or split/);
  });
});

describe('recorderProvenanceTrust (codec stamp binding)', () => {
  it('trusts an all-recording set with an identical non-empty codec stamp', () => {
    const trust = recorderProvenanceTrust([clip(), clip()]);
    expect(trust.trusted).toBe(true);
    expect(trust.reason).toContain('avc1.640028');
  });

  it('denies any set containing an import', () => {
    const trust = recorderProvenanceTrust([clip(), clip({ source: 'import' })]);
    expect(trust.trusted).toBe(false);
    expect(trust.reason).toMatch(/import/);
  });

  it('denies codec drift across sessions (avc1 -> hvc1 after a browser update)', () => {
    // Both clips are 'recording', both mimeTypes bare video/mp4 — only the
    // record-time stamp distinguishes them. Blind trust here would concat
    // "-c copy" mixed codecs, which ffmpeg exits 0 on (corrupt output).
    const trust = recorderProvenanceTrust([
      clip({ recorderMimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2' }),
      clip({ recorderMimeType: 'video/mp4;codecs=hvc1.1.6.L120.B0,mp4a.40.2' }),
    ]);
    expect(trust.trusted).toBe(false);
    expect(trust.reason).toMatch(/codec drift: clip 2/);
    expect(trust.reason).toContain('hvc1');
  });

  it('denies legacy recordings missing the stamp (falls back to the strict probe)', () => {
    expect(recorderProvenanceTrust([clip(), clip({ recorderMimeType: undefined })]).trusted).toBe(false);
    expect(recorderProvenanceTrust([clip({ recorderMimeType: '' }), clip()]).trusted).toBe(false);
    expect(recorderProvenanceTrust([clip(), clip({ recorderMimeType: undefined })]).reason).toMatch(/no recorder codec stamp/);
  });

  it('denies an empty set', () => {
    expect(recorderProvenanceTrust([]).trusted).toBe(false);
  });
});

describe('remuxProbeDecision (probe verdict x provenance)', () => {
  const trusted = { trusted: true, reason: 'all clips recorded in-app as "video/mp4;codecs=avc1"' };
  const untrusted = { trusted: false, reason: 'set includes imported clips' };

  it('allows a uniform probe regardless of provenance', () => {
    expect(remuxProbeDecision('uniform', trusted).allow).toBe(true);
    expect(remuxProbeDecision('uniform', untrusted).allow).toBe(true);
  });

  it('allows an inconclusive probe only under trusted recorder provenance', () => {
    const decision = remuxProbeDecision('unknown', trusted);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toMatch(/recorder provenance is trusted/);
  });

  it('denies an inconclusive probe when provenance is untrusted (imports, legacy, drift)', () => {
    const decision = remuxProbeDecision('unknown', untrusted);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/provenance untrusted/);
  });

  it('denies a positive mismatch even under trusted provenance (mixed-rotation hole stays closed)', () => {
    expect(remuxProbeDecision('mismatch', trusted).allow).toBe(false);
    expect(remuxProbeDecision('mismatch', untrusted).allow).toBe(false);
  });

  it('end-to-end: codec-drifted recordings with an inconclusive probe must transcode', () => {
    const drifted = recorderProvenanceTrust([
      clip({ recorderMimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2' }),
      clip({ recorderMimeType: 'video/mp4;codecs=hvc1.1.6.L120.B0,mp4a.40.2' }),
    ]);
    expect(remuxProbeDecision('unknown', drifted).allow).toBe(false);
  });

  it('end-to-end: stamped same-codec recordings with an inconclusive probe still remux', () => {
    expect(remuxProbeDecision('unknown', recorderProvenanceTrust([clip(), clip()])).allow).toBe(true);
  });
});
