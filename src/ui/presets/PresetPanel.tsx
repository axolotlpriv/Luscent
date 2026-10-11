import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hasCapturableAnimation, presetFromLayer } from '../../core/presets/capture';
import type { LuscentPreset } from '../../core/presets/types';
import type { FfxReport } from '../../core/ffx/import';
import { allPresets, usePresetLibrary } from '../../state/presetLibrary';
import { activeComp, editor, useEditor } from '../../state/store';
import { downloadText } from '../download';
import { applyPresetWithToast, PRESET_DRAG_TYPE } from './applyPreset';

const GLYPH: Record<string, string> = {
  Shake: '≋',
  Flash: '✦',
  Zoom: '⊕',
  Velocity: '»',
  Transitions: '⇄',
  Text: 'T',
  Stylize: '◐',
  Imported: 'Ae',
  'My Presets': '★',
};

function badges(p: LuscentPreset): string[] {
  const b: string[] = [];
  if (p.target === 'comp') b.push('adds layer');
  if (p.requires?.includes('video')) b.push('video');
  if (p.requires?.includes('text')) b.push('text');
  if (p.speedRamp?.length) b.push('speed');
  if (p.effects?.length) b.push(`${p.effects.length} fx`);
  return b;
}

export function PresetPanel({ head }: { head: ReactNode }) {
  const lib = usePresetLibrary();
  const selectedLayers = useEditor((s) => s.selectedLayers);
  const comp = useEditor(activeComp);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('All');
  const [sel, setSel] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ name: string; category: string } | null>(null);
  const [report, setReport] = useState<FfxReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!lib.loaded) void lib.load();
  }, [lib]);

  const presets = useMemo(() => allPresets(lib.user), [lib.user]);
  const cats = useMemo(() => ['All', ...new Set(presets.map((p) => p.category))], [presets]);
  const q = query.trim().toLowerCase();
  const shown = presets.filter(
    (p) =>
      (cat === 'All' || p.category === cat) &&
      (!q || [p.name, p.category, p.description ?? '', ...(p.tags ?? [])].some((s) => s.toLowerCase().includes(q))),
  );
  const current = presets.find((p) => p.id === sel) ?? null;
  const layer = comp.layers.find((l) => l.id === selectedLayers[0]);
  const canSave = !!layer && hasCapturableAnimation(layer);

  const save = () => {
    if (!layer || !saving) return;
    const s = editor();
    const preset = presetFromLayer(layer, {
      name: saving.name.trim() || layer.name,
      category: saving.category.trim() || 'My Presets',
      fallbackTime: s.playhead - layer.startTime,
    });
    lib.save(preset);
    setSaving(null);
    setCat('All');
    setSel(preset.id);
    s.toast(`Saved preset “${preset.name}”`, 'success');
  };

  const importFiles = async (files: File[]) => {
    for (const f of files) {
      try {
        const r = await lib.importFile(f);
        if (r.presets[0]) setSel(r.presets[0].id);
        if (r.report) setReport(r.report);
        else editor().toast(`Imported ${r.presets.length} preset${r.presets.length === 1 ? '' : 's'} from ${f.name}`, 'success');
      } catch (err) {
        editor().toast(`${f.name}: ${(err as Error).message}`, 'error');
      }
    }
  };

  const exportSel = () => {
    if (!current) return;
    downloadText(`${current.name.replace(/[^\w\- ]+/g, '').trim() || 'preset'}.luscent-preset.json`, lib.exportJSON([current.id]));
  };
  const exportMine = () => {
    if (!lib.user.length) return;
    downloadText('my-presets.luscent-presets.json', lib.exportJSON(lib.user.map((p) => p.id)));
  };

  return (
    <div className="panel">
      <div className="panel-head">{head}</div>
      <div className="preset-tools">
        <input type="text" placeholder="Search presets…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="preset-cats">
          {cats.map((c) => (
            <button key={c} className={'chip' + (cat === c ? ' on' : '')} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body preset-list">
        {shown.map((p) => (
          <div
            key={p.id}
            className={'item-row preset-row' + (sel === p.id ? ' active' : '')}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PRESET_DRAG_TYPE, p.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => setSel(p.id)}
            onDoubleClick={() => applyPresetWithToast(p)}
            title={`${p.description ?? p.name}\nDouble-click to apply at the playhead · drag onto a layer in the timeline`}
          >
            <span className={'thumb preset-glyph cat-' + p.category.toLowerCase().replace(/\s+/g, '-')}>{GLYPH[p.category] ?? '◆'}</span>
            <div className="name">
              <div>{p.name}</div>
              <div className="meta">{badges(p).join(' · ') || p.category}</div>
            </div>
          </div>
        ))}
        {shown.length === 0 && <div className="hint" style={{ padding: 12 }}>No presets match.</div>}
      </div>
      {current && (
        <div className="preset-detail">
          <div className="row">
            <strong className="grow">{current.name}</strong>
            <span className="meta">{current.builtin ? 'Built-in' : (current.author ?? 'Yours')}</span>
          </div>
          {current.description && <div className="hint">{current.description}</div>}
          {current.importReport && (
            <button className="ghost link" onClick={() => setReport(current.importReport!)}>
              Import report ({current.importReport.unmapped.length} unmapped)
            </button>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary grow" onClick={() => applyPresetWithToast(current)} disabled={current.target === 'layer' && !selectedLayers.length}>
              {current.target === 'comp' ? 'Add at playhead' : selectedLayers.length ? `Apply to ${selectedLayers.length > 1 ? `${selectedLayers.length} layers` : 'layer'}` : 'Select a layer'}
            </button>
            <button className="icon" title="Export as JSON" onClick={exportSel}>
              ⤓
            </button>
            {!current.builtin && (
              <button
                className="icon"
                title="Delete preset"
                onClick={() => {
                  if (window.confirm(`Delete preset “${current.name}”?`)) {
                    lib.remove(current.id);
                    setSel(null);
                  }
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}
      {saving && (
        <div className="preset-detail">
          <div className="section-title">Save {layer?.name ?? 'layer'} as preset</div>
          <input
            type="text"
            autoFocus
            placeholder="Preset name"
            value={saving.name}
            onChange={(e) => setSaving({ ...saving, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <input
            type="text"
            placeholder="Category"
            value={saving.category}
            style={{ marginTop: 4 }}
            onChange={(e) => setSaving({ ...saving, category: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <div className="hint" style={{ margin: '4px 0' }}>
            Keyframes (with eases), wiggles, effects and speed ramps. Position moves are saved relative.
          </div>
          <div className="row">
            <button className="primary grow" onClick={save}>
              Save
            </button>
            <button onClick={() => setSaving(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="preset-actions">
        <button
          disabled={!canSave}
          title={canSave ? 'Save the selected layer’s animation as a preset' : 'Select a layer with keyframes or effects'}
          onClick={() => setSaving({ name: layer?.name ?? '', category: 'My Presets' })}
        >
          Save layer…
        </button>
        <button title="Import Luscent .json presets or After Effects .ffx/.aep" onClick={() => fileRef.current?.click()}>
          Import…
        </button>
        <button disabled={!lib.user.length} title="Export all your presets as one file" onClick={exportMine}>
          Export mine
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".json,.ffx,.aep,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void importFiles(files);
        }}
      />
      {report && <ImportReport report={report} onClose={() => setReport(null)} />}
    </div>
  );
}

function ImportReport({ report, onClose }: { report: FfxReport; onClose: () => void }) {
  const section = (title: string, items: string[], cls: string) =>
    items.length > 0 && (
      <div className={'report-section ' + cls}>
        <div className="section-title">
          {title} <span className="meta">{items.length}</span>
        </div>
        <ul>
          {items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Import report</h2>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>
          {report.source}. The preset was added under <em>Imported</em>.
        </div>
        {section('Mapped', report.mapped, 'ok')}
        {section('Approximated', report.approximated, 'warn')}
        {section('Not mapped', report.unmapped, 'bad')}
        {!report.mapped.length && !report.approximated.length && <div className="hint">Nothing in this file could be mapped to Luscent.</div>}
      </div>
    </div>
  );
}
