import { useEditor } from '../state/store';

interface Props {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onImport: () => void;
  onHelp: () => void;
  onPlugins: () => void;
}

export function TopBar({ onNew, onOpen, onSave, onImport, onHelp, onPlugins }: Props) {
  const name = useEditor((s) => s.project.name);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const undoLabel = useEditor((s) => s.undoLabel);
  const redoLabel = useEditor((s) => s.redoLabel);
  const s = useEditor.getState();
  return (
    <div className="topbar">
      <div className="logo">
        <span className="logo-mark" />
        Luscent
      </div>
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
      <button className="ghost" onClick={onNew} title="New project">
        New
      </button>
      <button className="ghost" onClick={onOpen} title="Open project file (⌘O)">
        Open…
      </button>
      <button className="ghost" onClick={onSave} title="Save project file (⌘S)">
        Save
      </button>
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
      <button className="primary" disabled title="H.264 / WebM / GIF export lands in phase 4">
        Export
      </button>
    </div>
  );
}
