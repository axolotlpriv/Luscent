/** Deterministic 1-D gradient noise and fractal wiggle (AE-compatible feel). */
import type { PropValue, Wiggle } from '../model/types';

function hash(i: number, seed: number): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth gradient noise in roughly [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = hash(i, seed);
  const g1 = hash(i + 1, seed);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  // Gradient noise: slopes at lattice points, scaled to ~[-1, 1].
  return (g0 * f * (1 - u) + g1 * (f - 1) * u) * 2.2;
}

export function fractalNoise(x: number, octaves: number, ampMult: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  const n = Math.max(1, Math.min(8, Math.round(octaves)));
  for (let o = 0; o < n; o++) {
    sum += noise1(x * freq, seed + o * 101) * amp;
    norm += amp;
    amp *= ampMult;
    freq *= 2;
  }
  return sum / norm;
}

/** Offset a value by its wiggle at layer time t (each dimension independent). */
export function applyWiggle<T extends PropValue>(value: T, w: Wiggle, t: number): T {
  const off = (dim: number) => w.amp * fractalNoise(t * w.freq, w.octaves, w.ampMult, w.seed * 31 + dim * 7919);
  if (typeof value === 'number') return (value + off(0)) as T;
  // Colours wiggle RGB together (keep alpha); vectors per axis.
  if (value.length === 4) {
    const o = off(0) / 100;
    return [value[0] + o, value[1] + o, value[2] + o, value[3]] as T;
  }
  return value.map((v, i) => v + off(i)) as T;
}
