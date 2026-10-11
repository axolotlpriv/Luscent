import { useRef, useState } from 'react';
import { COMP_PRESETS } from '../../core/model/factory';
import type { Id, MediaItem } from '../../core/model/types';
import { formatTimecode } from '../../core/time';
import { mediaEngine } from '../../engine/media/MediaEngine';
import { idb } from '../../engine/persist/db';
import { editor, useEditor, type LayerKind } from '../../state/store';
import { ContextMenu, type MenuItem } from '../components/fields';

const ADDERS: { kind: LayerKind; glyph: string; label: string; title: string }[] = [
  { kind: 'text', glyph: 'T', label: 'Text', title: 'Text layer' },
  { kind: 'rect', glyph: '▢', label: 'Rect', title: 'Rounded rectangle shape' },
  { kind: 'ellipse', glyph: '◯', label: 'Ellipse', title: 'Ellipse shape' },
  { kind: 'solid', glyph: '■', label: 'Solid', title: 'Full-frame solid' },
  { kind: 'null', glyph: '⌖', label: 'Null', title: 'Null object (parent controller)' },
  { kind: 'flash', glyph: '✦', label: 'Flash', title: 'White flash at the playhead' },
  { kind: 'adjustment', glyph: '◐', label: 'Adjust', title: 'Adjustment layer: its effects apply to everything below' },
];

function fmtDuration(m: MediaItem) {
  if (!Number.isFinite(m.duration)) return `${m.width}×${m.height}`;
  const d = m.duration;
  const base = d >= 60 ? `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}` : `${d.toFixed(1)}s`;
  return m.kind === 'audio' ? base : `${base} · ${m.width}×${m.height}`;
}

export function ProjectPanel() {
  const project = useEditor((s) => s.project);
  const activeCompId = useEditor((s) => s.activeCompId);
  useEditor((s) => s.mediaVersion);
  const fileRef = useRef<HTMLInputElement>(null);
  const relinkRef = useRef<HTMLInputElement>(null);
  const relinkId = useRef<Id | null>(null);
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [presetId, setPresetId] = useState(COMP_PRESETS[0].id);
  const s = useEditor.getState();

  const relink = async (file: File) => {
    const id = relinkId.current;
    const item = id ? editor().project.media[id] : null;
    if (!item) return;
    await idb.put('media', item.id, file).catch(() => undefined);
    await mediaEngine.attach(item, file, (mid, a) => editor().setAnalysis(mid, a));
    editor().toast(`Relinked ${item.name}`, 'success');
  };

  return (
    <div className="panel">
      <div className="panel-head">Project</div>
      <div className="panel-body">
        <div className="section">
          <div className="section-title">Add layer</div>
          <div className="add-grid">
            {ADDERS.map((a) => (
              <button key={a.kind} title={a.title} onClick={() => s.addLayer(a.kind)}>
                <span className="glyph">{a.glyph}</span>
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="section">
          <div className="section-title">
            Media <span className="grow" />
            <button className="icon ghost" title="Import media" onClick={() => fileRef.current?.click()}>
              ＋
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files) void s.importFiles([...e.target.files]);
              e.target.value = '';
            }}
          />
          <input
            ref={relinkRef}
            type="file"
            accept="video/*,audio/*,image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void relink(f);
              e.target.value = '';
            }}
          />
          {project.mediaOrder.length === 0 && (
            <div
              className={'drop-hint' + (over ? ' over' : '')}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOver(false);
                void s.importFiles([...e.dataTransfer.files]);
              }}
            >
              Drop video, audio or images
              <div className="hint">MP4 · MOV · WebM · MP3 · WAV · PNG · JPG</div>
            </div>
          )}
          {project.mediaOrder.map((id) => {
            const m = project.media[id];
            if (!m) return null;
            const status = mediaEngine.statusOf(id);
            const url = mediaEngine.url(id);
            return (
              <div
                key={id}
                className="item-row"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-luscent-media', id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => s.addMediaToComp(id)}
                title="Double-click to add at the playhead · drag onto the timeline"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: 'Add to composition', action: () => editor().addMediaToComp(id) },
                      {
                        label: 'Relink file…',
                        action: () => {
                          relinkId.current = id;
                          relinkRef.current?.click();
                        },
                      },
                      { separator: true, label: '' },
                      { label: 'Remove from project', action: () => editor().removeMedia(id) },
                    ],
                  });
                }}
              >
                <div className="thumb">
                  {m.kind === 'image' && url ? <img src={url} alt="" /> : m.kind === 'video' ? '▶' : '♪'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">{m.name}</div>
                  <div className="meta">{fmtDuration(m)}</div>
                </div>
                {m.analysis?.bpm ? <span className="badge beat">{Math.round(m.analysis.bpm)}</span> : null}
                {status === 'loading' && <span className="badge">…</span>}
                {status === 'missing' && (
                  <span
                    className="badge warn"
                    style={{ cursor: 'pointer' }}
                    title="Media file not found in this browser — click to relink"
                    onClick={() => {
                      relinkId.current = id;
                      relinkRef.current?.click();
                    }}
                  >
                    relink
                  </span>
                )}
                {status === 'error' && (
                  <span className="badge warn" title={mediaEngine.errorOf(id) ?? ''}>
                    !
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="section">
          <div className="section-title">Compositions</div>
          {project.compOrder.map((id) => {
            const c = project.compositions[id];
            if (!c) return null;
            return (
              <div
                key={id}
                className={'item-row' + (id === activeCompId ? ' active' : '')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-luscent-comp', id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => s.openComp(id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: 'Open', action: () => editor().openComp(id) },
                      { label: 'Nest in current composition', disabled: id === activeCompId, action: () => editor().addCompToComp(id) },
                      { separator: true, label: '' },
                      { label: 'Delete composition', action: () => editor().deleteComp(id) },
                    ],
                  });
                }}
                title="Click to open · drag onto the timeline to nest"
              >
                <div className="thumb" style={{ aspectRatio: `${c.width}/${c.height}`, width: 'auto', height: 24 }}>
                  ❐
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">{c.name}</div>
                  <div className="meta">
                    {c.width}×{c.height} · {c.fps}fps · {formatTimecode(c.duration, c.fps)}
                  </div>
                </div>
              </div>
            );
          })}
          <div className="row" style={{ marginTop: 6 }}>
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
              {COMP_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button onClick={() => s.createComp(COMP_PRESETS.find((p) => p.id === presetId))}>New</button>
          </div>
        </div>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
