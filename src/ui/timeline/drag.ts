import { activeComp, editor } from '../../state/store';
import { collectSnapTargets, snapEdges, snapTime, type SnapTarget } from '../../core/timeline/snap';
import type { Id } from '../../core/model/types';
import { haptic } from '../haptics';
import { dims, useTimelineUI } from './uiState';

export interface DragHandlers {
  /** dx/dy are pointer deltas; with autoScroll, dx also includes how far the timeline scrolled. */
  move: (dx: number, dy: number, ev: PointerEvent) => void;
  up?: (moved: boolean, ev: PointerEvent) => void;
  /** Pixels before a press becomes a drag (defaults: 3 for a mouse, 8 for a finger). */
  threshold?: number;
  /** Scroll the timeline when the pointer nears its left/right edge, so drags can go past what's visible. */
  autoScroll?: boolean;
}

const EDGE = 44; // px from the track edge where auto-scroll starts
const MAX_SPEED = 900; // px per second at the very edge

/** Window-level pointer drag that survives leaving the element. */
export function startDrag(e: { clientX: number; clientY: number; pointerType?: string }, h: DragHandlers): void {
  const x0 = e.clientX;
  const y0 = e.clientY;
  const th = h.threshold ?? (e.pointerType === 'touch' ? 8 : 3);
  const scroll0 = editor().scrollTime;
  let moved = false;
  let last: PointerEvent | null = null;
  let raf = 0;
  let prevT = 0;

  const deltaX = (ev: PointerEvent) => {
    const s = editor();
    return ev.clientX - x0 + (h.autoScroll ? (s.scrollTime - scroll0) * s.pxPerSec : 0);
  };

  const track = () => {
    const el = document.querySelector<HTMLElement>('.tl-scroll');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left + dims.leftW, right: r.right };
  };

  const tick = (now: number) => {
    raf = 0;
    if (!last || !moved) return;
    const t = track();
    if (!t) return;
    const x = last.clientX;
    const push = x > t.right - EDGE ? (x - (t.right - EDGE)) / EDGE : x < t.left + EDGE ? -((t.left + EDGE - x) / EDGE) : 0;
    if (push === 0) return;
    const dt = prevT ? Math.min(0.05, (now - prevT) / 1000) : 1 / 60;
    prevT = now;
    const s = editor();
    s.setScrollTime(s.scrollTime + (Math.max(-1, Math.min(1, push)) * MAX_SPEED * dt) / s.pxPerSec);
    h.move(deltaX(last), last.clientY - y0, last);
    raf = requestAnimationFrame(tick);
  };

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < th) return;
    moved = true;
    last = ev;
    h.move(deltaX(ev), dy, ev);
    if (h.autoScroll && !raf) {
      prevT = 0;
      raf = requestAnimationFrame(tick);
    }
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf);
    raf = 0;
    useTimelineUI.setState({ snap: null, readout: null });
    h.up?.(moved, ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/**
 * Snapping session for one drag: targets are collected once at drag start.
 * Holding Ctrl/Cmd inverts the snapping toggle. Engaging a new target gives a
 * small vibration on phones.
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
  const threshold = () => dims.snapPx / editor().pxPerSec;
  const q = (t: number) => Math.round(t * fps) / fps;
  let engaged: number | null = null;
  const show = (target: SnapTarget | null | undefined) => {
    useTimelineUI.setState({ snap: target ? { time: target.time, kind: target.kind } : null });
    const t = target ? target.time : null;
    if (t !== null && t !== engaged) haptic('tick');
    engaged = t;
  };
  return {
    /** Snap a single time; returns frame-quantised time. */
    time(t: number, ev?: PointerEvent): number {
      if (!enabled(ev)) {
        show(null);
        return q(t);
      }
      const r = snapTime(t, targets, threshold());
      show(r.target);
      return q(r.time);
    },
    /** Snap a rigid move of several edges; returns the frame-quantised delta. */
    delta(dt: number, edges: number[], ev?: PointerEvent): number {
      if (!enabled(ev)) {
        show(null);
        return q(dt);
      }
      const r = snapEdges(
        edges.map((e) => e + dt),
        targets,
        threshold(),
      );
      show(r.target);
      return q(dt + r.correction);
    },
  };
}
