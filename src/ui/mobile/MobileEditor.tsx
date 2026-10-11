/**
 * Phone layout of the editor: preview on top, the timeline below it, a bottom
 * navigation bar and bottom sheets for the Project, Presets and Inspector
 * panels. The same panels and timeline as the desktop layout are reused; this
 * file only arranges them for a thumb.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatTimecode } from '../../core/time';
import { activeComp, editor, useEditor } from '../../state/store';
import { haptic } from '../haptics';
import { ContextMenu, type MenuItem } from '../components/fields';
import { Inspector } from '../panels/Inspector';
import { ProjectPanel } from '../panels/ProjectPanel';
import { PresetPanel } from '../presets/PresetPanel';
import { Timeline } from '../timeline/Timeline';
import { Viewer } from '../viewer/Viewer';
import './mobile.css';

type SheetId = 'project' | 'presets' | 'inspector';

interface Actions {
  onHome: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveNoMedia: () => void;
  onImport: () => void;
  onPlugins: () => void;
  onExport: () => void;
}

const NAV: { id: SheetId; label: string; glyph: ReactNode }[] = [
  {
    id: 'project',
    label: 'Add',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
  },
  {
    id: 'presets',
    label: 'Presets',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m13 3-8 11h6l-1 7 8-11h-6z" />
      </svg>
    ),
  },
  {
    id: 'inspector',
    label: 'Edit',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="8" cy="17" r="2" />
      </svg>
    ),
  },
];

function MobileTopBar(a: Actions) {
  const name = useEditor((s) => s.project.name);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const s = useEditor.getState();
  const safe = useEditor((st) => st.safeZones);
  const items: MenuItem[] = [
    { label: 'Home', action: a.onHome },
    { label: safe ? 'Hide safe zones' : 'Show TikTok/Reels safe zones', action: () => s.set('safeZones', !safe) },
    { label: 'Import media…', action: a.onImport },
    { label: 'Open project…', action: a.onOpen },
    { separator: true, label: '' },
    { label: 'Save project (.lsp)', action: a.onSave },
    { label: 'Save without media', action: a.onSaveNoMedia },
    { separator: true, label: '' },
    { label: 'Effects & plugins', action: a.onPlugins },
  ];
  return (
    <div className="m-top">
      <button className="m-logo" onClick={a.onHome} aria-label="Home">
        <span className="logo-mark" />
      </button>
      <input
        className="m-name"
        type="text"
        key={name}
        defaultValue={name}
        aria-label="Project name"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => e.target.value.trim() && e.target.value !== name && s.renameProject(e.target.value.trim())}
      />
      <button className="m-icon" disabled={!canUndo} onClick={() => s.undo()} aria-label="Undo">
        ↶
      </button>
      <button className="m-icon" disabled={!canRedo} onClick={() => s.redo()} aria-label="Redo">
        ↷
      </button>
      <button className="primary m-export" onClick={a.onExport}>
        Export
      </button>
      <button
        className="m-icon"
        aria-label="More"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right - 210, y: r.bottom + 4, items });
        }}
      >
        ⋯
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const KEY_PATHS = ['transform.position', 'transform.scale', 'transform.rotation', 'transform.opacity'];

/** Keyframe the selected layers' transform at the playhead, as one undo step. */
function keyframeSelection(): void {
  const s = editor();
  const comp = activeComp(s);
  const layers = comp.layers.filter((l) => s.selectedLayers.includes(l.id) && !l.locked);
  if (!layers.length) return;
  s.beginGesture('Add Keyframes');
  for (const l of layers) for (const path of KEY_PATHS) if (l.props[path]) editor().addKeyframe(l.id, path);
  editor().endGesture();
  editor().set('reveal', 'animated');
  haptic('confirm');
  editor().toast(`Keyframe added at ${formatTimecode(s.playhead, comp.fps)}`, 'success');
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Quick actions for the selected layer(s), shown above the navigation bar. */
function SelectionBar({ onEdit }: { onEdit: () => void }) {
  const count = useEditor((s) => s.selectedLayers.length);
  if (!count) return null;
  const s = editor();
  const actions: Array<{ label: string; d: string; run: () => void; danger?: boolean }> = [
    { label: 'Split', d: 'M12 3v18M6 7l-3 5 3 5M18 7l3 5-3 5', run: () => (s.splitAtPlayhead(), haptic('select')) },
    { label: 'Keyframe', d: 'M12 4l7 8-7 8-7-8z', run: keyframeSelection },
    { label: 'Edit', d: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4', run: onEdit },
    { label: 'Copy', d: 'M8 8h11v11H8zM5 16V5h11', run: () => s.duplicateSelected() },
    { label: 'Delete', d: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', run: () => s.deleteSelected(false), danger: true },
  ];
  return (
    <div className="m-selbar">
      {actions.map((a) => (
        <button key={a.label} className={a.danger ? 'danger' : ''} onClick={a.run}>
          <Icon d={a.d} />
          <span>{a.label}</span>
        </button>
      ))}
      <button className="m-selclose" aria-label="Deselect" onClick={() => s.selectLayer(null)}>
        <Icon d="M6 6l12 12M18 6L6 18" />
      </button>
    </div>
  );
}

/** Sheet header that can be swiped down to close. */
function SheetHead({ title, onClose }: { title: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const sheet = ref.current?.parentElement;
    if (!sheet) return;
    const y0 = e.clientY;
    let dy = 0;
    const move = (ev: PointerEvent) => {
      dy = Math.max(0, ev.clientY - y0);
      sheet.style.transform = `translateY(${dy}px)`;
      sheet.style.transition = 'none';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      sheet.style.transition = '';
      if (dy > 70) onClose();
      else sheet.style.transform = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div className="m-sheet-head" ref={ref} onPointerDown={onDown}>
      <span className="m-grab" />
      <strong>{title}</strong>
      <button className="m-icon" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

const TIPS_KEY = 'luscent.touchTips.v1';

/** One-time card explaining the touch gestures. */
function TouchTips() {
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(TIPS_KEY) !== 'seen';
    } catch {
      return false;
    }
  });
  if (!show) return null;
  const close = () => {
    setShow(false);
    try {
      localStorage.setItem(TIPS_KEY, 'seen');
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="m-tips" role="dialog" aria-label="Touch gestures">
      <strong>Quick tips</strong>
      <ul>
        <li>
          <b>Tap a clip</b> to select it, then drag it or its white edges.
        </li>
        <li>
          <b>Swipe</b> the timeline to scroll, <b>pinch</b> to zoom it.
        </li>
        <li>
          <b>Drag the pink marker</b> to scrub. Clips snap to the playhead, cuts and beats.
        </li>
        <li>
          In the preview, <b>pinch</b> a layer to scale and rotate it, <b>drag a corner</b> to resize.
        </li>
        <li>
          <b>Long-press</b> a layer for more options.
        </li>
      </ul>
      <button className="primary" onClick={close}>
        Got it
      </button>
    </div>
  );
}

export function MobileEditor(a: Actions) {
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [stageH, setStageH] = useState(() => Math.round(Math.min(window.innerHeight * 0.42, 460)));
  const selected = useEditor((s) => s.selectedLayers.length);
  const empty = useEditor((s) => activeComp(s).layers.length === 0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Adding a layer or media, or applying a preset, closes the sheet so you see the result.
  useEffect(() => {
    if (sheet !== 'project' && sheet !== 'presets') return;
    const layersNow = () => activeComp(editor()).layers.length;
    const count0 = layersNow();
    const undo0 = editor().undoLabel;
    return useEditor.subscribe((st, prev) => {
      if (st.project === prev.project) return;
      const added = layersNow() > count0;
      const preset = sheet === 'presets' && st.undoLabel !== undo0 && st.undoLabel?.startsWith('Preset');
      if (added || preset) setSheet(null);
    });
  }, [sheet]);

  // Android back button / browser back closes the sheet first.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheet(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const onSplitter = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = stageH;
    const move = (ev: PointerEvent) => setStageH(Math.max(150, Math.min(window.innerHeight - 330, h0 + ev.clientY - y0)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const title = sheet === 'project' ? 'Add & media' : sheet === 'presets' ? 'Presets' : 'Edit layer';

  return (
    <div className="app compact">
      <MobileTopBar {...a} />
      <div className="m-stage" style={{ height: stageH }}>
        <Viewer />
      </div>
      <div className="m-splitter" onPointerDown={onSplitter} role="separator" aria-label="Resize preview">
        <span />
      </div>
      <div className="m-timeline">
        <Timeline />
        {empty && (
          <div className="m-empty">
            <button className="primary" onClick={a.onImport}>
              ＋ Add video, photo or music
            </button>
            <span>or tap Add below for text, shapes and effects</span>
          </div>
        )}
      </div>
      <TouchTips />
      {!sheet && <SelectionBar onEdit={() => setSheet('inspector')} />}
      <nav className="m-nav" aria-label="Panels">
        {NAV.map((n) => (
          <button key={n.id} className={sheet === n.id ? 'on' : ''} onClick={() => setSheet(sheet === n.id ? null : n.id)}>
            {n.glyph}
            <span>{n.label}</span>
            {n.id === 'inspector' && selected > 0 && <i className="m-dot" />}
          </button>
        ))}
      </nav>
      {sheet && (
        <div className="m-sheet" ref={sheetRef} role="dialog" aria-label={title}>
          <SheetHead title={title} onClose={() => setSheet(null)} />
          <div className="m-sheet-body">
            {sheet === 'project' && <ProjectPanel head="Project" />}
            {sheet === 'presets' && <PresetPanel head="Presets" />}
            {sheet === 'inspector' && <Inspector />}
          </div>
        </div>
      )}
    </div>
  );
}
