import { useEffect, useMemo, useRef, useState } from 'react';
import { effectRegistry } from '../../core/effects/registry';
import { detectFormat, type ConversionReport } from '../../core/effects/convert';
import type { EffectPlugin } from '../../core/effects/types';
import { bundleReport, parsePluginText, pluginStore, serializePlugin } from '../../engine/plugins/pluginStore';
import { activeComp, editor } from '../../state/store';
import { downloadText } from '../download';
import { useEffectRegistry } from '../panels/EffectStack';
import { ISF_SHADERS } from '../../effects/bundled/isf';
import { SHADERTOY_SHADERS } from '../../effects/bundled/shadertoy';

type Tab = 'library' | 'install' | 'lab';

const EXAMPLES: Record<string, string> = {
  'Luscent GLSL': `// Luscent effect: define vec4 effect(vec2 uv). Inputs are premultiplied.
uniform float amount; // = 12 [0, 100] Offset (px)
uniform float speed; // = 2 [0, 10] Speed

vec4 effect(vec2 uv) {
  float wob = sin(uv.y * 40.0 + time * speed * 6.28) * amount * compPx().x;
  vec4 r = texture(source, uv + vec2(wob, 0.0));
  vec4 g = texture(source, uv);
  vec4 b = texture(source, uv - vec2(wob, 0.0));
  return vec4(r.r, g.g, b.b, g.a);
}`,
  'gl-transition': `// Author: You
// License: MIT
uniform float smoothness; // = 0.3

vec4 transition(vec2 uv) {
  float d = length(uv - 0.5) * 1.4142;
  float m = smoothstep(progress - smoothness, progress, d);
  return mix(getToColor(uv), getFromColor(uv), m);
}`,
  ISF: ISF_SHADERS[2].src,
  Shadertoy: SHADERTOY_SHADERS[1].src,
};

const LAB_ID = 'lab.preview';

export function PluginManager({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('library');
  const [labSeed, setLabSeed] = useState<string | null>(null);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal plugin-modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Effects & plugins</h2>
          <div className="seg">
            {(['library', 'install', 'lab'] as const).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'library' ? 'Library' : t === 'install' ? 'Install' : 'Shader Lab'}
              </button>
            ))}
          </div>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        {tab === 'library' && (
          <Library
            onEdit={(p) => {
              setLabSeed(p.source?.original ?? (p.passes?.length === 1 ? p.passes[0].glsl : serializePlugin(p)));
              setTab('lab');
            }}
          />
        )}
        {tab === 'install' && <Install onInstalled={() => setTab('library')} />}
        {tab === 'lab' && <ShaderLab seed={labSeed} />}
      </div>
    </div>
  );
}

function Library({ onEdit }: { onEdit: (p: EffectPlugin) => void }) {
  useEffectRegistry();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const all = effectRegistry.all().filter((r) => r.plugin.id !== LAB_ID);
  const list = all
    .filter(({ plugin: p }) => !q || `${p.name} ${p.category} ${p.author ?? ''} ${p.tags?.join(' ') ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.plugin.category.localeCompare(b.plugin.category) || a.plugin.name.localeCompare(b.plugin.name));
  const selected = sel ? effectRegistry.get(sel) : undefined;
  const counts = {
    builtin: all.filter((r) => r.plugin.builtin && r.plugin.author === 'Luscent').length,
    bundled: all.filter((r) => r.plugin.builtin && r.plugin.author !== 'Luscent').length,
    user: all.filter((r) => !r.plugin.builtin).length,
  };
  return (
    <div className="plugin-lib">
      <div>
        <input type="text" placeholder={`Search ${all.length} effects…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
        <div className="plugin-list">
          {list.map(({ plugin: p, error }) => (
            <div key={p.id} className={'item-row' + (sel === p.id ? ' active' : '')} onClick={() => setSel(p.id)} style={{ cursor: 'pointer' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{p.name}</div>
                <div className="meta">
                  {p.category} · {p.kind}
                  {p.source?.format && p.source.format !== 'luscent' ? ` · ${p.source.format}` : ''}
                  {p.wgsl && !p.passes?.length ? ' · WGSL' : ''}
                </div>
              </div>
              {error && <span className="badge warn">error</span>}
              {!p.builtin && <span className="badge">installed</span>}
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {counts.builtin} built-in · {counts.bundled} bundled (gl-transitions, ISF, Shadertoy) · {counts.user} installed
          {bundleReport.skipped.length > 0 && ` · ${bundleReport.skipped.length} bundled shaders skipped (${bundleReport.skipped.map((s) => s.name).join(', ')})`}
        </div>
      </div>
      <div className="plugin-detail">
        {!selected ? (
          <div className="hint">Select an effect to see its parameters, licence and source.</div>
        ) : (
          <>
            <h3 style={{ margin: '0 0 4px' }}>{selected.plugin.name}</h3>
            <div className="hint">
              {selected.plugin.id} · v{selected.plugin.version} · {selected.plugin.kind}
            </div>
            {selected.plugin.description && <p>{selected.plugin.description}</p>}
            <div className="field">
              <label>Author</label>
              <span>{selected.plugin.author ?? '—'}</span>
            </div>
            <div className="field">
              <label>License</label>
              <span>{selected.plugin.license ?? '—'}</span>
            </div>
            {selected.plugin.source?.url && (
              <div className="field">
                <label>Source</label>
                <a href={selected.plugin.source.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-2)' }}>
                  {selected.plugin.source.url}
                </a>
              </div>
            )}
            <div className="section-title" style={{ marginTop: 8 }}>
              Parameters
            </div>
            {selected.plugin.params.length === 0 && <div className="hint">None</div>}
            {selected.plugin.params.map((p) => (
              <div key={p.id} className="hint">
                <code>{p.id}</code> · {p.type} · default {JSON.stringify(p.default)}
              </div>
            ))}
            {selected.error && <pre className="code-error">{selected.error}</pre>}
            <div className="row wrap" style={{ marginTop: 10 }}>
              <button
                className="primary"
                onClick={() => {
                  const s = editor();
                  const id = s.selectedLayers[0] ?? activeComp(s).layers[0]?.id;
                  if (!id) return s.toast('Add a layer first.', 'info');
                  s.addEffect(id, selected.plugin.id);
                  s.toast(`Added ${selected.plugin.name}`, 'success');
                }}
              >
                Apply to selected layer
              </button>
              <button onClick={() => downloadText(`${selected.plugin.id}.luscent-effect.json`, serializePlugin(selected.plugin))}>Export (share)</button>
              <button onClick={() => onEdit(selected.plugin)}>Open in Shader Lab</button>
              {!selected.plugin.builtin && (
                <button
                  onClick={async () => {
                    await pluginStore.uninstall(selected.plugin.id);
                    setSel(null);
                  }}
                >
                  Uninstall
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReportView({ report }: { report: ConversionReport | null }) {
  if (!report) return null;
  return (
    <div className="hint" style={{ marginTop: 6 }}>
      Detected <b>{report.format}</b>.
      {report.unsupported.length > 0 && (
        <div style={{ color: '#ffb3a0' }}>Not supported (dropped): {report.unsupported.join('; ')}</div>
      )}
      {report.warnings.map((w) => (
        <div key={w}>• {w}</div>
      ))}
    </div>
  );
}

function Install({ onInstalled }: { onInstalled: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; report: ConversionReport | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const installText = async (text: string, name: string) => {
    try {
      const r = parsePluginText(text, { name });
      await pluginStore.install(r.plugin);
      setMsg({ ok: true, text: `Installed “${r.plugin.name}” (${r.plugin.id}).`, report: r.report });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message, report: null });
    }
  };
  return (
    <div>
      <p className="hint">
        Install a Luscent plugin (<code>.luscent-effect.json</code>) or a shader to convert: gl-transitions GLSL, ISF (<code>.fs</code>), Shadertoy{' '}
        <code>mainImage</code>, or Luscent <code>effect()</code> GLSL. Plugins are stored in this browser and can be exported to share.
      </p>
      <div
        className="drop-hint"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          for (const f of [...e.dataTransfer.files]) await installText(await f.text(), f.name.replace(/\.[^.]+$/, ''));
        }}
      >
        Drop plugin or shader files here, or click to choose
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".json,.fs,.frag,.glsl,.txt,.vs"
        style={{ display: 'none' }}
        onChange={async (e) => {
          for (const f of [...(e.target.files ?? [])]) await installText(await f.text(), f.name.replace(/\.[^.]+$/, ''));
          e.target.value = '';
        }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <input type="text" placeholder="https://… (raw shader or plugin JSON)" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        <button
          disabled={!url || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await pluginStore.installFromUrl(url);
              setMsg({ ok: true, text: `Installed “${r.plugin.name}”.`, report: r.report });
            } catch (err) {
              setMsg({ ok: false, text: `${(err as Error).message}${/fetch/i.test(String(err)) ? ' (the server must allow cross-origin requests)' : ''}`, report: null });
            } finally {
              setBusy(false);
            }
          }}
        >
          Install from URL
        </button>
      </div>
      {msg && (
        <div style={{ marginTop: 10, color: msg.ok ? 'var(--ok)' : 'var(--danger)' }}>
          {msg.text}
          <ReportView report={msg.report} />
          {msg.ok && (
            <div>
              <button style={{ marginTop: 6 }} onClick={onInstalled}>
                View library
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Live shader editor: convert, preview on the selected layer, install. */
function ShaderLab({ seed }: { seed: string | null }) {
  const [src, setSrc] = useState(seed ?? EXAMPLES['Luscent GLSL']);
  const [name, setName] = useState('My Effect');
  const [id, setId] = useState('user.my-effect');
  const [status, setStatus] = useState<{ ok: boolean; text: string; report: ConversionReport | null }>({ ok: true, text: '', report: null });
  const [live, setLive] = useState(true);
  useEffectRegistry();
  const compileError = effectRegistry.get(LAB_ID)?.error ?? null;
  const fmt = useMemo(() => detectFormat(src.trim().startsWith('{') ? '' : src) ?? (src.trim().startsWith('{') ? 'plugin JSON' : 'unknown'), [src]);

  const registerPreview = (): boolean => {
    try {
      const r = parsePluginText(src, { id: LAB_ID, name: `${name} (preview)` });
      effectRegistry.register({ ...r.plugin, id: LAB_ID, name: `${name} (preview)`, category: 'Shader Lab' });
      setStatus({ ok: true, text: 'Preview updated', report: r.report });
      return true;
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message, report: null });
      return false;
    }
  };

  // Hot reload: re-register the preview plugin as you type.
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(registerPreview, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, name, live]);

  const applyPreview = () => {
    if (!registerPreview()) return;
    const s = editor();
    const layerId = s.selectedLayers[0] ?? activeComp(s).layers[0]?.id;
    if (!layerId) return s.toast('Add a layer first.', 'info');
    const layer = activeComp(s).layers.find((l) => l.id === layerId);
    if (!layer?.effects?.some((e) => e.pluginId === LAB_ID)) s.addEffect(layerId, LAB_ID);
    s.toast('Preview applied — edits hot-reload live', 'success');
  };

  return (
    <div className="lab">
      <div className="row wrap" style={{ marginBottom: 6 }}>
        <span className="hint">Example:</span>
        {Object.keys(EXAMPLES).map((k) => (
          <button key={k} className="icon" onClick={() => setSrc(EXAMPLES[k])}>
            {k}
          </button>
        ))}
        <span className="grow" style={{ flex: 1 }} />
        <span className="badge">{fmt}</span>
      </div>
      <textarea className="code" value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} rows={18} />
      <div className="row wrap" style={{ marginTop: 6 }}>
        <label className="row" style={{ gap: 4 }}>
          Name <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 150 }} />
        </label>
        <label className="row" style={{ gap: 4 }}>
          Id <input type="text" value={id} onChange={(e) => setId(e.target.value)} style={{ width: 170 }} />
        </label>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Hot reload
        </label>
        <span style={{ flex: 1 }} />
        <button onClick={applyPreview}>Preview on layer</button>
        <button
          className="primary"
          onClick={async () => {
            try {
              const r = parsePluginText(src, { id, name });
              await pluginStore.install({ ...r.plugin, id, name });
              editor().toast(`Installed ${name}`, 'success');
            } catch (err) {
              setStatus({ ok: false, text: (err as Error).message, report: null });
            }
          }}
        >
          Install
        </button>
      </div>
      <div style={{ marginTop: 6, color: status.ok && !compileError ? 'var(--ok)' : 'var(--danger)' }}>
        {compileError ? 'Shader compile error:' : status.text}
      </div>
      {compileError && <pre className="code-error">{compileError}</pre>}
      <ReportView report={status.report} />
    </div>
  );
}
