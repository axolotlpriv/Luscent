/**
 * Waveform peak pyramid. Level 0 stores min/max per `baseBucket` samples;
 * every further level halves the resolution. The timeline picks the level
 * closest to its current samples-per-pixel so drawing stays O(pixels).
 */
export interface PeakLevel {
  samplesPerBucket: number;
  /** Interleaved [min0, max0, min1, max1, ...] in -1..1. */
  data: Float32Array;
}

export interface Peaks {
  sampleRate: number;
  length: number;
  levels: PeakLevel[];
}

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

export function computePeaks(mono: Float32Array, sampleRate: number, baseBucket = 128): Peaks {
  const buckets = Math.ceil(mono.length / baseBucket);
  const base = new Float32Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    let mn = 1;
    let mx = -1;
    const end = Math.min(mono.length, (b + 1) * baseBucket);
    for (let i = b * baseBucket; i < end; i++) {
      const v = mono[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn > mx) mn = mx = 0;
    base[b * 2] = mn;
    base[b * 2 + 1] = mx;
  }
  const levels: PeakLevel[] = [{ samplesPerBucket: baseBucket, data: base }];
  let prev = base;
  let spb = baseBucket;
  while (prev.length > 2 * 64) {
    const n = Math.ceil(prev.length / 4);
    const next = new Float32Array(n * 2);
    for (let b = 0; b < n; b++) {
      const i0 = b * 4;
      const a0 = prev[i0];
      const a1 = prev[i0 + 1];
      const hasB = i0 + 2 < prev.length;
      next[b * 2] = hasB ? Math.min(a0, prev[i0 + 2]) : a0;
      next[b * 2 + 1] = hasB ? Math.max(a1, prev[i0 + 3]) : a1;
    }
    spb *= 2;
    levels.push({ samplesPerBucket: spb, data: next });
    prev = next;
  }
  return { sampleRate, length: mono.length, levels };
}

/** Pick the coarsest level that still has at least one bucket per pixel. */
export function pickLevel(peaks: Peaks, samplesPerPixel: number): PeakLevel {
  let chosen = peaks.levels[0];
  for (const lv of peaks.levels) if (lv.samplesPerBucket <= samplesPerPixel) chosen = lv;
  return chosen;
}
