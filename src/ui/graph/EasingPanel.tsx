import { useEffect, useRef, useState } from 'react';
import { cubicBezierAt } from '../../core/animation/bezier';
import { EASINGS, EASING_FAMILIES, easingById, type Bezier, type EaseDirection, type EasingDef } from '../../core/animation/easings';
import { segmentCurve } from '../../core/animation/interpolate';
import { activeComp, editor, useEditor } from '../../state/store';
import { useCurveLibrary, type SavedCurve } from '../../state/curveLibrary';
import { NumberField } from '../components/fields';
import { downloadText } from '../download';

/** Tiny SVG plot of a normalised curve. */
export function CurvePreview({ fn, size = 34 }: { fn: (x: number) => number; size?: number }) {
  const pts: string[] = [];
  let lo = 0;
  let hi = 1;
  const ys: number[] = [];
  for (let i = 0; i <= 32; i++) {
    const y = fn(i / 32);
    ys.push(y);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  const pad = 3;
  ys.forEach((y, i) => {
    const px = pad + (i / 32) * (size - 2 * pad);
    const py = size - pad - ((y - lo) / (hi - lo)) * (size - 2 * pad);
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  });
  return (
    <svg width={size} height={size} className="curve-preview">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

const fnOf = (e: EasingDef) => (e.kind === 'fn' ? e.fn : (x: number) => cubicBezierAt(...e.bezier, x));
const fnOfSaved = (c: SavedCurve) => {
  if (c.bezier) return (x: number) => cubicBezierAt(...c.bezier!, x);
  const e = c.easing ? easingById(c.easing) : undefined;
  return e ? fnOf(e) : (x: number) => x;
};

export function EasingPanel() {
  const [dir, setDir] = useState<EaseDirection>('out');
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const comp = useEditor(activeComp);
  const lib = useCurveLibrary();
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!lib.loaded) void lib.load();
  }, [lib]);
  const s = useEditor.getState();
  const sel = Object.values(selectedKeys);

  // The first selected key with a following key defines "the selected curve".
  let segment: { curve: ReturnType<typeof segmentCurve>; hasFn: boolean } | null = null;
  let single: { layerId: string; path: string; key: import('../../core/model/types').Keyframe; hasPrev: boolean; hasNext: boolean } | null = null;
  for (const k of sel) {
    const l = comp.layers.find((x) => x.id === k.layerId);
    const keys = l?.props[k.path]?.keyframes;
    if (!keys) continue;
    const i = keys.findIndex((x) => x.id === k.keyId);
    if (i < 0) continue;
    if (!single && sel.length === 1) single = { layerId: k.layerId, path: k.path, key: keys[i], hasPrev: i > 0, hasNext: i < keys.length - 1 };
    if (!segment && i < keys.length - 1) segment = { curve: segmentCurve(keys[i], keys[i + 1]), hasFn: !!keys[i].outCurve };
  }

  const families = EASING_FAMILIES.filter((f) => !['linear', 'ease', 'snap', 'punch', 'whip'].includes(f));
  const specials = EASINGS.filter((e) => ['linear', 'ease', 'snap', 'punch', 'whip'].includes(e.family));

  const saveCurve = () => {
    if (!segment) return editor().toast('Select a keyframe that starts a segment to save its curve.', 'info');
    const name = window.prompt('Curve name', 'My curve');
    if (!name) return;
    const c = segment.curve;
    if (c.hold) return editor().toast('Hold segments have no curve to save.', 'info');
    const firstKey = sel[0];
    const l = comp.layers.find((x) => x.id === firstKey.layerId);
    const k = l?.props[firstKey.path]?.keyframes.find((x) => x.id === firstKey.keyId);
    if (c.fn && k?.outCurve) lib.add({ name, easing: k.outCurve });
    else lib.add({ name, bezier: (c.bezier ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3]) as Bezier });
    editor().toast(`Saved “${name}” to your curve library`, 'success');
  };

  return (
    <div className="section">
      <div className="section-title">
        Easing <span className="grow" />
        <div className="seg">
          {(['in', 'out', 'inOut'] as const).map((d) => (
            <button key={d} className={'icon' + (dir === d ? ' on' : '')} onClick={() => setDir(d)}>
              {d === 'inOut' ? 'In-Out' : d === 'in' ? 'In' : 'Out'}
            </button>
          ))}
        </div>
      </div>
      <div className="ease-grid">
        {families.map((f) => {
          const e = easingById(`${f}-${dir}`);
          if (!e) return null;
          return (
            <button key={f} className="ease-btn" title={`${e.label} — applies to the segment after each selected keyframe`} onClick={() => s.applyEasingToSelected(e.id)}>
              <CurvePreview fn={fnOf(e)} />
              <span>{f}</span>
            </button>
          );
        })}
      </div>
      <div className="ease-grid" style={{ marginTop: 4 }}>
        {specials.map((e) => (
          <button key={e.id} className="ease-btn" title={e.label} onClick={() => s.applyEasingToSelected(e.id)}>
            <CurvePreview fn={fnOf(e)} />
            <span>{e.label.replace('Easy Ease', 'Ease')}</span>
          </button>
        ))}
        <button className="ease-btn" title="Hold (⌘⌥H)" onClick={() => s.setSelectedKeysInterpolation('hold')}>
          <CurvePreview fn={(x) => (x < 1 ? 0 : 1)} />
          <span>Hold</span>
        </button>
      </div>

      {single && (
        <div style={{ marginTop: 8 }}>
          <div className="section-title">Keyframe velocity</div>
          {single.hasPrev && (
            <div className="prop-line">
              <span className="label">Incoming</span>
              <NumberField value={single.key.inEase.speed} step={1} decimals={1} unit="/s" label="Edit Ease" onChange={(v) => s.setKeyEase(single!.layerId, single!.path, single!.key.id, 'in', { speed: v })} />
              <NumberField
                value={single.key.inEase.influence * 100}
                step={0.5}
                min={1}
                max={100}
                decimals={1}
                unit="%"
                label="Edit Ease"
                onChange={(v) => s.setKeyEase(single!.layerId, single!.path, single!.key.id, 'in', { influence: v / 100 })}
              />
            </div>
          )}
          {single.hasNext && (
            <div className="prop-line">
              <span className="label">Outgoing</span>
              <NumberField value={single.key.outEase.speed} step={1} decimals={1} unit="/s" label="Edit Ease" onChange={(v) => s.setKeyEase(single!.layerId, single!.path, single!.key.id, 'out', { speed: v })} />
              <NumberField
                value={single.key.outEase.influence * 100}
                step={0.5}
                min={1}
                max={100}
                decimals={1}
                unit="%"
                label="Edit Ease"
                onChange={(v) => s.setKeyEase(single!.layerId, single!.path, single!.key.id, 'out', { influence: v / 100 })}
              />
            </div>
          )}
        </div>
      )}
      {segment?.hasFn && (
        <button style={{ marginTop: 6 }} onClick={() => s.bakeSelectedKeys()} title="Replace elastic / bounce curves with one keyframe per frame">
          Bake curve to keyframes
        </button>
      )}

      <div className="section-title" style={{ marginTop: 10 }}>
        Curve library <span className="grow" />
        <button className="icon ghost" title="Save the selected segment's curve" onClick={saveCurve}>
          ＋ Save
        </button>
        <button className="icon ghost" title="Export library (JSON)" onClick={() => downloadText('luscent-curves.json', lib.exportJSON())}>
          ⇩
        </button>
        <button className="icon ghost" title="Import library (JSON)" onClick={() => importRef.current?.click()}>
          ⇧
        </button>
      </div>
      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            const n = lib.importJSON(await f.text());
            editor().toast(`Imported ${n} curve${n === 1 ? '' : 's'}`, 'success');
          } catch (err) {
            editor().toast((err as Error).message, 'error');
          }
        }}
      />
      {lib.curves.length === 0 ? (
        <div className="hint">Shape a curve in the graph editor, select its first keyframe and press Save to reuse it anywhere.</div>
      ) : (
        <div className="ease-grid">
          {lib.curves.map((c) => (
            <button
              key={c.id}
              className="ease-btn"
              title={`${c.name} — click to apply, right-click to delete`}
              onClick={() => s.applyEasingToSelected(c.bezier ?? c.easing!)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (window.confirm(`Delete “${c.name}” from your library?`)) lib.remove(c.id);
              }}
              onDoubleClick={() => {
                const n = window.prompt('Rename curve', c.name);
                if (n) lib.rename(c.id, n);
              }}
            >
              <CurvePreview fn={fnOfSaved(c)} />
              <span>{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
