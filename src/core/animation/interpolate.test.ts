import { describe, expect, it } from 'vitest';
import { cubicBezierAt } from './bezier';
import { evaluateProp, evaluateSpeed, segmentCurve } from './interpolate';
import { addKeyframeAt, easyEase, makeKeyframe, moveKeyframes, removeKeyframes, setValueAt, toggleAnimation } from './keyframes';
import type { AnimProp, Vec2 } from '../model/types';

describe('cubicBezierAt', () => {
  it('matches the identity curve', () => {
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(cubicBezierAt(1 / 3, 1 / 3, 2 / 3, 2 / 3, x)).toBeCloseTo(x, 5);
  });
  it('is symmetric for ease-in-out', () => {
    const a = cubicBezierAt(0.42, 0, 0.58, 1, 0.25);
    const b = cubicBezierAt(0.42, 0, 0.58, 1, 0.75);
    expect(a + b).toBeCloseTo(1, 5);
    expect(cubicBezierAt(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 5);
  });
  it('supports overshoot', () => {
    expect(cubicBezierAt(0.3, 1.6, 0.6, 1, 0.5)).toBeGreaterThan(1);
  });
});

describe('evaluateProp', () => {
  const lin: AnimProp<number> = { value: 0, keyframes: [makeKeyframe(0, 0), makeKeyframe(2, 100)] };

  it('returns static value when not animated', () => {
    expect(evaluateProp({ value: 7, keyframes: [] }, 3)).toBe(7);
  });
  it('holds before first / after last keyframe', () => {
    expect(evaluateProp(lin, -1)).toBe(0);
    expect(evaluateProp(lin, 5)).toBe(100);
  });
  it('interpolates linearly', () => {
    expect(evaluateProp(lin, 0.5)).toBeCloseTo(25);
    expect(evaluateProp(lin, 1)).toBeCloseTo(50);
  });
  it('interpolates vectors', () => {
    const p: AnimProp<Vec2> = { value: [0, 0], keyframes: [makeKeyframe<Vec2>(0, [0, 0]), makeKeyframe<Vec2>(1, [10, -20])] };
    const v = evaluateProp(p, 0.5);
    expect(v[0]).toBeCloseTo(5);
    expect(v[1]).toBeCloseTo(-10);
  });
  it('respects hold interpolation', () => {
    const p: AnimProp<number> = { value: 0, keyframes: [makeKeyframe(0, 0, 'hold'), makeKeyframe(1, 10)] };
    expect(evaluateProp(p, 0.99)).toBe(0);
    expect(evaluateProp(p, 1)).toBe(10);
  });
  it('easy ease is slow at the ends and symmetric', () => {
    const ids = new Set(lin.keyframes.map((k) => k.id));
    const eased = easyEase(lin, ids);
    expect(evaluateProp(eased, 1)).toBeCloseTo(50, 3);
    expect(evaluateProp(eased, 0.1)).toBeLessThan(5);
    expect(evaluateSpeed(eased, 0.001)).toBeLessThan(2);
    expect(evaluateSpeed(eased, 1)).toBeGreaterThan(50);
  });
  it('builds AE-style normalised handles from speed/influence', () => {
    const k0 = { ...makeKeyframe(0, 0), outInterp: 'bezier' as const, outEase: { speed: 0, influence: 0.75 } };
    const k1 = { ...makeKeyframe(1, 100), inInterp: 'bezier' as const, inEase: { speed: 200, influence: 0.5 } };
    const c = segmentCurve(k0, k1);
    expect(c.bezier).not.toBeNull();
    const [x1, y1, x2, y2] = c.bezier!;
    expect(x1).toBeCloseTo(0.75);
    expect(y1).toBeCloseTo(0);
    expect(x2).toBeCloseTo(0.5);
    expect(y2).toBeCloseTo(0); // 1 - 200*0.5*1/100
  });
});

describe('keyframe editing', () => {
  it('toggle creates and clears animation', () => {
    const p: AnimProp<number> = { value: 42, keyframes: [] };
    const on = toggleAnimation(p, 1);
    expect(on.keyframes).toHaveLength(1);
    expect(on.keyframes[0].time).toBe(1);
    const moved = setValueAt(on, 2, 84);
    expect(moved.keyframes).toHaveLength(2);
    const off = toggleAnimation(moved, 1.5);
    expect(off.keyframes).toHaveLength(0);
    expect(off.value).toBeCloseTo(63);
  });
  it('setValueAt updates existing keyframe within epsilon', () => {
    const p = setValueAt({ value: 0, keyframes: [makeKeyframe(1, 5)] }, 1.00001, 9);
    expect(p.keyframes).toHaveLength(1);
    expect(p.keyframes[0].value).toBe(9);
  });
  it('addKeyframeAt captures the current value', () => {
    const p = addKeyframeAt({ value: 0, keyframes: [makeKeyframe(0, 0), makeKeyframe(2, 10)] }, 1);
    expect(p.keyframes.map((k) => k.value)).toEqual([0, 5, 10]);
  });
  it('moved keyframes replace collided keyframes and stay sorted', () => {
    const a = makeKeyframe(0, 0);
    const b = makeKeyframe(1, 10);
    const c = makeKeyframe(2, 20);
    const p = moveKeyframes({ value: 0, keyframes: [a, b, c] }, new Set([a.id]), 2);
    expect(p.keyframes.map((k) => k.value)).toEqual([10, 0]);
    expect(p.keyframes.map((k) => k.time)).toEqual([1, 2]);
  });
  it('removing the last keyframe freezes the value', () => {
    const a = makeKeyframe(0, 0);
    const b = makeKeyframe(1, 10);
    const p = removeKeyframes({ value: 0, keyframes: [a, b] }, new Set([a.id, b.id]), 0.5);
    expect(p.keyframes).toHaveLength(0);
    expect(p.value).toBeCloseTo(5);
  });
});
