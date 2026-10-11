import { uid } from '../model/ids';
import type { AnimProp, Interpolation, Keyframe, PropValue, TemporalEase } from '../model/types';
import { evaluateKeys as evaluateProp, segmentCurve, valueDistance } from './interpolate';
import { easingById, type Bezier } from './easings';

/** Two keyframes closer than this (seconds) are considered the same time. */
export const KEY_EPSILON = 1e-4;

export const EASY_EASE: TemporalEase = { speed: 0, influence: 1 / 3 };
export const LINEAR_EASE: TemporalEase = { speed: 0, influence: 1 / 3 };

export function makeKeyframe<T extends PropValue>(time: number, value: T, interp: Interpolation = 'linear'): Keyframe<T> {
  return {
    id: uid('kf_'),
    time,
    value,
    inInterp: interp,
    outInterp: interp,
    inEase: { ...LINEAR_EASE },
    outEase: { ...LINEAR_EASE },
  };
}

function sortKeys<T extends PropValue>(keys: Keyframe<T>[]): Keyframe<T>[] {
  return keys.sort((a, b) => a.time - b.time);
}

function findAt<T extends PropValue>(prop: AnimProp<T>, t: number, eps: number): number {
  return prop.keyframes.findIndex((k) => Math.abs(k.time - t) <= eps);
}

/**
 * Set a value at time t. When the property is animated this creates or
 * updates a keyframe; otherwise it changes the static value. Returns a new
 * AnimProp (inputs are never mutated).
 */
export function setValueAt<T extends PropValue>(prop: AnimProp<T>, t: number, value: T, eps = KEY_EPSILON): AnimProp<T> {
  if (prop.keyframes.length === 0) return { ...prop, value };
  const idx = findAt(prop, t, eps);
  const keys = prop.keyframes.slice();
  if (idx >= 0) {
    keys[idx] = { ...keys[idx], value };
  } else {
    // Inherit interpolation from the preceding keyframe for continuity.
    const prev = [...keys].reverse().find((k) => k.time < t);
    const k = makeKeyframe(t, value, prev?.outInterp === 'hold' ? 'hold' : prev?.outInterp ?? 'linear');
    if (prev && prev.outInterp === 'bezier') {
      k.inEase = { ...EASY_EASE };
      k.outEase = { ...EASY_EASE };
    }
    keys.push(k);
    sortKeys(keys);
  }
  return { ...prop, keyframes: keys };
}

/** Add a keyframe at t holding the current animated value (no-op if one exists). */
export function addKeyframeAt<T extends PropValue>(prop: AnimProp<T>, t: number, eps = KEY_EPSILON): AnimProp<T> {
  if (findAt(prop, t, eps) >= 0) return prop;
  const value = evaluateProp(prop, t);
  if (prop.keyframes.length === 0) return { ...prop, keyframes: [makeKeyframe(t, value)] };
  return setValueAt(prop, t, value, eps);
}

/**
 * Toggle the stopwatch. Enabling creates a keyframe at t; disabling removes
 * all keyframes and freezes the value as evaluated at t.
 */
export function toggleAnimation<T extends PropValue>(prop: AnimProp<T>, t: number): AnimProp<T> {
  if (prop.keyframes.length > 0) return { ...prop, value: evaluateProp(prop, t), keyframes: [] };
  return { ...prop, value: prop.value, keyframes: [makeKeyframe(t, prop.value)] };
}

export function removeKeyframes<T extends PropValue>(prop: AnimProp<T>, ids: ReadonlySet<string>, t: number): AnimProp<T> {
  const keys = prop.keyframes.filter((k) => !ids.has(k.id));
  if (keys.length === prop.keyframes.length) return prop;
  // Removing the last keyframe leaves the property static at its value at t.
  if (keys.length === 0) return { ...prop, value: evaluateProp(prop, t), keyframes: [] };
  return { ...prop, keyframes: keys };
}

/**
 * Move keyframes by dt. Moved keyframes win collisions with stationary ones.
 * `quantize` lets callers snap the resulting times to frames.
 */
export function moveKeyframes<T extends PropValue>(
  prop: AnimProp<T>,
  ids: ReadonlySet<string>,
  dt: number,
  quantize: (t: number) => number = (t) => t,
): AnimProp<T> {
  if (dt === 0) return prop;
  const moved: Keyframe<T>[] = [];
  const rest: Keyframe<T>[] = [];
  for (const k of prop.keyframes) {
    if (ids.has(k.id)) moved.push({ ...k, time: quantize(k.time + dt) });
    else rest.push(k);
  }
  if (moved.length === 0) return prop;
  const kept = rest.filter((k) => !moved.some((m) => Math.abs(m.time - k.time) <= KEY_EPSILON));
  // Collapse moved keys landing on the same time (keep the later in the list).
  const byTime = new Map<number, Keyframe<T>>();
  for (const m of moved) byTime.set(Math.round(m.time / KEY_EPSILON), m);
  return { ...prop, keyframes: sortKeys([...kept, ...byTime.values()]) };
}

export type EaseSide = 'in' | 'out' | 'both';

export function setInterpolation<T extends PropValue>(
  prop: AnimProp<T>,
  ids: ReadonlySet<string>,
  interp: Interpolation,
  side: EaseSide = 'both',
): AnimProp<T> {
  return {
    ...prop,
    keyframes: prop.keyframes.map((k) =>
      ids.has(k.id)
        ? {
            ...k,
            inInterp: side === 'out' ? k.inInterp : interp,
            outInterp: side === 'in' ? k.outInterp : interp,
          }
        : k,
    ),
  };
}

/** F9 "Easy Ease": zero speed, 33% influence on the chosen side(s). */
export function easyEase<T extends PropValue>(prop: AnimProp<T>, ids: ReadonlySet<string>, side: EaseSide = 'both'): AnimProp<T> {
  return {
    ...prop,
    keyframes: prop.keyframes.map((k) => {
      if (!ids.has(k.id)) return k;
      const n = { ...k };
      if (side !== 'in') delete n.outCurve;
      if (side !== 'out') {
        n.inInterp = 'bezier';
        n.inEase = { ...EASY_EASE };
      }
      if (side !== 'in') {
        n.outInterp = 'bezier';
        n.outEase = { ...EASY_EASE };
      }
      return n;
    }),
  };
}

/** Shift every keyframe by dt (used when slipping a layer's source). */
export function offsetAllKeyframes<T extends PropValue>(prop: AnimProp<T>, dt: number): AnimProp<T> {
  if (prop.keyframes.length === 0 || dt === 0) return prop;
  return { ...prop, keyframes: prop.keyframes.map((k) => ({ ...k, time: k.time + dt })) };
}

export function prevKeyframeTime(prop: AnimProp, t: number): number | null {
  let best: number | null = null;
  for (const k of prop.keyframes) if (k.time < t - KEY_EPSILON) best = k.time;
  return best;
}

export function nextKeyframeTime(prop: AnimProp, t: number): number | null {
  for (const k of prop.keyframes) if (k.time > t + KEY_EPSILON) return k.time;
  return null;
}

// ---------------------------------------------------------------------------
// Curves ⇄ After Effects speed/influence
// ---------------------------------------------------------------------------

/**
 * Set the segment k0 → k1 to a normalised cubic bezier, expressed as AE
 * speed/influence on k0's out side and k1's in side (lossless round trip with
 * `segmentCurve` whenever the values differ).
 */
export function easeFromBezier<T extends PropValue>(k0: Keyframe<T>, k1: Keyframe<T>, b: Bezier): [Keyframe<T>, Keyframe<T>] {
  const T_ = k1.time - k0.time;
  const L = valueDistance(k0.value, k1.value);
  const x1 = Math.min(1, Math.max(0.001, b[0]));
  const x2 = Math.min(0.999, Math.max(0, b[2]));
  const i1 = 1 - x2;
  const s0 = T_ > 0 && L > 0 ? (b[1] * L) / (x1 * T_) : 0;
  const s1 = T_ > 0 && L > 0 ? ((1 - b[3]) * L) / (i1 * T_) : 0;
  const a: Keyframe<T> = { ...k0, outInterp: 'bezier', outEase: { speed: s0, influence: x1 } };
  delete a.outCurve;
  const c: Keyframe<T> = { ...k1, inInterp: 'bezier', inEase: { speed: s1, influence: i1 } };
  return [a, c];
}

/** The normalised bezier currently describing segment k0 → k1 (linear → identity). */
export function bezierOfSegment(k0: Keyframe, k1: Keyframe): Bezier {
  const c = segmentCurve(k0, k1);
  return c.bezier ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3];
}

/**
 * Apply an easing preset (or a raw bezier) to every segment that starts at a
 * selected keyframe. A lone selected last keyframe eases its incoming segment.
 */
export function applyEasing<T extends PropValue>(prop: AnimProp<T>, ids: ReadonlySet<string>, easing: string | Bezier): AnimProp<T> {
  const keys = prop.keyframes.slice();
  if (keys.length < 2) return prop;
  const def = typeof easing === 'string' ? easingById(easing) : null;
  const starts = new Set<number>();
  keys.forEach((k, i) => {
    if (!ids.has(k.id)) return;
    if (i < keys.length - 1) starts.add(i);
    else if (!ids.has(keys[i - 1].id)) starts.add(i - 1);
  });
  for (const i of [...starts].sort((a, b) => a - b)) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (def && def.kind === 'fn') {
      keys[i] = { ...k0, outInterp: 'bezier', outCurve: def.id };
      continue;
    }
    const bz: Bezier = def && def.kind === 'bezier' ? def.bezier : (easing as Bezier);
    const isLinear = def?.id === 'linear-inOut';
    if (isLinear) {
      const a = { ...k0, outInterp: 'linear' as const };
      delete a.outCurve;
      keys[i] = a;
      keys[i + 1] = { ...k1, inInterp: 'linear' };
      continue;
    }
    const [a, b] = easeFromBezier(k0, k1, bz);
    keys[i] = a;
    keys[i + 1] = b;
  }
  return { ...prop, keyframes: keys };
}

/** Edit one side of one keyframe's temporal ease (graph handles, velocity dialog). */
export function setKeyEase<T extends PropValue>(prop: AnimProp<T>, keyId: string, side: 'in' | 'out', ease: Partial<TemporalEase>): AnimProp<T> {
  return {
    ...prop,
    keyframes: prop.keyframes.map((k) => {
      if (k.id !== keyId) return k;
      const n = { ...k };
      if (side === 'in') {
        n.inInterp = 'bezier';
        n.inEase = { ...k.inEase, ...ease };
        n.inEase.influence = Math.min(1, Math.max(0.01, n.inEase.influence));
      } else {
        n.outInterp = 'bezier';
        n.outEase = { ...k.outEase, ...ease };
        n.outEase.influence = Math.min(1, Math.max(0.01, n.outEase.influence));
        delete n.outCurve;
      }
      return n;
    }),
  };
}

/** Change keyframe values (graph editor vertical drags). */
export function setKeyValues<T extends PropValue>(prop: AnimProp<T>, values: ReadonlyMap<string, T>): AnimProp<T> {
  return { ...prop, keyframes: prop.keyframes.map((k) => (values.has(k.id) ? { ...k, value: values.get(k.id)! } : k)) };
}

/**
 * Replace function-curve segments starting at the given keys with linear
 * keyframes sampled every `step` seconds, so the motion survives tools that
 * only understand plain keyframes.
 */
export function bakeSegments<T extends PropValue>(prop: AnimProp<T>, ids: ReadonlySet<string>, step: number): AnimProp<T> {
  const out: Keyframe<T>[] = [];
  const keys = prop.keyframes.slice();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const next = keys[i + 1];
    if (!next || !ids.has(k.id) || k.outInterp === 'hold') {
      out.push(k);
      continue;
    }
    const a = { ...k, outInterp: 'linear' as const };
    delete a.outCurve;
    out.push(a);
    for (let t = k.time + step; t < next.time - step / 2; t += step) {
      const sample = makeKeyframe(t, evaluateProp(prop, t), 'linear');
      out.push(sample);
    }
    if (out.length && i + 1 < keys.length) keys[i + 1] = { ...next, inInterp: 'linear' } as Keyframe<T>;
  }
  return { ...prop, keyframes: out };
}
