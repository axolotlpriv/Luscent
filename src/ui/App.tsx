import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LSP_EXTENSION } from '../core/model/lsp';
import { isNativeApp } from '../engine/platform/files';
import { useApp } from '../state/app';
import { goHome, openProjectFile, saveProjectToFile } from '../state/projectActions';
import { editor, useEditor } from '../state/store';
import { Home } from './home/Home';
import { MobileEditor } from './mobile/MobileEditor';
import { useLayout } from './timeline/uiState';
import { Inspector } from './panels/Inspector';
import { ProjectPanel } from './panels/ProjectPanel';
import { SHORTCUTS, useShortcuts } from './shortcuts';
import { Timeline } from './timeline/Timeline';
import { TopBar } from './TopBar';
import { Viewer } from './viewer/Viewer';
import { PluginManager } from './plugins/PluginManager';
import { ExportDialog } from './export/ExportDialog';
import { PresetPanel } from './presets/PresetPanel';

function LeftPanel() {
  const [tab, setTab] = useState<'project' | 'presets'>(() => {
    try {
      return localStorage.getItem('luscent.leftTab') === 'presets' ? 'presets' : 'project';
    } catch {
      return 'project';
    }
  });
  const pick = (t: 'project' | 'presets') => {
    setTab(t);
    try {
      localStorage.setItem('luscent.leftTab', t);
    } catch {
      /* private mode */
    }
  };
  const head = (
    <div className="panel-tabs">
      <button className={tab === 'project' ? 'on' : ''} onClick={() => pick('project')}>
        Project
      </button>
      <button className={tab === 'presets' ? 'on' : ''} onClick={() => pick('presets')}>
        Presets
      </button>
    </div>
  );
  return tab === 'project' ? <ProjectPanel head={head} /> : <PresetPanel head={head} />;
}

export function App() {
  const screen = useApp((s) => s.screen);
  return screen === 'home' ? <Home /> : <EditorScreen />;
}

function EditorScreen() {
  const [timelineH, setTimelineH] = useState(() => Math.round(window.innerHeight * 0.4));
  const [help, setHelp] = useState(false);
  const [plugins, setPlugins] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLInputElement>(null);
  const toasts = useEditor((s) => s.toasts);

  const save = useCallback(() => void saveProjectToFile(), []);

  const handlers = useMemo(
    () => ({
      save,
      open: () => openRef.current?.click(),
      importMedia: () => importRef.current?.click(),
      help: () => setHelp((h) => !h),
      exportVideo: () => setExporting(true),
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
      const files = [...e.dataTransfer!.files];
      const proj = files.find((f) => /\.(lsp)$/i.test(f.name));
      if (proj) void openProjectFile(proj);
      else
        void editor().importFiles(files, {
          addToComp: editor().project.mediaOrder.length === 0,
        });
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

  const compact = useLayout((s) => s.compact);
  const actions = {
    onHome: () => void goHome(),
    onOpen: handlers.open,
    onSave: save,
    onSaveNoMedia: () => void saveProjectToFile({ embedMedia: false }),
    onImport: handlers.importMedia,
    onPlugins: () => setPlugins(true),
    onExport: () => setExporting(true),
  };

  return (
    <>
      {compact ? (
        <MobileEditor key="compact" {...actions} />
      ) : (
        <div className="app">
          <TopBar
            onHome={() => void goHome()}
            onOpen={handlers.open}
            onSave={save}
            onSaveNoMedia={() => void saveProjectToFile({ embedMedia: false })}
            onImport={handlers.importMedia}
            onHelp={handlers.help}
            onPlugins={() => setPlugins(true)}
            onExport={() => setExporting(true)}
          />
          <div className="workspace" style={{ gridTemplateRows: `1fr 5px ${timelineH}px` }}>
            <div className="upper">
              <LeftPanel />
              <Viewer />
              <Inspector />
            </div>
            <div className="splitter" onPointerDown={onSplitter} />
            <Timeline />
          </div>
        </div>
      )}
      <input
        ref={importRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          // On phones, imported clips go straight onto the timeline.
          if (e.target.files) void editor().importFiles([...e.target.files], { addToComp: useLayout.getState().compact });
          e.target.value = '';
        }}
      />
      <input
        ref={openRef}
        type="file"
        accept={isNativeApp() ? undefined : `${LSP_EXTENSION},.json`}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openProjectFile(f);
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
              Dragging: hold <kbd>⌘/Ctrl</kbd> to invert snapping, <kbd>Alt</kbd> on a clip edge to ripple-trim, <kbd>Alt</kbd>-drag a clip body to slip its
              source, <kbd>⇧</kbd> to toggle selection. Number fields: drag to scrub (<kbd>⇧</kbd> ×10, <kbd>Alt</kbd> ×0.1), click to type (math allowed).
            </p>
          </div>
        </div>
      )}
      {plugins && <PluginManager onClose={() => setPlugins(false)} />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {fileOver && <div className="file-drop-overlay">Drop to import</div>}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind} onClick={() => editor().dismissToast(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}
