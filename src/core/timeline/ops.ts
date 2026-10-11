/**
 * Timeline editing operations.
 *
 * These functions MUTATE the composition they are given. They are designed to
 * run inside an immer `produce` recipe (the store does this), which keeps the
 * code direct while still yielding immutable snapshots for undo. They are
 * equally happy operating on plain objects in tests.
 */
import { cloneLayer } from '../model/factory';
import { offsetAllKeyframes } from '../animation/keyframes';
import type { Composition, Id, Layer, MediaItem, Project } from '../model/types';

const EPS = 1e-6;

export interface EditContext {
  fps: number;
  /** Duration (seconds) of the source behind a layer, Infinity if unbounded. */
  sourceDuration: (layer: Layer) => number;
}

export function makeEditContext(project: Project, comp: Composition): EditContext {
  return {
    fps: comp.fps,
    sourceDuration: (layer) => sourceDurationOf(layer, project.media),
  };
}

export function sourceDurationOf(layer: Layer, media: Record<Id, MediaItem>): number {
  if (layer.type === 'video' || layer.type === 'audio') {
    const m = media[layer.mediaId];
    return m && Number.isFinite(m.duration) ? m.duration : Infinity;
  }
  return Infinity;
}

export function findLayer(comp: Composition, id: Id): Layer | undefined {
  return comp.layers.find((l) => l.id === id);
}

export function layerDuration(l: Layer): number {
  return l.outPoint - l.inPoint;
}

function minDur(ctx: EditContext): number {
  return 1 / ctx.fps;
}

/** Move layers (and their animation) in time by dt seconds. */
export function moveLayers(comp: Composition, ids: Iterable<Id>, dt: number): void {
  const set = new Set(ids);
  for (const l of comp.layers) {
    if (!set.has(l.id) || l.locked) continue;
    l.inPoint += dt;
    l.outPoint += dt;
    l.startTime += dt;
  }
}

/** Shift every unlocked layer starting at/after `t` (and comp markers) by dt. */
export function shiftAfter(comp: Composition, t: number, dt: number, exclude: ReadonlySet<Id> = new Set()): void {
  if (dt === 0) return;
  for (const l of comp.layers) {
    if (exclude.has(l.id) || l.locked) continue;
    if (l.inPoint >= t - EPS) {
      l.inPoint += dt;
      l.outPoint += dt;
      l.startTime += dt;
    }
  }
  for (const m of comp.markers) if (m.time >= t - EPS) m.time += dt;
}

export type Edge = 'in' | 'out';

/**
 * Trim a layer edge to time `t` (comp time), clamped to the source extent and
 * a one-frame minimum duration. With `ripple`, downstream layers follow the
 * change so no gap opens or closes elsewhere, and an in-point ripple keeps the
 * layer's in point anchored in place (NLE ripple-trim semantics).
 */
export function trimLayer(
  comp: Composition,
  id: Id,
  edge: Edge,
  t: number,
  ctx: EditContext,
  opts: { ripple?: boolean } = {},
): void {
  const l = findLayer(comp, id);
  if (!l || l.locked) return;
  const dur = ctx.sourceDuration(l);
  const md = minDur(ctx);
  const oldIn = l.inPoint;
  const oldOut = l.outPoint;
  if (edge === 'in') {
    let nt = Math.min(t, l.outPoint - md);
    if (Number.isFinite(dur)) nt = Math.max(nt, l.startTime);
    const delta = nt - oldIn;
    if (opts.ripple) {
      // Keep the visible in-point fixed: slide the source instead and pull
      // everything downstream by the same amount.
      l.startTime -= delta;
      l.inPoint = oldIn;
      l.outPoint = oldOut - delta;
      shiftAfter(comp, oldOut, -delta, new Set([l.id]));
    } else {
      l.inPoint = nt;
    }
  } else {
    let nt = Math.max(t, l.inPoint + md);
    if (Number.isFinite(dur)) nt = Math.min(nt, l.startTime + dur);
    l.outPoint = nt;
    if (opts.ripple) shiftAfter(comp, oldOut, nt - oldOut, new Set([l.id]));
  }
}

/**
 * Split layers at comp time t. The right-hand part becomes a new layer placed
 * directly above the original (After Effects behaviour). Returns new layer ids.
 */
export function splitLayers(comp: Composition, ids: Iterable<Id>, t: number): Id[] {
  const created: Id[] = [];
  for (const id of ids) {
    const idx = comp.layers.findIndex((l) => l.id === id);
    if (idx < 0) continue;
    const l = comp.layers[idx];
    if (l.locked || t <= l.inPoint + EPS || t >= l.outPoint - EPS) continue;
    const right = cloneLayer(l);
    right.name = l.name;
    right.inPoint = t;
    l.outPoint = t;
    comp.layers.splice(idx, 0, right);
    created.push(right.id);
  }
  return created;
}

/** Merge overlapping [a,b] intervals. */
export function mergeIntervals(iv: Array<[number, number]>): Array<[number, number]> {
  const sorted = iv.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Delete layers and close the time they occupied: every layer that starts at
 * or after a removed span's end is pulled back by that span's length.
 */
export function rippleDeleteLayers(comp: Composition, ids: Iterable<Id>): void {
  const set = new Set(ids);
  const removed = comp.layers.filter((l) => set.has(l.id) && !l.locked);
  if (removed.length === 0) return;
  const removedIds = new Set(removed.map((l) => l.id));
  comp.layers = comp.layers.filter((l) => !removedIds.has(l.id));
  for (const l of comp.layers) if (l.parentId && removedIds.has(l.parentId)) l.parentId = null;
  const spans = mergeIntervals(removed.map((l) => [l.inPoint, l.outPoint]));
  // Process right-to-left so earlier shifts don't move later span anchors.
  for (let i = spans.length - 1; i >= 0; i--) {
    const [a, b] = spans[i];
    shiftAfter(comp, b, -(b - a));
  }
}

export function deleteLayers(comp: Composition, ids: Iterable<Id>): void {
  const set = new Set(ids);
  const removedIds = new Set(comp.layers.filter((l) => set.has(l.id) && !l.locked).map((l) => l.id));
  comp.layers = comp.layers.filter((l) => !removedIds.has(l.id));
  for (const l of comp.layers) if (l.parentId && removedIds.has(l.parentId)) l.parentId = null;
}

/**
 * Remove the time range [a,b) from every unlocked layer and close the gap
 * ("extract"). Layers inside are deleted, layers spanning it are split and
 * stitched, later layers move left.
 */
export function extractRange(comp: Composition, a: number, b: number): void {
  if (b <= a) return;
  const len = b - a;
  const keep: Layer[] = [];
  for (const l of comp.layers) {
    if (l.locked) {
      keep.push(l);
      continue;
    }
    if (l.outPoint <= a + EPS) {
      keep.push(l);
    } else if (l.inPoint >= b - EPS) {
      l.inPoint -= len;
      l.outPoint -= len;
      l.startTime -= len;
      keep.push(l);
    } else if (l.inPoint >= a - EPS && l.outPoint <= b + EPS) {
      // Entirely inside: drop.
    } else if (l.inPoint < a && l.outPoint > b) {
      // Spans the range: left part keeps [in,a), right part continues source from b.
      const right = cloneLayer(l);
      right.name = l.name;
      right.inPoint = a;
      right.outPoint = l.outPoint - len;
      right.startTime = l.startTime - len;
      l.outPoint = a;
      keep.push(right, l);
    } else if (l.inPoint < a) {
      l.outPoint = a;
      keep.push(l);
    } else {
      // Starts inside, ends after: trim head and pull to a.
      l.inPoint = a;
      l.outPoint = l.outPoint - len;
      l.startTime = l.startTime - len;
      keep.push(l);
    }
  }
  const kept = new Set(keep.map((l) => l.id));
  for (const l of keep) if (l.parentId && !kept.has(l.parentId)) l.parentId = null;
  comp.layers = keep;
  comp.markers = comp.markers
    .filter((m) => m.time < a - EPS || m.time >= b - EPS)
    .map((m) => (m.time >= b - EPS ? { ...m, time: m.time - len } : m));
}

/**
 * Slip: change which part of the source plays while keeping the layer's in
 * and out points (and its keyframes, in comp time) where they are.
 */
export function slipLayer(comp: Composition, id: Id, dt: number, ctx: EditContext): void {
  const l = findLayer(comp, id);
  if (!l || l.locked) return;
  const dur = ctx.sourceDuration(l);
  let start = l.startTime + dt;
  if (Number.isFinite(dur)) {
    // Source must cover [in, out].
    start = Math.min(start, l.inPoint);
    start = Math.max(start, l.outPoint - dur);
  }
  const applied = start - l.startTime;
  if (applied === 0) return;
  l.startTime = start;
  for (const key of Object.keys(l.props)) l.props[key] = offsetAllKeyframes(l.props[key], -applied);
}

/**
 * Place layers back to back in the given order starting at the first one's
 * in point. `overlap` (seconds) lets consecutive clips overlap for transitions.
 */
export function sequenceLayers(comp: Composition, orderedIds: Id[], overlap = 0): void {
  const layers = orderedIds.map((id) => findLayer(comp, id)).filter((l): l is Layer => !!l && !l.locked);
  if (layers.length < 2) return;
  let cursor = layers[0].outPoint - overlap;
  for (let i = 1; i < layers.length; i++) {
    const l = layers[i];
    const dt = cursor - l.inPoint;
    l.inPoint += dt;
    l.outPoint += dt;
    l.startTime += dt;
    cursor = l.outPoint - overlap;
  }
}

/** Move the given layers to stack position `toIndex` (0 = top), keeping their relative order. */
export function reorderLayers(comp: Composition, ids: Id[], toIndex: number): void {
  const set = new Set(ids);
  const moving = comp.layers.filter((l) => set.has(l.id));
  if (moving.length === 0) return;
  const before = comp.layers.slice(0, toIndex).filter((l) => !set.has(l.id)).length;
  const rest = comp.layers.filter((l) => !set.has(l.id));
  rest.splice(before, 0, ...moving);
  comp.layers = rest;
}

/** Duplicate layers, each copy placed directly above its original. */
export function duplicateLayers(comp: Composition, ids: Iterable<Id>): Id[] {
  const created: Id[] = [];
  for (const id of ids) {
    const idx = comp.layers.findIndex((l) => l.id === id);
    if (idx < 0) continue;
    const copy = cloneLayer(comp.layers[idx]);
    comp.layers.splice(idx, 0, copy);
    created.push(copy.id);
  }
  return created;
}

/** True if setting `childId`'s parent to `parentId` would create a cycle. */
export function wouldCycle(comp: Composition, childId: Id, parentId: Id | null): boolean {
  let cur = parentId;
  const guard = new Set<Id>();
  while (cur) {
    if (cur === childId || guard.has(cur)) return true;
    guard.add(cur);
    cur = findLayer(comp, cur)?.parentId ?? null;
  }
  return false;
}

/** Overall extent of layers in a composition, [start, end]. */
export function contentExtent(comp: Composition): [number, number] {
  if (comp.layers.length === 0) return [0, 0];
  let a = Infinity;
  let b = -Infinity;
  for (const l of comp.layers) {
    a = Math.min(a, l.inPoint);
    b = Math.max(b, l.outPoint);
  }
  return [a, b];
}
