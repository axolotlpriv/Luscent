/**
 * Phone layout of the editor: preview on top, the timeline below it, a bottom
 * navigation bar and bottom sheets for the Project, Presets and Inspector
 * panels. The same panels and timeline as the desktop layout are reused; this
 * file only arranges them for a thumb.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { activeComp, editor, useEditor } from '../../state/store';
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
  const items: MenuItem[] = [
    { label: 'Home', action: a.onHome },
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

/** Quick actions for the selected layer(s), shown above the navigation bar. */
function SelectionBar({ onEdit }: { onEdit: () => void }) {
  const count = useEditor((s) => s.selectedLayers.length);
  const name = useEditor((s) => {
    const c = activeComp(s);
    return c.layers.find((l) => l.id === s.selectedLayers[0])?.name ?? '';
  });
  if (!count) return null;
  const s = editor();
  return (
    <div className="m-selbar">
      <span className="m-selname">{count > 1 ? `${count} layers` : name}</span>
      <button onClick={() => s.splitAtPlayhead()}>Split</button>
      <button onClick={() => s.duplicateSelected()}>Duplicate</button>
      <button onClick={onEdit}>Edit</button>
      <button className="danger" onClick={() => s.deleteSelected(false)}>
        Delete
      </button>
    </div>
  );
}

export function MobileEditor(a: Actions) {
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [stageH, setStageH] = useState(() => Math.round(Math.min(window.innerHeight * 0.42, 460)));
  const selected = useEditor((s) => s.selectedLayers.length);
  const sheetRef = useRef<HTMLDivElement>(null);

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
      </div>
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
          <div className="m-sheet-head">
            <span className="m-grab" />
            <strong>{title}</strong>
            <button className="m-icon" onClick={() => setSheet(null)} aria-label="Close">
              ✕
            </button>
          </div>
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
