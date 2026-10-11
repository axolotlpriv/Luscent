import { longPress } from './longPress';
import { memo } from 'react';
import { moveKeyframes } from '../../core/animation/keyframes';
import type { PropDef } from '../../core/model/properties';
import type { Keyframe, Layer } from '../../core/model/types';
import { quantize } from '../../core/time';
import { activeComp, editor, keySelId, type KeySel } from '../../state/store';
import { KeyNav, PropValue, Stopwatch } from '../components/PropEditor';
import type { MenuItem } from '../components/fields';
import { makeSnapper, startDrag } from './drag';

interface Props {
  layer: Layer;
  def: PropDef;
  pxPerSec: number;
  scrollTime: number;
  trackWidth: number;
  leftWidth: number;
  /** Selected keyframe ids on this property. */
  selectedIds: string;
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
}

function keyClass(k: Keyframe): string {
  if (k.outInterp === 'hold') return 'hold';
  if (k.inInterp === 'bezier' || k.outInterp === 'bezier') return 'bezier';
  return '';
}

export function keyMenu(): MenuItem[] {
  const s = editor();
  return [
    { label: 'Easy Ease', hint: 'F9', action: () => s.easeSelectedKeys('both') },
    { label: 'Easy Ease In', hint: '⇧F9', action: () => s.easeSelectedKeys('in') },
    { label: 'Easy Ease Out', hint: '⌘⇧F9', action: () => s.easeSelectedKeys('out') },
    { separator: true, label: '' },
    { label: 'Linear', action: () => s.setSelectedKeysInterpolation('linear') },
    { label: 'Bezier', action: () => s.setSelectedKeysInterpolation('bezier') },
    { label: 'Hold', hint: '⌘⌥H', action: () => s.setSelectedKeysInterpolation('hold') },
    { separator: true, label: '' },
    { label: 'Delete keyframes', hint: '⌫', action: () => s.deleteSelectedKeys() },
  ];
}

export const PropRow = memo(function PropRow({ layer, def, pxPerSec, scrollTime, trackWidth, leftWidth, selectedIds, onMenu }: Props) {
  const prop = layer.props[def.path];
  const selected = new Set(selectedIds ? selectedIds.split(',') : []);

  const onKeyDown = (e: React.PointerEvent, k: Keyframe) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = editor();
    const ks: KeySel = { layerId: layer.id, path: def.path, keyId: k.id };
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      s.selectKeys([ks], 'toggle');
      return;
    }
    if (!s.selectedKeys[keySelId(ks)]) s.selectKeys([ks]);
    if (!s.selectedLayers.includes(layer.id)) s.selectLayer(layer.id);
    if (layer.locked) return;
    const base = editor().project;
    const comp = activeComp(editor());
    // Group the selection per property, read from the snapshot.
    const groups = new Map<string, { layerId: string; path: string; ids: Set<string>; start: number }>();
    for (const sel of Object.values(editor().selectedKeys)) {
      const l = comp.layers.find((x) => x.id === sel.layerId);
      if (!l || l.locked || !l.props[sel.path]) continue;
      const gk = sel.layerId + '|' + sel.path;
      if (!groups.has(gk)) groups.set(gk, { layerId: l.id, path: sel.path, ids: new Set(), start: l.startTime });
      groups.get(gk)!.ids.add(sel.keyId);
    }
    const snap = makeSnapper({ excludeLayers: [] });
    const kt = layer.startTime + k.time;
    let began = false;
    startDrag(e, {
      autoScroll: true,
      move: (dx, _dy, ev) => {
        if (!began) {
          editor().beginGesture('Move Keyframes');
          began = true;
        }
        const dt = snap.time(kt + dx / pxPerSec, ev) - kt;
        const baseComp = base.compositions[comp.id];
        editor().editFrom(base, 'Move Keyframes', (d) => {
          const c = d.compositions[comp.id];
          for (const g of groups.values()) {
            const bl = baseComp.layers.find((x) => x.id === g.layerId)!;
            const dl = c.layers.find((x) => x.id === g.layerId)!;
            dl.props[g.path] = moveKeyframes(bl.props[g.path], g.ids, dt, (t) => quantize(t + g.start, comp.fps) - g.start) as never;
          }
        });
      },
      up: (moved) => {
        if (began) editor().endGesture();
        if (!moved) editor().selectKeys([ks]);
      },
    });
  };

  const pressHandlers = (keyId: string, onDown: (e: React.PointerEvent) => void) => {
    const lp = longPress((x, y) => openKeyMenu(x, y, keyId));
    return { onPointerDown: (e: React.PointerEvent) => (lp.onPointerDown(e), onDown(e)) };
  };

  const openKeyMenu = (x: number, y: number, keyId: string) => {
    const id = keySelId({ layerId: layer.id, path: def.path, keyId });
    const s = editor();
    if (!s.selectedKeys[id]) s.selectKeys([{ layerId: layer.id, path: def.path, keyId }]);
    onMenu(x, y, keyMenu());
  };

  return (
    <div className="tl-row prop">
      <div className="tl-cell-left" style={{ width: leftWidth }}>
        <Stopwatch layer={layer} def={def} />
        <span className="label" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {def.label}
        </span>
        <span className="pv">
          <PropValue layer={layer} def={def} />
        </span>
        <span className="pv">
          <KeyNav layer={layer} def={def} />
        </span>
      </div>
      <div className="tl-cell-track" data-track>
        {prop?.keyframes.map((k) => {
          const x = (layer.startTime + k.time - scrollTime) * pxPerSec;
          if (x < -10 || x > trackWidth + 10) return null;
          const id = keySelId({ layerId: layer.id, path: def.path, keyId: k.id });
          return (
            <div
              key={k.id}
              className={'kf ' + keyClass(k) + (selected.has(k.id) ? ' selected' : '')}
              style={{ left: x }}
              data-key={id}
              title={`${def.label} keyframe · ${k.inInterp}/${k.outInterp} (double-click to jump, right-click for easing)`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                editor().setPlayhead(layer.startTime + k.time);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openKeyMenu(e.clientX, e.clientY, k.id);
              }}
              {...pressHandlers(k.id, (e) => onKeyDown(e, k))}
            />
          );
        })}
      </div>
    </div>
  );
});
