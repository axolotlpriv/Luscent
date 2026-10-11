import { useEffect } from 'react';
import { activeComp, editor } from '../state/store';
import { useTimelineUI } from './timeline/uiState';

export interface ShortcutDoc {
  keys: string;
  label: string;
}

export const SHORTCUTS: ShortcutDoc[] = [
  { keys: 'Space', label: 'Play / pause' },
  { keys: '← / →', label: 'Previous / next frame (⇧ ×10)' },
  { keys: '↑ / ↓', label: 'Previous / next edit point' },
  { keys: 'J / K', label: 'Previous / next keyframe' },
  { keys: 'Home / End', label: 'Start / end of comp' },
  { keys: 'I / O', label: 'Go to work area in / out' },
  { keys: 'B / N', label: 'Set work area start / end' },
  { keys: 'M', label: 'Add marker' },
  { keys: '⌘⇧D / ⌘K', label: 'Split at playhead' },
  { keys: '⌥[ / ⌥]', label: 'Trim in / out to playhead' },
  { keys: '[ / ]', label: 'Move layer in / out to playhead' },
  { keys: '⌫', label: 'Delete layers / keyframes' },
  { keys: '⇧⌫', label: 'Ripple delete' },
  { keys: '⌘⇧⌫', label: 'Extract work area (ripple)' },
  { keys: '⌘D', label: 'Duplicate' },
  { keys: '⌘C / ⌘V', label: 'Copy / paste layers' },
  { keys: '⌘A', label: 'Select all layers' },
  { keys: '⌘⇧C', label: 'Pre-compose' },
  { keys: '⌘Z / ⌘⇧Z', label: 'Undo / redo' },
  { keys: 'F9', label: 'Easy ease (⇧ in, ⌘⇧ out)' },
  { keys: '⌘⌥H', label: 'Hold keyframes' },
  { keys: 'P S R T A', label: 'Reveal position / scale / rotation / opacity / anchor' },
  { keys: 'L', label: 'Reveal volume' },
  { keys: 'U', label: 'Reveal animated properties' },
  { keys: '= / −', label: 'Zoom timeline in / out' },
  { keys: '\\', label: 'Fit composition in timeline' },
  { keys: '⌘S / ⌘O', label: 'Save / open project file' },
  { keys: '⌘I', label: 'Import media' },
  { keys: 'Esc', label: 'Deselect' },
  { keys: '?', label: 'This list' },
];

const REVEAL: Record<string, string[]> = {
  p: ['transform.position'],
  s: ['transform.scale'],
  r: ['transform.rotation'],
  t: ['transform.opacity'],
  a: ['transform.anchor'],
  l: ['audio.volume'],
};

export interface ShortcutHandlers {
  save: () => void;
  open: () => void;
  importMedia: () => void;
  help: () => void;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['file', 'checkbox', 'radio', 'range', 'button', 'color'].includes(type);
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function useShortcuts(h: ShortcutHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = editor();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (mod) {
        if (k === 'z' && !e.shiftKey) return handled(), s.undo();
        if ((k === 'z' && e.shiftKey) || k === 'y') return handled(), s.redo();
        if (k === 'd' && e.shiftKey) return handled(), s.splitAtPlayhead();
        if (k === 'k') return handled(), s.splitAtPlayhead();
        if (k === 'd') return handled(), s.duplicateSelected();
        if (k === 'c' && e.shiftKey) return handled(), s.precomposeSelected();
        if (k === 'c') return handled(), s.copy();
        if (k === 'v') return handled(), s.paste();
        if (k === 'a') return handled(), s.selectAllLayers();
        if (k === 's') return handled(), h.save();
        if (k === 'o') return handled(), h.open();
        if (k === 'i') return handled(), h.importMedia();
        if (k === 'h' && e.altKey) return handled(), s.setSelectedKeysInterpolation('hold');
        if ((e.key === 'Backspace' || e.key === 'Delete') && e.shiftKey) return handled(), s.extractWorkArea();
        if (e.key === 'F9' && e.shiftKey) return handled(), s.easeSelectedKeys('out');
        return;
      }

      if (e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        return handled(), s.trimSelectedToPlayhead(e.code === 'BracketLeft' ? 'in' : 'out');
      }

      switch (e.key) {
        case ' ':
          return handled(), s.togglePlay();
        case 'ArrowLeft':
          return handled(), s.stepFrames(e.shiftKey ? -10 : -1);
        case 'ArrowRight':
          return handled(), s.stepFrames(e.shiftKey ? 10 : 1);
        case 'ArrowUp':
          return handled(), s.jump('prev-edit');
        case 'ArrowDown':
          return handled(), s.jump('next-edit');
        case 'Home':
          return handled(), s.jump('start');
        case 'End':
          return handled(), s.jump('end');
        case 'Delete':
        case 'Backspace':
          return handled(), s.deleteSelected(e.shiftKey !== s.ripple);
        case 'Escape':
          s.selectLayer(null);
          return handled();
        case 'F9':
          return handled(), s.easeSelectedKeys(e.shiftKey ? 'in' : 'both');
        case '[':
          return handled(), s.alignSelectedToPlayhead('in');
        case ']':
          return handled(), s.alignSelectedToPlayhead('out');
        case '?':
          return handled(), h.help();
        case '=':
        case '+':
          return handled(), zoomBy(1.5);
        case '-':
        case '_':
          return handled(), zoomBy(1 / 1.5);
        case '\\': {
          handled();
          const w = useTimelineUI.getState().trackWidth;
          s.set('pxPerSec', Math.max(4, (w - 30) / activeComp(s).duration));
          return s.setScrollTime(-1);
        }
      }
      if (e.altKey || (e.shiftKey && !REVEAL[k])) return;
      switch (k) {
        case 'j':
          return handled(), s.jumpKeyframe(-1);
        case 'k':
          return handled(), s.jumpKeyframe(1);
        case 'i':
          return handled(), s.jump('in');
        case 'o':
          return handled(), s.jump('out');
        case 'b':
          return handled(), s.setWorkArea(s.playhead, activeComp(s).workArea.end);
        case 'n':
          return handled(), s.setWorkArea(activeComp(s).workArea.start, s.playhead + 1 / activeComp(s).fps);
        case 'm':
          return handled(), s.addMarker();
        case 'u':
          return handled(), s.setReveal(s.reveal === 'animated' ? null : 'animated');
      }
      const paths = REVEAL[k];
      if (paths) {
        handled();
        const cur = Array.isArray(s.reveal) ? s.reveal : [];
        if (e.shiftKey) {
          const next = cur.includes(paths[0]) ? cur.filter((p) => p !== paths[0]) : [...cur, ...paths];
          s.setReveal(next.length ? next : null);
        } else {
          s.setReveal(cur.length === 1 && cur[0] === paths[0] ? null : paths);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [h]);
}

function zoomBy(f: number) {
  const s = editor();
  const w = useTimelineUI.getState().trackWidth;
  const px = Math.max(0, Math.min(w, (s.playhead - s.scrollTime) * s.pxPerSec));
  s.setZoom(s.pxPerSec * f, s.playhead, px);
}
