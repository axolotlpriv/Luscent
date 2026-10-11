import { create } from 'zustand';
import type { SnapKind } from '../../core/timeline/snap';

/** Transient timeline UI feedback (not part of the document). */
interface TimelineUI {
  snap: { time: number; kind: SnapKind } | null;
  marquee: { x: number; y: number; w: number; h: number } | null;
  /** Row index where a layer-reorder drag would drop. */
  dropIndex: number | null;
  trackWidth: number;
  /** Floating label while dragging (comp time it points at, and the text). */
  readout: { time: number; text: string } | null;
}

export const useTimelineUI = create<TimelineUI>(() => ({ snap: null, marquee: null, dropIndex: null, trackWidth: 800, readout: null }));


/**
 * Responsive layout. `compact` is the phone layout (bottom navigation, sheets,
 * touch-sized rows). The timeline's pixel metrics live in `dims` so drag math
 * and rendering agree; the matching CSS variables are kept in sync here.
 */
const COMPACT_QUERY = '(max-width: 820px), (max-height: 500px) and (pointer: coarse)';
// snapPx: how close (in screen pixels) an edge must come to a target to snap. Fingers need far more than a mouse.
const DESKTOP_DIMS = { leftW: 340, layerH: 28, propH: 24, snapPx: 8 };
const COMPACT_DIMS = { leftW: 96, layerH: 44, propH: 36, snapPx: 22 };

export const dims = { ...DESKTOP_DIMS };

function applyDims(compact: boolean): void {
  Object.assign(dims, compact ? COMPACT_DIMS : DESKTOP_DIMS);
  const root = document.documentElement.style;
  root.setProperty('--layer-h', dims.layerH + 'px');
  root.setProperty('--prop-h', dims.propH + 'px');
}

const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(COMPACT_QUERY) : null;
applyDims(!!query?.matches);

export const useLayout = create<{ compact: boolean }>(() => ({ compact: !!query?.matches }));
query?.addEventListener('change', (e) => {
  applyDims(e.matches);
  useLayout.setState({ compact: e.matches });
});
