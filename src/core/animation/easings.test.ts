import { describe, expect, it } from 'vitest';
import { EASINGS, easingById } from './easings';
import { applyEasing, bakeSegments, bezierOfSegment, easeFromBezier, makeKeyframe, setKeyEase } from './keyframes';
import { evaluateProp, segmentCurve } from './interpolate';
import { cubicBezierAt } from './bezier';
import type { AnimProp, Vec2 } from '../model/types';

const prop = (): AnimProp<number> => ({ value: 0, keyframes: [makeKeyframe(0, 0), makeKeyframe(2, 100)] });

describe('easing presets', () => {
  it('every preset starts at 0 and ends at 1', () => {
    for (const e of EASINGS) {
      const f = e.kind === 'fn' ? e.fn : (x: number) => cubicBezierAt(...e.bezier, x);
      expect(f(0)).toBeCloseTo(0, 5);
      expect(f(1)).toBeCloseTo(1, 5);
    }
  });

  it('round-trips a bezier through AE speed/influence', () => {
    const p = prop();
    const [a, b] = easeFromBezier(p.keyframes[0], p.keyframes[1], [0.16, 1, 0.3, 1]);
    const bz = bezierOfSegment(a, b);
    expect(bz[0]).toBeCloseTo(0.16);
    expect(bz[1]).toBeCloseTo(1);
    expect(bz[2]).toBeCloseTo(0.3);
    expect(bz[3]).toBeCloseTo(1);
  });

  it('applies expo-out so the value races ahead early', () => {
    const p = applyEasing(prop(), new Set([prop().keyframes[0].id]), 'expo-out');
    // ids differ between calls; apply to actual ids
    const base = prop();
    const eased = applyEasing(base, new Set([base.keyframes[0].id]), 'expo-out');
    expect(evaluateProp(eased, 0.5)).toBeGreaterThan(60);
    expect(p.keyframes).toHaveLength(2);
  });

  it('back-out overshoots', () => {
    const base = prop();
    const eased = applyEasing(base, new Set([base.keyframes[0].id]), 'back-out');
    let max = 0;
    for (let t = 0; t <= 2; t += 0.02) max = Math.max(max, evaluateProp(eased, t));
    expect(max).toBeGreaterThan(105);
  });

  it('elastic and bounce use function curves', () => {
    const base = prop();
    const el = applyEasing(base, new Set([base.keyframes[0].id]), 'elastic-out');
    expect(el.keyframes[0].outCurve).toBe('elastic-out');
    expect(segmentCurve(el.keyframes[0], el.keyframes[1]).fn).toBeTypeOf('function');
    let over = false;
    for (let t = 0; t <= 2; t += 0.01) if (evaluateProp(el, t) > 100.5) over = true;
    expect(over).toBe(true);
    const bo = applyEasing(base, new Set([base.keyframes[0].id]), 'bounce-out');
    for (let t = 0; t <= 2; t += 0.01) expect(evaluateProp(bo, t)).toBeLessThanOrEqual(100.0001);
  });

  it('linear preset resets interpolation', () => {
    const base = prop();
    const eased = applyEasing(base, new Set([base.keyframes[0].id]), 'expo-in');
    const lin = applyEasing(eased, new Set([base.keyframes[0].id]), 'linear-inOut');
    expect(evaluateProp(lin, 1)).toBeCloseTo(50);
  });

  it('eases vectors along their path', () => {
    const p: AnimProp<Vec2> = { value: [0, 0], keyframes: [makeKeyframe<Vec2>(0, [0, 0]), makeKeyframe<Vec2>(1, [30, 40])] };
    const e = applyEasing(p, new Set([p.keyframes[0].id]), easingById('cubic-inOut')!.id);
    const v = evaluateProp(e, 0.5);
    expect(v[0] / v[1]).toBeCloseTo(0.75);
  });

  it('bakes function curves into linear keys that follow the curve', () => {
    const base = prop();
    const el = applyEasing(base, new Set([base.keyframes[0].id]), 'bounce-out');
    const baked = bakeSegments(el, new Set([el.keyframes[0].id]), 1 / 30);
    expect(baked.keyframes.length).toBeGreaterThan(50);
    expect(baked.keyframes.every((k) => !k.outCurve)).toBe(true);
    for (const t of [0.3, 0.9, 1.5]) expect(evaluateProp(baked, t)).toBeCloseTo(evaluateProp(el, t), 0);
  });

  it('edits one side of an ease', () => {
    const base = prop();
    const p = setKeyEase(base, base.keyframes[0].id, 'out', { speed: 0, influence: 0.9 });
    expect(p.keyframes[0].outInterp).toBe('bezier');
    expect(evaluateProp(p, 0.5)).toBeLessThan(25);
  });

  it('wiggle is deterministic and bounded', () => {
    const p: AnimProp<number> = { value: 10, keyframes: [], wiggle: { freq: 5, amp: 20, octaves: 1, ampMult: 0.5, seed: 3 } };
    const a = evaluateProp(p, 0.37);
    expect(evaluateProp(p, 0.37)).toBe(a);
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 10; t += 0.01) {
      const v = evaluateProp(p, t);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThan(10 - 25);
    expect(hi).toBeLessThan(10 + 25);
    expect(hi - lo).toBeGreaterThan(15);
  });
});
