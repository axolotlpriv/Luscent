import { useCallback, useEffect, useRef, useState } from 'react';
import { COMP_PRESETS } from '../../core/model/factory';
import { LSP_EXTENSION } from '../../core/model/lsp';
import { seedDemo } from '../../demo';
import { setAutosaveBaseline } from '../../engine/persist/autosave';
import { listProjects, timeAgo, type ProjectRecord } from '../../engine/persist/projects';
import { isNativeApp } from '../../engine/platform/files';
import { useApp } from '../../state/app';
import {
  createNewProject,
  createProjectFromMedia,
  deleteRecentProject,
  downloadRecentProject,
  openProjectFile,
  openRecentProject,
} from '../../state/projectActions';
import { editor, useEditor } from '../../state/store';
import { ContextMenu, type MenuItem } from '../components/fields';
import './home.css';

const FORMAT_NOTES: Record<string, string> = {
  'vertical-1080-30': 'TikTok · Reels · Shorts',
  'vertical-1080-60': 'Smooth motion',
  'vertical-2160-60': 'Ultra HD',
  'square-1080-30': 'Feed posts',
  'portrait-1080-30': 'Instagram feed',
  'landscape-1080-30': 'YouTube · landscape',
  'landscape-1080-60': 'Gameplay · smooth',
  'landscape-2160-60': '4K landscape',
};

function FormatCard({ id, label, width, height, fps, primary }: { id: string; label: string; width: number; height: number; fps: number; primary?: boolean }) {
  const ratio = width / height;
  const [w, h] = ratio >= 1 ? [44, 44 / ratio] : [44 * ratio, 44];
  const ratioLabel = label.split(' ')[0];
  return (
    <button className={'format-card' + (primary ? ' primary' : '')} onClick={() => createNewProject(id)} title={label}>
      <span className="format-art">
        <span className="format-frame" style={{ width: w, height: h }} />
      </span>
      <span className="format-text">
        <strong>
          {ratioLabel} <small>{fps} fps</small>
        </strong>
        <span>
          {width}×{height}
        </span>
        <em>{FORMAT_NOTES[id]}</em>
      </span>
    </button>
  );
}

function ProjectCard({ rec, onMenu, onOpen }: { rec: ProjectRecord; onMenu: (e: React.MouseEvent) => void; onOpen: () => void }) {
  const ratio = rec.width && rec.height ? rec.width / rec.height : 9 / 16;
  const mins = Math.floor(rec.duration / 60);
  const secs = Math.round(rec.duration % 60)
    .toString()
    .padStart(2, '0');
  return (
    <div className="project-card" onClick={onOpen} onContextMenu={onMenu} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="project-thumb">
        {rec.thumb ? (
          <img src={rec.thumb} alt="" style={{ aspectRatio: String(ratio) }} />
        ) : (
          <span className="project-thumb-empty" style={{ aspectRatio: String(ratio) }}>
            <span />
          </span>
        )}
      </div>
      <div className="project-info">
        <div className="project-title">
          <strong title={rec.name}>{rec.name}</strong>
          <button className="icon ghost" aria-label="Project actions" onClick={onMenu}>
            ⋯
          </button>
        </div>
        <span className="project-meta">
          {timeAgo(rec.modified)} · {rec.width}×{rec.height} · {mins}:{secs}
        </span>
      </div>
    </div>
  );
}

export function Home() {
  const [recent, setRecent] = useState<ProjectRecord[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [over, setOver] = useState(false);
  const openRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  const toasts = useEditor((s) => s.toasts);

  const refresh = useCallback(() => void listProjects().then(setRecent), []);
  useEffect(refresh, [refresh]);

  // Ask the browser not to evict the projects and media stored here.
  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => undefined);
  }, []);

  const handleFiles = useCallback((files: File[]) => {
    const project = files.find((f) => /\.(lsp|json)$/i.test(f.name));
    if (project) void openProjectFile(project);
    else if (files.length) void createProjectFromMedia(files);
  }, []);

  // Dropping a project file or media anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const dragover = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      handleFiles([...e.dataTransfer!.files]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', dragover);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', dragover);
      window.removeEventListener('drop', drop);
    };
  }, [handleFiles]);

  const cardMenu = (rec: ProjectRecord) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open', action: () => void openRecentProject(rec.id) },
        { label: 'Save as .lsp file…', action: () => void downloadRecentProject(rec.id) },
        { separator: true, label: '' },
        {
          label: 'Delete from this browser',
          action: () => {
            if (window.confirm(`Delete “${rec.name}” from this browser? Save a .lsp file first if you want to keep it.`)) void deleteRecentProject(rec.id).then(refresh);
          },
        },
      ],
    });
  };

  const sample = () => {
    seedDemo();
    setAutosaveBaseline(editor().project);
    useApp.getState().setScreen('editor');
  };

  const [primary, ...others] = COMP_PRESETS;

  return (
    <div className="home">
      <header className="home-top">
        <div className="logo">
          <span className="logo-mark" />
          Luscent
        </div>
        <span className="spacer" />
        <a className="home-link" href="https://github.com/axolotlpriv/Luscent" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>

      <main className="home-main">
        <section className="hero">
          <h1>
            Edits that <span className="grad">hit</span>.
          </h1>
          <p>A motion editor for short-form video. Timeline, graph editor, effects and optical-flow slow-mo, all running on your device.</p>
          <div className="hero-actions">
            <button className="primary big" onClick={() => createNewProject(primary.id)}>
              ＋ New project
            </button>
            <button className="big" onClick={() => openRef.current?.click()}>
              Open project
            </button>
            <button className="big" onClick={() => mediaRef.current?.click()}>
              Start from a video
            </button>
          </div>
          <div className="hero-hint">
            Opens <code>{LSP_EXTENSION}</code> project files. Drop a video anywhere to start.
          </div>
        </section>

        <section className="home-section">
          <h2>Choose a format</h2>
          <div className="format-grid">
            <FormatCard {...primary} primary />
            {others.map((p) => (
              <FormatCard key={p.id} {...p} />
            ))}
          </div>
        </section>

        <section className="home-section">
          <h2>Recent projects {recent && recent.length > 0 && <small>{recent.length}</small>}</h2>
          {recent === null ? null : recent.length === 0 ? (
            <div className="empty-recent">
              <strong>No projects yet</strong>
              <span>Projects you make are saved in this browser automatically. Save a {LSP_EXTENSION} file to back one up or move it to another device.</span>
            </div>
          ) : (
            <div className="project-grid">
              {recent.map((rec) => (
                <ProjectCard key={rec.id} rec={rec} onOpen={() => void openRecentProject(rec.id)} onMenu={cardMenu(rec)} />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="home-foot">
        <button className="ghost" onClick={sample}>
          Open the sample project
        </button>
        <span>·</span>
        <span>AGPL-3.0</span>
        <span>·</span>
        <span>Everything stays on your device</span>
      </footer>

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
      <input
        ref={mediaRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void createProjectFromMedia(files);
        }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {over && <div className="file-drop-overlay">Drop to open</div>}
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
