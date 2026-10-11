import { LABEL_COLORS } from '../../core/model/factory';
import { uid } from '../../core/model/ids';
import { propDefsFor } from '../../core/model/properties';
import type { BlendMode, Color, Layer, TextLayer } from '../../core/model/types';
import { formatTimecode, parseTimecode } from '../../core/time';
import { activeComp, editor, useEditor } from '../../state/store';
import { ColorField, NumberField } from '../components/fields';
import { KeyNav, PropValue, Stopwatch } from '../components/PropEditor';

const BLEND_MODES: BlendMode[] = ['normal', 'add', 'screen', 'multiply', 'lighten'];
const FONTS = [
  'Inter, system-ui, sans-serif',
  'Impact, Haettenschweiler, sans-serif',
  'Arial Black, Arial, sans-serif',
  'Georgia, serif',
  '"Courier New", monospace',
  'system-ui, sans-serif',
];

export function Inspector() {
  const comp = useEditor(activeComp);
  const selectedRaw = useEditor((s) => s.selectedLayers);
  const selected = selectedRaw.filter((id) => comp.layers.some((l) => l.id === id));
  const keyCount = useEditor((s) => Object.keys(s.selectedKeys).length);
  const layer = selected.length === 1 ? comp.layers.find((l) => l.id === selected[0]) : undefined;

  return (
    <div className="panel">
      <div className="panel-head">
        {layer ? 'Layer' : selected.length > 1 ? `${selected.length} layers` : 'Composition'}
        <span className="grow" />
        {keyCount > 0 && <span className="badge">{keyCount} key{keyCount > 1 ? 's' : ''}</span>}
      </div>
      <div className="panel-body">
        {keyCount > 0 && <KeyframeTools />}
        {layer ? <LayerInspector layer={layer} /> : <CompInspector />}
      </div>
    </div>
  );
}

function KeyframeTools() {
  const s = useEditor.getState();
  return (
    <div className="section">
      <div className="section-title">Keyframe interpolation</div>
      <div className="row wrap">
        <button onClick={() => s.easeSelectedKeys('both')} title="F9">
          Easy Ease
        </button>
        <button onClick={() => s.easeSelectedKeys('in')}>Ease In</button>
        <button onClick={() => s.easeSelectedKeys('out')}>Ease Out</button>
        <button onClick={() => s.setSelectedKeysInterpolation('linear')}>Linear</button>
        <button onClick={() => s.setSelectedKeysInterpolation('hold')}>Hold</button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        Curve editing with bezier handles and easing presets arrives with the graph editor (phase 2).
      </div>
    </div>
  );
}

function LayerInspector({ layer }: { layer: Layer }) {
  const comp = useEditor(activeComp);
  const s = useEditor.getState();
  const defs = propDefsFor(layer.type);
  const parents = comp.layers.filter((l) => l.id !== layer.id && l.type !== 'audio');
  const timeField = (label: string, value: number, onSet: (t: number) => void) => (
    <div className="field">
      <label>{label}</label>
      <input
        type="text"
        key={value}
        defaultValue={formatTimecode(value, comp.fps)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          const t = parseTimecode(e.target.value, comp.fps);
          if (t !== null && Math.abs(t - value) > 1e-6) onSet(t);
          else e.target.value = formatTimecode(value, comp.fps);
        }}
      />
    </div>
  );

  return (
    <>
      <div className="section">
        <div className="field">
          <label>Name</label>
          <input
            type="text"
            key={layer.id + layer.name}
            defaultValue={layer.name}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => e.target.value.trim() && e.target.value !== layer.name && s.updateLayer(layer.id, { name: e.target.value.trim() })}
          />
        </div>
        <div className="field">
          <label>Label</label>
          <div className="row" style={{ gap: 3 }}>
            {LABEL_COLORS.map((c, i) => (
              <span
                key={c}
                onClick={() => s.updateLayer(layer.id, { label: i })}
                style={{ width: 14, height: 14, borderRadius: 3, background: c, cursor: 'pointer', outline: layer.label === i ? '2px solid #fff' : 'none' }}
              />
            ))}
          </div>
        </div>
        {layer.type !== 'audio' && (
          <>
            <div className="field">
              <label>Blend mode</label>
              <select value={layer.blendMode} onChange={(e) => s.updateLayer(layer.id, { blendMode: e.target.value as BlendMode })}>
                {BLEND_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m[0].toUpperCase() + m.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Parent</label>
              <select value={layer.parentId ?? ''} onChange={(e) => s.setParent(layer.id, e.target.value || null)}>
                <option value="">None</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {comp.layers.indexOf(p) + 1}. {p.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        {timeField('In', layer.inPoint, (t) => s.trimLayer(layer.id, 'in', t))}
        {timeField('Out', layer.outPoint, (t) => s.trimLayer(layer.id, 'out', t))}
        <div className="field">
          <label>Duration</label>
          <span className="hint">{formatTimecode(layer.outPoint - layer.inPoint, comp.fps)}</span>
        </div>
      </div>

      {layer.type === 'text' && <TextSettings layer={layer} />}
      {layer.type === 'shape' && (
        <div className="section">
          <div className="section-title">Shape</div>
          <div className="row">
            {(['rect', 'ellipse'] as const).map((k) => (
              <button key={k} className={layer.shape === k ? 'on' : ''} onClick={() => s.updateLayer(layer.id, { shape: k } as Partial<Layer>)}>
                {k === 'rect' ? 'Rectangle' : 'Ellipse'}
              </button>
            ))}
          </div>
        </div>
      )}
      {layer.type === 'solid' && (
        <div className="section">
          <div className="section-title">Solid size</div>
          <div className="row">
            <NumberField value={layer.width} step={1} min={1} decimals={0} unit="px" onChange={(v) => s.updateLayer(layer.id, { width: Math.round(v) } as Partial<Layer>)} />
            ×
            <NumberField value={layer.height} step={1} min={1} decimals={0} unit="px" onChange={(v) => s.updateLayer(layer.id, { height: Math.round(v) } as Partial<Layer>)} />
            <button className="ghost" onClick={() => s.updateLayer(layer.id, { width: comp.width, height: comp.height } as Partial<Layer>)}>
              Comp size
            </button>
          </div>
        </div>
      )}
      {layer.type === 'precomp' && (
        <div className="section">
          <button onClick={() => s.openComp(layer.compId, { fromLayer: layer.id })}>Open “{layer.name}”</button>
        </div>
      )}

      {defs.length > 0 && (
        <div className="section">
          <div className="section-title">Properties</div>
          {defs.map((def) => (
            <div key={def.path} className="prop-line">
              <Stopwatch layer={layer} def={def} />
              <span className="label">{def.label}</span>
              <PropValue layer={layer} def={def} />
              <KeyNav layer={layer} def={def} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const autoName = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 24);

function TextSettings({ layer }: { layer: TextLayer }) {
  const s = useEditor.getState();
  return (
    <div className="section">
      <div className="section-title">Text</div>
      <textarea
        key={layer.id}
        rows={3}
        defaultValue={layer.text}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          // Live typing: coalesce into one undo step per focus session. Layers
          // still carrying an auto-generated name follow their text (AE style).
          const text = e.target.value;
          const autoNamed = layer.name === autoName(layer.text) || layer.name === 'Your text';
          s.updateLayer(layer.id, (autoNamed && text.trim() ? { text, name: autoName(text) } : { text }) as Partial<Layer>);
        }}
        onFocus={() => s.beginGesture('Edit Text')}
        onBlur={() => s.endGesture()}
        style={{ marginBottom: 6 }}
      />
      <div className="field">
        <label>Font</label>
        <select value={layer.fontFamily} onChange={(e) => s.updateLayer(layer.id, { fontFamily: e.target.value } as Partial<Layer>)}>
          {(FONTS.includes(layer.fontFamily) ? FONTS : [layer.fontFamily, ...FONTS]).map((f) => (
            <option key={f} value={f}>
              {f.split(',')[0].replace(/"/g, '')}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Weight</label>
        <select value={layer.fontWeight} onChange={(e) => s.updateLayer(layer.id, { fontWeight: Number(e.target.value) } as Partial<Layer>)}>
          {[300, 400, 500, 600, 700, 800, 900].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Align</label>
        <div className="row" style={{ gap: 3 }}>
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} className={'icon' + (layer.align === a ? ' on' : '')} onClick={() => s.updateLayer(layer.id, { align: a } as Partial<Layer>)}>
              {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
            </button>
          ))}
          <button className={'icon' + (layer.italic ? ' on' : '')} onClick={() => s.updateLayer(layer.id, { italic: !layer.italic } as Partial<Layer>)}>
            <i>I</i>
          </button>
        </div>
      </div>
    </div>
  );
}

function CompInspector() {
  const comp = useEditor(activeComp);
  const project = useEditor((s) => s.project);
  const s = useEditor.getState();
  const tracks = comp.layers
    .filter((l) => l.type === 'audio' || l.type === 'video')
    .map((l) => ('mediaId' in l ? project.media[l.mediaId] : undefined))
    .filter((m, i, arr) => !!m?.analysis?.bpm && arr.indexOf(m) === i);
  return (
    <>
      <div className="section">
        <div className="field">
          <label>Name</label>
          <input
            type="text"
            key={comp.id + comp.name}
            defaultValue={comp.name}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => e.target.value.trim() && s.updateComp({ name: e.target.value.trim() })}
          />
        </div>
        <div className="field">
          <label>Size</label>
          <div className="row">
            <NumberField value={comp.width} step={2} min={16} decimals={0} onChange={(v) => s.updateComp({ width: v })} />×
            <NumberField value={comp.height} step={2} min={16} decimals={0} unit="px" onChange={(v) => s.updateComp({ height: v })} />
          </div>
        </div>
        <div className="field">
          <label>Frame rate</label>
          <select value={comp.fps} onChange={(e) => s.updateComp({ fps: Number(e.target.value) })}>
            {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Duration</label>
          <input
            type="text"
            key={comp.duration}
            defaultValue={formatTimecode(comp.duration, comp.fps)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => {
              const t = parseTimecode(e.target.value, comp.fps);
              if (t && t > 0) s.updateComp({ duration: t });
            }}
          />
        </div>
        <div className="field">
          <label>Background</label>
          <ColorField value={comp.background} onChange={(c: Color) => s.updateComp({ background: c })} label="Background Color" />
        </div>
      </div>
      <div className="section">
        <div className="section-title">Beat grid</div>
        {tracks.length === 0 ? (
          <div className="hint">Add a music track to this composition — Luscent detects its tempo, beats and transients so cuts, keyframes and markers snap on the beat.</div>
        ) : (
          tracks.map((m) => (
            <div key={m!.id} className="prop-line">
              <span className="label">{m!.name}</span>
              <span className="badge beat">{m!.analysis!.bpm} BPM</span>
              <span className="hint" title="Beats tracked · transients detected · how steady the pulse is">
                {m!.analysis!.beats.length} beats · {m!.analysis!.onsets.length} hits · {Math.round(m!.analysis!.confidence * 100)}%
              </span>
            </div>
          ))
        )}
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={() => markBeats(4)} disabled={tracks.length === 0} title="Drop a marker on every bar (4 beats)">
            Markers every bar
          </button>
          <button onClick={() => markBeats(1)} disabled={tracks.length === 0} title="Drop a marker on every beat">
            every beat
          </button>
        </div>
      </div>
    </>
  );
}

function markBeats(every: number) {
  const s = editor();
  const comp = activeComp(s);
  const times: number[] = [];
  for (const l of comp.layers) {
    if (l.type !== 'audio' && l.type !== 'video') continue;
    const a = s.project.media[l.mediaId]?.analysis;
    if (!a) continue;
    a.beats.forEach((b, i) => {
      const t = l.startTime + b;
      if (i % every === 0 && t >= l.inPoint && t < l.outPoint && t < comp.duration) times.push(t);
    });
    break;
  }
  s.edit('Beat Markers', (p) => {
    const c = p.compositions[comp.id];
    for (const t of times) {
      const q = Math.round(t * c.fps) / c.fps;
      if (!c.markers.some((m) => Math.abs(m.time - q) < 0.5 / c.fps)) c.markers.push({ id: uid('mk_'), time: q, duration: 0, label: '', color: 0 });
    }
    c.markers.sort((a, b) => a.time - b.time);
  });
}
