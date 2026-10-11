import { useState } from 'react';
import { useEditor } from '../state/store';
import { ContextMenu } from './components/fields';

interface Props {
  onHome: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveNoMedia: () => void;
  onImport: () => void;
  onHelp: () => void;
  onPlugins: () => void;
  onExport: () => void;
}

export function TopBar({ onHome, onOpen, onSave, onSaveNoMedia, onImport, onHelp, onPlugins, onExport }: Props) {
  const name = useEditor((s) => s.project.name);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const undoLabel = useEditor((s) => s.undoLabel);
  const redoLabel = useEditor((s) => s.redoLabel);
  const s = useEditor.getState();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="topbar">
      <button className="logo ghost" onClick={onHome} title="Home: save and go back to your projects">
        <span className="logo-mark" />
        Luscent
      </button>
      <input
        className="project-name"
        type="text"
        key={name}
        defaultValue={name}
        title="Project name"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => e.target.value.trim() && e.target.value !== name && s.renameProject(e.target.value.trim())}
      />
      <span className="sep" />
      <button className="ghost" onClick={onOpen} title="Open a .lsp project file (⌘O)">
        Open…
      </button>
      <span className="split-btn">
        <button className="ghost" onClick={onSave} title="Save a .lsp project file with its media (⌘S)">
          Save
        </button>
        <button
          className="ghost caret"
          aria-label="More save options"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          ▾
        </button>
      </span>
      <button onClick={onImport} title="Import media (⌘I)">
        Import media
      </button>
      <span className="sep" />
      <button className="icon ghost" disabled={!canUndo} onClick={() => s.undo()} title={undoLabel ? `Undo ${undoLabel} (⌘Z)` : 'Undo'}>
        ↶
      </button>
      <button className="icon ghost" disabled={!canRedo} onClick={() => s.redo()} title={redoLabel ? `Redo ${redoLabel} (⌘⇧Z)` : 'Redo'}>
        ↷
      </button>
      <span className="spacer" />
      <button className="ghost" onClick={onPlugins} title="Effects library, plugin install and Shader Lab">
        ✦ Plugins
      </button>
      <button className="ghost" onClick={onHelp} title="Keyboard shortcuts (?)">
        ⌨ Shortcuts
      </button>
      <button className="primary" onClick={onExport} title="Export MP4 / WebM / GIF (⌘E)">
        Export
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Save with media (.lsp)', action: onSave },
            { label: 'Save without media (.lsp)', action: onSaveNoMedia },
          ]}
        />
      )}
    </div>
  );
}
