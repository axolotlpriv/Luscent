import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deserializeProject, serializeProject } from '../core/model/serialize';
import { attachAllMedia } from '../engine/persist/autosave';
import { editor, useEditor } from '../state/store';
import { Inspector } from './panels/Inspector';
import { ProjectPanel } from './panels/ProjectPanel';
import { SHORTCUTS, useShortcuts } from './shortcuts';
import { Timeline } from './timeline/Timeline';
import { TopBar } from './TopBar';
import { Viewer } from './viewer/Viewer';
import { PluginManager } from './plugins/PluginManager';

export function App() {
  const [timelineH, setTimelineH] = useState(() => Math.round(window.innerHeight * 0.4));
  const [help, setHelp] = useState(false);
  const [plugins, setPlugins] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLInputElement>(null);
  const toasts = useEditor((s) => s.toasts);

  const save = useCallback(() => {
    const p = editor().project;
    const blob = new Blob([serializeProject(p)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.replace(/[^\w\- ]+/g, '').trim() || 'project'}.luscent.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    editor().set('dirty', false);
    editor().toast('Project saved. Media stays in this browser; relink files when opening elsewhere.', 'success');
  }, []);

  const handlers = useMemo(
    () => ({
      save,
      open: () => openRef.current?.click(),
      importMedia: () => importRef.current?.click(),
      help: () => setHelp((h) => !h),
    }),
    [save],
  );
  useShortcuts(handlers);

  // Buttons shouldn't keep keyboard focus: Space must always mean play/pause.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest?.('button');
      if (b) b.blur();
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  // Window-level file drops import media (timeline drops add at the drop time).
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setFileOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setFileOver(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setFileOver(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      void editor().importFiles([...e.dataTransfer!.files], { addToComp: editor().project.mediaOrder.length === 0 });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const onSplitter = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = timelineH;
    const move = (ev: PointerEvent) => setTimelineH(Math.max(140, Math.min(window.innerHeight - 220, startH - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="app">
      <TopBar
        onNew={() => {
          if (!editor().dirty || window.confirm('Start a new project? Unsaved changes in the current one will be lost.')) editor().newProject();
        }}
        onOpen={handlers.open}
        onSave={save}
        onImport={handlers.importMedia}
        onHelp={handlers.help}
        onPlugins={() => setPlugins(true)}
      />
      <div className="workspace" style={{ gridTemplateRows: `1fr 5px ${timelineH}px` }}>
        <div className="upper">
          <ProjectPanel />
          <Viewer />
          <Inspector />
        </div>
        <div className="splitter" onPointerDown={onSplitter} />
        <Timeline />
      </div>
      <input
        ref={importRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void editor().importFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        ref={openRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            const p = deserializeProject(await f.text());
            editor().loadProject(p);
            await attachAllMedia(p);
            editor().toast(`Opened ${p.name}`, 'success');
          } catch (err) {
            editor().toast((err as Error).message, 'error');
          }
        }}
      />
      {help && (
        <div className="modal-bg" onClick={() => setHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard shortcuts</h2>
            <div className="shortcut-grid">
              {SHORTCUTS.map((s) => (
                <div key={s.keys}>
                  <span>{s.label}</span>
                  <kbd>{s.keys}</kbd>
                </div>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              Dragging: hold <kbd>⌘/Ctrl</kbd> to invert snapping, <kbd>Alt</kbd> on a clip edge to ripple-trim, <kbd>Alt</kbd>-drag a clip body to slip
              its source, <kbd>⇧</kbd> to toggle selection. Number fields: drag to scrub (<kbd>⇧</kbd> ×10, <kbd>Alt</kbd> ×0.1), click to type (math
              allowed).
            </p>
          </div>
        </div>
      )}
      {plugins && <PluginManager onClose={() => setPlugins(false)} />}
      {fileOver && <div className="file-drop-overlay">Drop to import</div>}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind} onClick={() => editor().dismissToast(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
