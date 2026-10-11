import { describe, expect, it } from 'vitest';
import { createComposition, createSolidLayer, createTextLayer } from '../model/factory';
import { makeKeyframe } from '../animation/keyframes';
import type { Composition, Layer } from '../model/types';
import {
  duplicateLayers,
  extractRange,
  moveLayers,
  reorderLayers,
  rippleDeleteLayers,
  sequenceLayers,
  slipLayer,
  splitLayers,
  trimLayer,
  wouldCycle,
  type EditContext,
} from './ops';
import { precompose } from './precompose';
import { collectSnapTargets, snapEdges, snapTime } from './snap';
import { createProject } from '../model/factory';

const ctx: EditContext = { fps: 30, sourceDuration: () => Infinity };
const boundedCtx = (d: number): EditContext => ({ fps: 30, sourceDuration: () => d });

function clip(comp: Composition, name: string, a: number, b: number): Layer {
  const l = createSolidLayer({ comp, name, inPoint: a, outPoint: b });
  return l;
}

/** Three back-to-back clips [0,1) [1,3) [3,4); index 0 is the top. */
function seq(): Composition {
  const comp = createComposition({ duration: 10 });
  const a = clip(comp, 'A', 0, 1);
  const b = clip(comp, 'B', 1, 3);
  const c = clip(comp, 'C', 3, 4);
  comp.layers = [c, b, a];
  return comp;
}
const byName = (comp: Composition, n: string) => comp.layers.find((l) => l.name === n)!;

describe('timeline ops', () => {
  it('moves layers with their start time', () => {
    const comp = seq();
    const b = byName(comp, 'B');
    moveLayers(comp, [b.id], 0.5);
    expect([b.inPoint, b.outPoint, b.startTime]).toEqual([1.5, 3.5, 1.5]);
  });

  it('trims and clamps to a one-frame minimum', () => {
    const comp = seq();
    const b = byName(comp, 'B');
    trimLayer(comp, b.id, 'out', 0.5, ctx);
    expect(b.outPoint).toBeCloseTo(1 + 1 / 30);
    trimLayer(comp, b.id, 'in', 0.2, ctx);
    expect(b.inPoint).toBeCloseTo(0.2);
  });

  it('clamps trims to the source extent for bounded media', () => {
    const comp = seq();
    const b = byName(comp, 'B'); // startTime 1, source 2.5s long
    trimLayer(comp, b.id, 'out', 10, boundedCtx(2.5));
    expect(b.outPoint).toBeCloseTo(3.5);
    trimLayer(comp, b.id, 'in', 0, boundedCtx(2.5));
    expect(b.inPoint).toBeCloseTo(1);
  });

  it('ripple trims the out point and shifts downstream clips', () => {
    const comp = seq();
    trimLayer(comp, byName(comp, 'B').id, 'out', 2, ctx, { ripple: true });
    expect(byName(comp, 'B').outPoint).toBeCloseTo(2);
    expect(byName(comp, 'C').inPoint).toBeCloseTo(2);
    expect(byName(comp, 'A').inPoint).toBeCloseTo(0);
  });

  it('ripple trims the in point keeping the clip anchored', () => {
    const comp = seq();
    const b = byName(comp, 'B');
    trimLayer(comp, b.id, 'in', 1.5, ctx, { ripple: true });
    expect(b.inPoint).toBeCloseTo(1);
    expect(b.outPoint).toBeCloseTo(2.5);
    expect(b.startTime).toBeCloseTo(0.5); // source shifted so frame at 1.5 now shows at 1
    expect(byName(comp, 'C').inPoint).toBeCloseTo(2.5);
  });

  it('splits a layer keeping keyframes in layer time', () => {
    const comp = seq();
    const b = byName(comp, 'B');
    b.props['transform.opacity'] = { value: 100, keyframes: [makeKeyframe(0, 0), makeKeyframe(2, 100)] };
    const [rid] = splitLayers(comp, [b.id], 2);
    const right = comp.layers.find((l) => l.id === rid)!;
    expect(b.outPoint).toBe(2);
    expect(right.inPoint).toBe(2);
    expect(right.outPoint).toBe(3);
    expect(right.startTime).toBe(b.startTime);
    expect(comp.layers.indexOf(right)).toBe(comp.layers.indexOf(b) - 1);
    expect(right.props['transform.opacity'].keyframes[0].id).not.toBe(b.props['transform.opacity'].keyframes[0].id);
  });

  it('does not split outside the layer', () => {
    const comp = seq();
    expect(splitLayers(comp, [byName(comp, 'B').id], 0.5)).toEqual([]);
  });

  it('ripple deletes and closes the gap', () => {
    const comp = seq();
    comp.markers.push({ id: 'm', time: 3.5, duration: 0, label: '', color: 0 });
    rippleDeleteLayers(comp, [byName(comp, 'B').id]);
    expect(comp.layers.map((l) => l.name)).toEqual(['C', 'A']);
    expect(byName(comp, 'C').inPoint).toBeCloseTo(1);
    expect(comp.markers[0].time).toBeCloseTo(1.5);
  });

  it('extracts a range across layers', () => {
    const comp = seq();
    extractRange(comp, 0.5, 1.5);
    const a = byName(comp, 'A');
    expect([a.inPoint, a.outPoint]).toEqual([0, 0.5]);
    const b = byName(comp, 'B');
    expect(b.inPoint).toBeCloseTo(0.5);
    expect(b.outPoint).toBeCloseTo(2);
    expect(b.startTime).toBeCloseTo(0); // source frame at old 1.5 now plays at 0.5
    expect(byName(comp, 'C').inPoint).toBeCloseTo(2);
  });

  it('extract splits layers spanning the range', () => {
    const comp = createComposition({ duration: 10 });
    const l = clip(comp, 'L', 0, 4);
    comp.layers = [l];
    extractRange(comp, 1, 2);
    expect(comp.layers).toHaveLength(2);
    const parts = comp.layers.map((x) => [x.inPoint, x.outPoint, x.startTime]).sort((p, q) => p[0] - q[0]);
    expect(parts).toEqual([
      [0, 1, 0],
      [1, 3, -1],
    ]);
  });

  it('slips media keeping in/out and comp-time keyframes', () => {
    const comp = seq();
    const b = byName(comp, 'B'); // in 1, out 3, start 1
    b.startTime = 0;
    b.props['transform.opacity'] = { value: 100, keyframes: [makeKeyframe(1.5, 0)] };
    slipLayer(comp, b.id, -0.5, boundedCtx(5));
    expect(b.startTime).toBeCloseTo(-0.5);
    expect([b.inPoint, b.outPoint]).toEqual([1, 3]);
    expect(b.startTime + b.props['transform.opacity'].keyframes[0].time).toBeCloseTo(1.5);
    // Can't slip beyond the source.
    slipLayer(comp, b.id, -10, boundedCtx(5));
    expect(b.startTime).toBeCloseTo(-2);
  });

  it('sequences layers back to back', () => {
    const comp = createComposition({ duration: 20 });
    const ls = [clip(comp, 'x', 0, 2), clip(comp, 'y', 0, 1), clip(comp, 'z', 5, 8)];
    comp.layers = ls;
    sequenceLayers(comp, ls.map((l) => l.id));
    expect(ls.map((l) => [l.inPoint, l.outPoint])).toEqual([
      [0, 2],
      [2, 3],
      [3, 6],
    ]);
  });

  it('reorders and duplicates', () => {
    const comp = seq();
    reorderLayers(comp, [byName(comp, 'A').id], 0);
    expect(comp.layers.map((l) => l.name)).toEqual(['A', 'C', 'B']);
    duplicateLayers(comp, [byName(comp, 'C').id]);
    expect(comp.layers.map((l) => l.name)).toEqual(['A', 'C', 'C', 'B']);
  });

  it('detects parenting cycles', () => {
    const comp = seq();
    const [c, b, a] = comp.layers;
    b.parentId = a.id;
    expect(wouldCycle(comp, a.id, b.id)).toBe(true);
    expect(wouldCycle(comp, c.id, b.id)).toBe(false);
  });
});

describe('precompose', () => {
  it('moves layers into a nested comp', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const t1 = createTextLayer({ comp, inPoint: 1, outPoint: 2 });
    const t2 = createTextLayer({ comp, inPoint: 2, outPoint: 5 });
    const t3 = createTextLayer({ comp });
    comp.layers = [t3, t2, t1];
    const id = precompose(project, comp.id, [t1.id, t2.id], 'Pre');
    expect(id).toBeTruthy();
    expect(comp.layers).toHaveLength(2);
    const pl = comp.layers[1];
    expect(pl.type).toBe('precomp');
    expect([pl.inPoint, pl.outPoint, pl.startTime]).toEqual([1, 5, 0]);
    expect(project.compositions[id!].layers.map((l) => l.id)).toEqual([t2.id, t1.id]);
  });
});

describe('snapping', () => {
  it('snaps to the nearest target within threshold', () => {
    const r = snapTime(1.02, [{ time: 1, kind: 'layer-in' }, { time: 2, kind: 'beat' }], 0.05);
    expect(r.time).toBe(1);
    expect(snapTime(1.2, [{ time: 1, kind: 'layer-in' }], 0.05).target).toBeNull();
  });
  it('prefers beats on ties', () => {
    const r = snapTime(1, [{ time: 1.01, kind: 'layer-in' }, { time: 0.99, kind: 'beat' }], 0.05);
    expect(r.target?.kind).toBe('beat');
  });
  it('snaps either edge of a moving clip', () => {
    const r = snapEdges([0.97, 1.97], [{ time: 2, kind: 'marker' }], 0.05);
    expect(r.correction).toBeCloseTo(0.03);
  });
  it('collects beats from analysed audio layers in comp time', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    project.media.m = {
      id: 'm', name: 'song', kind: 'audio', mimeType: 'audio/mp3', size: 1, width: 0, height: 0,
      duration: 10, fps: 0, hasAudio: true, analysis: { bpm: 120, beats: [0, 0.5, 1, 1.5], onsets: [], confidence: 1 },
    };
    comp.layers = [{ ...createSolidLayer({ comp }), type: 'audio', mediaId: 'm', inPoint: 2.2, outPoint: 4, startTime: 2 } as unknown as Layer];
    const targets = collectSnapTargets(project, comp, { beats: true, layers: false, markers: false });
    expect(targets.filter((t) => t.kind === 'beat').map((t) => t.time)).toEqual([2.5, 3, 3.5]);
  });
});

describe('ops inside immer', () => {
  it('splits and duplicates on drafts', async () => {
    const { produce } = await import('immer');
    const comp = seq();
    const next = produce(comp, (d) => {
      splitLayers(d as Composition, [d.layers[1].id], 2);
      duplicateLayers(d as Composition, [d.layers[0].id]);
      extractRange(d as Composition, 0.2, 0.4);
    });
    // 3 + split (1) + duplicate (1) + extract splits A around the range (1).
    expect(next.layers.length).toBe(6);
    expect(comp.layers.length).toBe(3);
  });
});
