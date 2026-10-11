import { useState } from 'react';
import { evaluateProp } from '../../core/animation/interpolate';
import { KEY_EPSILON } from '../../core/animation/keyframes';
import type { PropDef } from '../../core/model/properties';
import type { Color, Layer, Vec2 } from '../../core/model/types';
import { useEditor } from '../../state/store';
import { ColorField, NumberField } from './fields';

/** Value editor for one property at the current playhead. */
export function PropValue({ layer, def }: { layer: Layer; def: PropDef }) {
  const playhead = useEditor((s) => s.playhead);
  const setProp = useEditor((s) => s.setProp);
  const [linked, setLinked] = useState(true);
  const prop = layer.props[def.path];
  if (!prop) return null;
  const animated = prop.keyframes.length > 0;
  const v = evaluateProp(prop, playhead - layer.startTime);
  const label = `Change ${def.label}`;
  const decimals = 1;

  if (def.kind === 'number') {
    return (
      <NumberField
        value={v as number}
        step={def.step}
        min={def.min}
        max={def.max}
        unit={def.unit}
        decimals={decimals}
        animated={animated}
        label={label}
        onChange={(n) => setProp(layer.id, def.path, n)}
      />
    );
  }
  if (def.kind === 'vec2') {
    const [x, y] = v as Vec2;
    const isScale = def.path === 'transform.scale';
    const set = (i: 0 | 1, n: number) => {
      const next: Vec2 = [x, y];
      if (isScale && linked) {
        const ratio = i === 0 ? (x !== 0 ? n / x : 1) : y !== 0 ? n / y : 1;
        next[0] = i === 0 ? n : x * ratio;
        next[1] = i === 1 ? n : y * ratio;
      } else next[i] = n;
      setProp(layer.id, def.path, next);
    };
    return (
      <span className="row" style={{ gap: 2 }}>
        {isScale && (
          <span
            className={'switch' + (linked ? ' on' : '')}
            title="Constrain proportions"
            onClick={() => setLinked(!linked)}
            style={{ width: 14 }}
          >
            {linked ? '⛓' : '⇹'}
          </span>
        )}
        <NumberField value={x} step={def.step} min={def.min} max={def.max} decimals={decimals} animated={animated} label={label} onChange={(n) => set(0, n)} />
        <span className="unit">,</span>
        <NumberField value={y} step={def.step} min={def.min} max={def.max} unit={def.unit} decimals={decimals} animated={animated} label={label} onChange={(n) => set(1, n)} />
      </span>
    );
  }
  return <ColorField value={v as Color} label={label} onChange={(c) => setProp(layer.id, def.path, c)} />;
}

export function Stopwatch({ layer, def }: { layer: Layer; def: PropDef }) {
  const toggle = useEditor((s) => s.toggleStopwatch);
  const on = (layer.props[def.path]?.keyframes.length ?? 0) > 0;
  return (
    <span
      className={'stopwatch' + (on ? ' on' : '')}
      title={on ? 'Remove all keyframes' : 'Animate (create keyframe at playhead)'}
      onClick={(e) => {
        e.stopPropagation();
        toggle(layer.id, def.path);
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="6" cy="6.8" r="4.4" />
        <path d="M6 6.8V4.4M4.6 1h2.8" strokeLinecap="round" />
        {on && <circle cx="6" cy="6.8" r="2" fill="currentColor" stroke="none" />}
      </svg>
    </span>
  );
}

/** ◀ ◆ ▶ keyframe navigator (◆ adds/removes a keyframe at the playhead). */
export function KeyNav({ layer, def }: { layer: Layer; def: PropDef }) {
  const playhead = useEditor((s) => s.playhead);
  const fps = useEditor((s) => s.project.compositions[s.activeCompId]?.fps ?? 30);
  const { addKeyframe, setPlayhead, selectKeys, deleteSelectedKeys } = useEditor.getState();
  const prop = layer.props[def.path];
  if (!prop || prop.keyframes.length === 0) return <span className="kf-nav" style={{ width: 38 }} />;
  const lt = playhead - layer.startTime;
  const eps = Math.max(KEY_EPSILON, 0.5 / fps);
  const here = prop.keyframes.find((k) => Math.abs(k.time - lt) <= eps);
  const prev = [...prop.keyframes].reverse().find((k) => k.time < lt - eps);
  const next = prop.keyframes.find((k) => k.time > lt + eps);
  return (
    <span className="kf-nav">
      <span style={{ opacity: prev ? 1 : 0.3 }} onClick={() => prev && setPlayhead(prev.time + layer.startTime)}>
        ◀
      </span>
      <span
        className={here ? 'on' : ''}
        title={here ? 'Remove keyframe' : 'Add keyframe'}
        onClick={() => {
          if (here) {
            selectKeys([{ layerId: layer.id, path: def.path, keyId: here.id }]);
            deleteSelectedKeys();
          } else addKeyframe(layer.id, def.path);
        }}
      >
        ◆
      </span>
      <span style={{ opacity: next ? 1 : 0.3 }} onClick={() => next && setPlayhead(next.time + layer.startTime)}>
        ▶
      </span>
    </span>
  );
}
