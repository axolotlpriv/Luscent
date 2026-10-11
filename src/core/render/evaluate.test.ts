import { describe, expect, it } from 'vitest';
import { createPrecompLayer, createComposition, createProject, createShapeLayer, createNullLayer } from '../model/factory';
import { makeKeyframe } from '../animation/keyframes';
import { approximateTextMeasure, evaluateComposition, itemCorners, pointInQuad } from './evaluate';
import { apply, invert, layerMatrix, multiply } from './matrix';
import type { Vec2 } from '../model/types';

const ctx = { measureText: approximateTextMeasure };

describe('matrix', () => {
  it('applies AE transform order', () => {
    const m = layerMatrix([50, 50], [500, 500], [200, 200], 90);
    // Anchor maps to position.
    expect(apply(m, 50, 50).map((v) => Math.round(v))).toEqual([500, 500]);
    // A point 10px right of the anchor ends 20px *below* (90° clockwise, 2x).
    const [x, y] = apply(m, 60, 50);
    expect(x).toBeCloseTo(500);
    expect(y).toBeCloseTo(520);
  });
  it('inverts', () => {
    const m = layerMatrix([3, 4], [10, 20], [150, 50], 33);
    const r = multiply(m, invert(m)!);
    expect(r[0]).toBeCloseTo(1);
    expect(r[3]).toBeCloseTo(1);
    expect(r[4]).toBeCloseTo(0);
  });
});

describe('evaluateComposition', () => {
  it('orders bottom first and skips inactive / hidden layers', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const top = createShapeLayer({ comp, name: 'top' });
    const bottom = createShapeLayer({ comp, name: 'bottom' });
    const later = createShapeLayer({ comp, name: 'later', inPoint: 5, outPoint: 6 });
    const hidden = createShapeLayer({ comp, name: 'hidden' });
    hidden.visible = false;
    comp.layers = [top, later, hidden, bottom];
    const f = evaluateComposition(project, comp.id, 1, ctx)!;
    expect(f.items.map((i) => i.layerId)).toEqual([bottom.id, top.id]);
  });

  it('respects solo', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const a = createShapeLayer({ comp });
    const b = createShapeLayer({ comp });
    b.solo = true;
    comp.layers = [a, b];
    expect(evaluateComposition(project, comp.id, 0, ctx)!.items.map((i) => i.layerId)).toEqual([b.id]);
  });

  it('animates and parents', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const parent = createNullLayer({ comp });
    parent.props['transform.position'] = {
      value: [0, 0],
      keyframes: [makeKeyframe<Vec2>(0, [0, 0]), makeKeyframe<Vec2>(2, [200, 0])],
    };
    parent.props['transform.anchor'].value = [0, 0];
    const child = createShapeLayer({ comp });
    child.props['transform.position'].value = [10, 10];
    child.parentId = parent.id;
    comp.layers = [child, parent];
    const f = evaluateComposition(project, comp.id, 1, ctx)!;
    const item = f.items[0];
    // child's origin = parent offset (100,0) + its own position.
    expect(apply(item.matrix, 0, 0)).toEqual([110, 10]);
  });

  it('evaluates precomps in layer time', () => {
    const project = createProject();
    const main = project.compositions[project.mainCompId];
    const inner = createComposition({ name: 'inner', duration: 5 });
    project.compositions[inner.id] = inner;
    const shape = createShapeLayer({ comp: inner, inPoint: 1, outPoint: 2 });
    inner.layers = [shape];
    const pl = createPrecompLayer({ comp: main, target: inner, inPoint: 3 });
    main.layers = [pl];
    expect(evaluateComposition(project, main.id, 3.5, ctx)!.items[0]).toMatchObject({ kind: 'precomp' });
    const f = evaluateComposition(project, main.id, 4.5, ctx)!;
    const item = f.items[0];
    if (item.kind !== 'precomp') throw new Error('expected precomp');
    expect(item.frame.time).toBeCloseTo(1.5);
    expect(item.frame.items).toHaveLength(1);
  });

  it('guards against recursive precomps', () => {
    const project = createProject();
    const main = project.compositions[project.mainCompId];
    const pl = createPrecompLayer({ comp: main, target: main });
    main.layers = [pl];
    expect(() => evaluateComposition(project, main.id, 0, ctx)).not.toThrow();
  });

  it('hit tests rotated quads', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const s = createShapeLayer({ comp, size: [100, 100] });
    s.props['transform.position'].value = [500, 500];
    s.props['transform.rotation'].value = 45;
    comp.layers = [s];
    const q = itemCorners(evaluateComposition(project, comp.id, 0, ctx)!.items[0]);
    expect(pointInQuad(500, 500, q)).toBe(true);
    expect(pointInQuad(500, 565, q)).toBe(true); // along the diagonal
    expect(pointInQuad(560, 560, q)).toBe(false); // corner region rotated away
  });
});
