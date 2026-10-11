import { useMemo, useState, useSyncExternalStore } from 'react';
import { effectRegistry, fxPath } from '../../core/effects/registry';
import { pluginParams, type EffectPlugin } from '../../core/effects/types';
import { propDefsFor } from '../../core/model/properties';
import type { Layer } from '../../core/model/types';
import { useEditor } from '../../state/store';
import { KeyNav, PropValue, Stopwatch } from '../components/PropEditor';

export function useEffectRegistry(): number {
  return useSyncExternalStore(
    (fn) => effectRegistry.subscribe(fn),
    () => effectRegistry.version,
  );
}

/** Searchable effect / transition picker. */
export function EffectBrowser({ onPick, onClose }: { onPick: (p: EffectPlugin) => void; onClose: () => void }) {
  useEffectRegistry();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, EffectPlugin[]>();
    const needle = q.trim().toLowerCase();
    for (const { plugin } of effectRegistry.all()) {
      const hay = `${plugin.name} ${plugin.category} ${plugin.tags?.join(' ') ?? ''} ${plugin.description ?? ''}`.toLowerCase();
      if (needle && !hay.includes(needle)) continue;
      const cat = plugin.kind === 'transition' ? (plugin.builtin ? 'Transitions' : `Transitions · ${plugin.category}`) : plugin.category;
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat)!.push(plugin);
    }
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, effectRegistry.version]);
  return (
    <div className="effect-browser" onPointerDown={(e) => e.stopPropagation()}>
      <input
        type="text"
        autoFocus
        placeholder="Search effects & transitions…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && groups[0]?.[1][0]) onPick(groups[0][1][0]);
        }}
      />
      <div className="effect-browser-list">
        {groups.map(([cat, list]) => (
          <div key={cat}>
            <div className="section-title" style={{ margin: '8px 0 3px' }}>
              {cat}
            </div>
            {list.map((p) => (
              <div key={p.id} className="menu-item" title={p.description ?? p.name} onClick={() => onPick(p)}>
                <span>{p.name}</span>
                <span className="k">{p.builtin ? '' : p.source?.format ?? 'plugin'}</span>
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div className="hint">No effects match.</div>}
      </div>
    </div>
  );
}

export function EffectStack({ layer }: { layer: Layer }) {
  useEffectRegistry();
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const s = useEditor.getState();
  const effects = layer.effects ?? [];
  const defs = propDefsFor(layer.type, layer);
  return (
    <div className="section">
      <div className="section-title">
        Effects{layer.adjustment ? ' · adjustment' : ''}
        <span className="grow" />
        <button className="icon ghost" onClick={() => setAdding(!adding)} title="Add an effect or transition">
          ＋ Add
        </button>
      </div>
      {adding && (
        <EffectBrowser
          onClose={() => setAdding(false)}
          onPick={(p) => {
            s.addEffect(layer.id, p.id);
            setAdding(false);
          }}
        />
      )}
      {effects.length === 0 && !adding && <div className="hint">No effects. Add glow, shake, blurs, transitions and installed plugins.</div>}
      {effects.map((inst, i) => {
        const reg = effectRegistry.get(inst.pluginId);
        const plugin = reg?.plugin;
        const open = !collapsed[inst.id];
        return (
          <div key={inst.id} className={'effect-card' + (inst.enabled ? '' : ' disabled')}>
            <div className="effect-head">
              <span className={'twirl' + (open ? ' open' : '')} onClick={() => setCollapsed({ ...collapsed, [inst.id]: open })}>
                ▸
              </span>
              <input type="checkbox" checked={inst.enabled} onChange={() => s.toggleEffect(layer.id, inst.id)} title="Enable" />
              <span className="effect-name" title={plugin?.description}>
                {plugin?.name ?? inst.pluginId}
                {plugin?.kind === 'transition' && <span className="badge" style={{ marginLeft: 6 }}>transition</span>}
              </span>
              {reg?.error && (
                <span className="badge warn" title={reg.error}>
                  error
                </span>
              )}
              {!plugin && (
                <span className="badge warn" title="This plugin is not installed">
                  missing
                </span>
              )}
              <button className="icon ghost" title="Move up" disabled={i === 0} onClick={() => s.moveEffect(layer.id, inst.id, -1)}>
                ↑
              </button>
              <button className="icon ghost" title="Move down" disabled={i === effects.length - 1} onClick={() => s.moveEffect(layer.id, inst.id, 1)}>
                ↓
              </button>
              <button className="icon ghost" title="Duplicate" onClick={() => s.duplicateEffect(layer.id, inst.id)}>
                ⧉
              </button>
              <button className="icon ghost" title="Reset parameters" onClick={() => s.resetEffect(layer.id, inst.id)}>
                ↺
              </button>
              <button className="icon ghost" title="Remove" onClick={() => s.removeEffect(layer.id, inst.id)}>
                ✕
              </button>
            </div>
            {open && plugin && (
              <div className="effect-params">
                {pluginParams(plugin).map((spec) => {
                  const def = defs.find((d) => d.path === fxPath(inst.id, spec.id));
                  if (!def) return null;
                  return (
                    <div key={spec.id} className="prop-line" title={spec.hint}>
                      <Stopwatch layer={layer} def={def} />
                      <span className="label">{spec.label ?? spec.id}</span>
                      <PropValue layer={layer} def={def} />
                      <KeyNav layer={layer} def={def} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
