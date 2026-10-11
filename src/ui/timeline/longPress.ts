import type { PointerEvent as RPointerEvent } from 'react';
import { haptic } from '../haptics';

/**
 * Touch long-press → the same context menu a right-click opens. The browser's
 * own `contextmenu` event is unreliable for pointer-captured drags on phones.
 *
 * Movement and release are watched on `window`, because drags elsewhere in the
 * timeline capture the pointer and would otherwise hide them from this handler.
 */
export function longPress(open: (x: number, y: number) => void, ms = 480) {
  return {
    onPointerDown: (e: RPointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const id = e.pointerId;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const stop = () => {
        clearTimeout(timer);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', stop, true);
        window.removeEventListener('pointercancel', stop, true);
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId === id && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) stop();
      };
      const timer = setTimeout(() => {
        stop();
        haptic('select');
        open(x0, y0);
      }, ms);
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('pointercancel', stop, true);
    },
  };
}
