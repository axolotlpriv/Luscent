import { uid } from '../model/ids';
import type { AnimProp, Interpolation, Keyframe, PropValue, TemporalEase } from '../model/types';
import { evaluateProp } from './interpolate';

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
  if (prop.keyframes.length > 0) return { value: evaluateProp(prop, t), keyframes: [] };
  return { value: prop.value, keyframes: [makeKeyframe(t, prop.value)] };
}

export function removeKeyframes<T extends PropValue>(prop: AnimProp<T>, ids: ReadonlySet<string>, t: number): AnimProp<T> {
  const keys = prop.keyframes.filter((k) => !ids.has(k.id));
  if (keys.length === prop.keyframes.length) return prop;
  // Removing the last keyframe leaves the property static at its value at t.
  if (keys.length === 0) return { value: evaluateProp(prop, t), keyframes: [] };
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
