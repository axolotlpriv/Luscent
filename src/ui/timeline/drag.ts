import { activeComp, editor } from '../../state/store';
import { collectSnapTargets, snapEdges, snapTime, type SnapTarget } from '../../core/timeline/snap';
import type { Id } from '../../core/model/types';
import { SNAP_PX, useTimelineUI } from './uiState';

export interface DragHandlers {
  move: (dx: number, dy: number, ev: PointerEvent) => void;
  up?: (moved: boolean, ev: PointerEvent) => void;
  /** Pixels before a press becomes a drag. */
  threshold?: number;
}

/** Window-level pointer drag that survives leaving the element. */
export function startDrag(e: { clientX: number; clientY: number }, h: DragHandlers): void {
  const x0 = e.clientX;
  const y0 = e.clientY;
  const th = h.threshold ?? 3;
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < th) return;
    moved = true;
    h.move(dx, dy, ev);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    useTimelineUI.setState({ snap: null });
    h.up?.(moved, ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/**
 * Snapping session for one drag: targets are collected once at drag start.
 * Holding Ctrl/Cmd inverts the snapping toggle.
 */
export function makeSnapper(opts: { excludeLayers?: Id[]; keyframeLayers?: Id[]; playhead?: boolean } = {}) {
  const s = editor();
  const comp = activeComp(s);
  const targets: SnapTarget[] = collectSnapTargets(s.project, comp, {
    playhead: opts.playhead === false ? undefined : s.playhead,
    excludeLayers: new Set(opts.excludeLayers ?? []),
    beats: s.beatSnap,
    onsets: s.beatSnap,
    keyframeLayers: opts.keyframeLayers ? new Set(opts.keyframeLayers) : undefined,
  });
  const fps = comp.fps;
  const enabled = (ev?: { ctrlKey: boolean; metaKey: boolean }) => s.snapping !== !!(ev && (ev.ctrlKey || ev.metaKey));
  const threshold = () => SNAP_PX / editor().pxPerSec;
  const q = (t: number) => Math.round(t * fps) / fps;
  return {
    /** Snap a single time; returns frame-quantised time. */
    time(t: number, ev?: PointerEvent): number {
      if (!enabled(ev)) {
        useTimelineUI.setState({ snap: null });
        return q(t);
      }
      const r = snapTime(t, targets, threshold());
      useTimelineUI.setState({ snap: r.target ? { time: r.target.time, kind: r.target.kind } : null });
      return q(r.time);
    },
    /** Snap a rigid move of several edges; returns the frame-quantised delta. */
    delta(dt: number, edges: number[], ev?: PointerEvent): number {
      if (!enabled(ev)) {
        useTimelineUI.setState({ snap: null });
        return q(dt);
      }
      const r = snapEdges(
        edges.map((e) => e + dt),
        targets,
        threshold(),
      );
      useTimelineUI.setState({ snap: r.target ? { time: r.target.time, kind: r.target.kind } : null });
      return q(dt + r.correction);
    },
  };
}
