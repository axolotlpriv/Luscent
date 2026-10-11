import { cubicBezierAt } from './bezier';
import type { AnimProp, Keyframe, PropValue, TemporalEase } from '../model/types';

export function isAnimated(prop: AnimProp): boolean {
  return prop.keyframes.length > 0;
}

export function lerpValue<T extends PropValue>(a: T, b: T, p: number): T {
  if (typeof a === 'number') return (a + ((b as number) - a) * p) as T;
  const out = (a as number[]).map((av, i) => av + ((b as number[])[i] - av) * p);
  return out as T;
}

/** Euclidean distance between two values (path length of a linear segment). */
export function valueDistance(a: PropValue, b: PropValue): number {
  if (typeof a === 'number') return Math.abs((b as number) - a);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (b as number[])[i] - a[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Index of the last keyframe with time <= t, or -1. */
export function keyframeIndexAt(keys: Keyframe[], t: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface SegmentCurve {
  /** CSS-style normalised cubic bezier control points; null for linear/hold. */
  bezier: [number, number, number, number] | null;
  hold: boolean;
}

const clampInfluence = (i: number) => Math.min(1, Math.max(0.001, i));

/**
 * Normalised progress curve of the segment k0 -> k1.
 *
 * Follows the After Effects model: the outgoing handle of k0 leaves at
 * `outEase.speed` for `outEase.influence` of the segment, the incoming handle
 * of k1 arrives at `inEase.speed`. Speeds are measured along the straight
 * path between the two values so the same curve drives every dimension.
 * A linear side behaves like a handle pointing along the straight line.
 */
export function segmentCurve(k0: Keyframe, k1: Keyframe): SegmentCurve {
  if (k0.outInterp === 'hold') return { bezier: null, hold: true };
  if (k0.outInterp === 'linear' && k1.inInterp === 'linear') return { bezier: null, hold: false };
  const T = k1.time - k0.time;
  const L = valueDistance(k0.value, k1.value);
  if (T <= 0) return { bezier: null, hold: false };
  const avg = L / T;
  const out: TemporalEase = k0.outInterp === 'bezier' ? k0.outEase : { speed: avg, influence: 1 / 3 };
  const inn: TemporalEase = k1.inInterp === 'bezier' ? k1.inEase : { speed: avg, influence: 1 / 3 };
  const i0 = clampInfluence(out.influence);
  const i1 = clampInfluence(inn.influence);
  // With no value change the speeds cannot be normalised; treat as an S-curve.
  const y1 = L > 1e-9 ? (out.speed * i0 * T) / L : 0;
  const y2 = L > 1e-9 ? 1 - (inn.speed * i1 * T) / L : 1;
  return { bezier: [i0, y1, 1 - i1, y2], hold: false };
}

/** Normalised progress (0..1, may overshoot) through segment k0->k1 at time t. */
export function segmentProgress(k0: Keyframe, k1: Keyframe, t: number): number {
  const curve = segmentCurve(k0, k1);
  if (curve.hold) return 0;
  const T = k1.time - k0.time;
  if (T <= 0) return 1;
  const x = (t - k0.time) / T;
  if (!curve.bezier) return Math.min(1, Math.max(0, x));
  const [x1, y1, x2, y2] = curve.bezier;
  return cubicBezierAt(x1, y1, x2, y2, x);
}

/** Evaluate an animated property at layer time `t`. */
export function evaluateProp<T extends PropValue>(prop: AnimProp<T>, t: number): T {
  const keys = prop.keyframes;
  if (keys.length === 0) return prop.value;
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  const i = keyframeIndexAt(keys, t);
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const p = segmentProgress(k0, k1, t);
  if (p === 0) return k0.value;
  return lerpValue(k0.value, k1.value, p);
}

/**
 * Instantaneous speed (units/second along the segment path) at layer time t.
 * Used by the graph editor's speed graph and for "velocity" readouts.
 */
export function evaluateSpeed(prop: AnimProp, t: number): number {
  const keys = prop.keyframes;
  if (keys.length < 2) return 0;
  if (t < keys[0].time || t > keys[keys.length - 1].time) return 0;
  const i = Math.min(keyframeIndexAt(keys, t), keys.length - 2);
  const k0 = keys[Math.max(0, i)];
  const k1 = keys[Math.max(0, i) + 1];
  const T = k1.time - k0.time;
  if (T <= 0 || k0.outInterp === 'hold') return 0;
  const L = valueDistance(k0.value, k1.value);
  const h = Math.min(1e-3, T / 100);
  const ta = Math.max(k0.time, t - h);
  const tb = Math.min(k1.time, t + h);
  return ((segmentProgress(k0, k1, tb) - segmentProgress(k0, k1, ta)) * L) / (tb - ta);
}
