import { create } from 'zustand';
import type { SnapKind } from '../../core/timeline/snap';

/** Transient timeline UI feedback (not part of the document). */
interface TimelineUI {
  snap: { time: number; kind: SnapKind } | null;
  marquee: { x: number; y: number; w: number; h: number } | null;
  /** Row index where a layer-reorder drag would drop. */
  dropIndex: number | null;
  trackWidth: number;
}

export const useTimelineUI = create<TimelineUI>(() => ({ snap: null, marquee: null, dropIndex: null, trackWidth: 800 }));

export const LEFT_W = 340;
export const LAYER_H = 28;
export const PROP_H = 24;
export const SNAP_PX = 8;
