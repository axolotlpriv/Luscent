import type { Composition, Id, Project } from '../model/types';

export type SnapKind =
  | 'playhead'
  | 'layer-in'
  | 'layer-out'
  | 'marker'
  | 'keyframe'
  | 'beat'
  | 'onset'
  | 'work-area'
  | 'comp';

export interface SnapTarget {
  time: number;
  kind: SnapKind;
}

export interface SnapResult {
  time: number;
  target: SnapTarget | null;
}

/** Lower wins ties at equal distance. Beats beat everything for punchy edits. */
const PRIORITY: Record<SnapKind, number> = {
  beat: 0,
  playhead: 1,
  marker: 2,
  'layer-in': 3,
  'layer-out': 3,
  onset: 4,
  keyframe: 5,
  'work-area': 6,
  comp: 7,
};

export function snapTime(t: number, targets: readonly SnapTarget[], threshold: number): SnapResult {
  let best: SnapTarget | null = null;
  let bestD = threshold;
  for (const tg of targets) {
    const d = Math.abs(tg.time - t);
    if (d < bestD - 1e-9 || (best && Math.abs(d - bestD) <= 1e-9 && PRIORITY[tg.kind] < PRIORITY[best.kind])) {
      best = tg;
      bestD = d;
    }
  }
  return best ? { time: best.time, target: best } : { time: t, target: null };
}

/**
 * Snap a rigid move: given the edges of what's being dragged (`edges`, already
 * offset by the raw delta), return the correction to add to the delta so the
 * closest edge lands on a target.
 */
export function snapEdges(edges: readonly number[], targets: readonly SnapTarget[], threshold: number): { correction: number; target: SnapTarget | null } {
  let best: { correction: number; target: SnapTarget | null } = { correction: 0, target: null };
  let bestD = threshold;
  for (const e of edges) {
    const r = snapTime(e, targets, bestD);
    if (r.target) {
      const d = Math.abs(r.time - e);
      if (d <= bestD) {
        bestD = d;
        best = { correction: r.time - e, target: r.target };
      }
    }
  }
  return best;
}

export interface SnapOptions {
  playhead?: number;
  excludeLayers?: ReadonlySet<Id>;
  layers?: boolean;
  markers?: boolean;
  beats?: boolean;
  onsets?: boolean;
  /** Include keyframes of these layers (comp time). */
  keyframeLayers?: ReadonlySet<Id>;
}

/** Beat times of every audible, analysed audio/video layer, in comp time. */
export function compBeatTimes(project: Project, comp: Composition, which: 'beats' | 'onsets' = 'beats'): number[] {
  const out: number[] = [];
  for (const l of comp.layers) {
    if (l.type !== 'audio' && l.type !== 'video') continue;
    const a = project.media[l.mediaId]?.analysis;
    if (!a) continue;
    for (const b of a[which]) {
      const t = l.startTime + b;
      if (t >= l.inPoint - 1e-6 && t <= l.outPoint + 1e-6) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

export function collectSnapTargets(project: Project, comp: Composition, opts: SnapOptions): SnapTarget[] {
  const targets: SnapTarget[] = [
    { time: 0, kind: 'comp' },
    { time: comp.duration, kind: 'comp' },
    { time: comp.workArea.start, kind: 'work-area' },
    { time: comp.workArea.end, kind: 'work-area' },
  ];
  if (opts.playhead !== undefined) targets.push({ time: opts.playhead, kind: 'playhead' });
  if (opts.layers !== false) {
    for (const l of comp.layers) {
      if (opts.excludeLayers?.has(l.id)) continue;
      targets.push({ time: l.inPoint, kind: 'layer-in' }, { time: l.outPoint, kind: 'layer-out' });
    }
  }
  if (opts.markers !== false) {
    for (const m of comp.markers) {
      targets.push({ time: m.time, kind: 'marker' });
      if (m.duration > 0) targets.push({ time: m.time + m.duration, kind: 'marker' });
    }
  }
  if (opts.beats) for (const t of compBeatTimes(project, comp, 'beats')) targets.push({ time: t, kind: 'beat' });
  if (opts.onsets) for (const t of compBeatTimes(project, comp, 'onsets')) targets.push({ time: t, kind: 'onset' });
  if (opts.keyframeLayers) {
    for (const l of comp.layers) {
      if (!opts.keyframeLayers.has(l.id)) continue;
      for (const p of Object.values(l.props)) for (const k of p.keyframes) targets.push({ time: l.startTime + k.time, kind: 'keyframe' });
    }
  }
  return targets;
}
