import { memo, useState } from 'react';
import { LABEL_COLORS } from '../../core/model/factory';
import type { Composition, Layer, MediaItem } from '../../core/model/types';
import { moveLayers, slipLayer, trimLayer, type Edge, makeEditContext } from '../../core/timeline/ops';
import { activeComp, editor } from '../../state/store';
import { makeSnapper, startDrag } from './drag';
import { longPress } from './longPress';
import { dims, useTimelineUI } from './uiState';
import { Waveform } from './Waveform';
import type { MenuItem } from '../components/fields';

const TYPE_GLYPH: Record<Layer['type'], string> = {
  solid: '■',
  shape: '◆',
  text: 'T',
  image: '▨',
  video: '▶',
  audio: '♪',
  precomp: '❐',
  null: '□',
};

interface Props {
  layer: Layer;
  index: number;
  selected: boolean;
  expanded: boolean;
  pxPerSec: number;
  scrollTime: number;
  trackWidth: number;
  media: MediaItem | null;
  leftWidth: number;
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
}

export const LayerRow = memo(function LayerRow(p: Props) {
  const { layer, pxPerSec, scrollTime, trackWidth } = p;
  const [renaming, setRenaming] = useState(false);
  const color = LABEL_COLORS[layer.label % LABEL_COLORS.length];
  const xOf = (t: number) => (t - scrollTime) * pxPerSec;
  const barL = xOf(layer.inPoint);
  const barW = Math.max(2, (layer.outPoint - layer.inPoint) * pxPerSec);
  const hasAudio = layer.type === 'audio' || (layer.type === 'video' && !!p.media?.hasAudio);
  const bounded = (layer.type === 'video' || layer.type === 'audio') && p.media && Number.isFinite(p.media.duration);

  // ------------------------------------------------------------ selection
  const select = (e: React.PointerEvent | React.MouseEvent) => {
    const s = editor();
    if (e.shiftKey || e.metaKey || e.ctrlKey) s.selectLayer(layer.id, 'toggle');
    else if (!s.selectedLayers.includes(layer.id)) s.selectLayer(layer.id);
  };

  // ------------------------------------------------------------ bar drags
  const onBarDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    select(e);
    const s = editor();
    if (layer.locked || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const base = s.project;
    const comp = activeComp(s);
    const ids = s.selectedLayers.includes(layer.id) ? s.selectedLayers : [layer.id];
    const moving = comp.layers.filter((l) => ids.includes(l.id) && !l.locked);
    const slip = e.altKey && (layer.type === 'video' || layer.type === 'audio' || layer.type === 'precomp');
    const snap = makeSnapper({ excludeLayers: moving.map((l) => l.id) });
    const edges = moving.flatMap((l) => [l.inPoint, l.outPoint]);
    const ctx = makeEditContext(base, comp);
    let began = false;
    startDrag(e, {
      move: (dx, _dy, ev) => {
        if (!began) {
          editor().beginGesture(slip ? 'Slip Layer' : 'Move Layers');
          began = true;
        }
        const raw = dx / pxPerSec;
        if (slip) {
          const dt = Math.round(raw * comp.fps) / comp.fps;
          editor().editFrom(base, 'Slip Layer', (d) => slipLayer(d.compositions[comp.id] as Composition, layer.id, dt, ctx));
          return;
        }
        const dt = snap.delta(raw, edges, ev);
        editor().editFrom(base, 'Move Layers', (d) => moveLayers(d.compositions[comp.id] as Composition, moving.map((l) => l.id), dt));
      },
      up: (moved) => {
        if (began) editor().endGesture();
        else if (!moved) editor().selectLayer(layer.id);
      },
    });
  };

  const onHandleDown = (e: React.PointerEvent, edge: Edge) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    select(e);
    if (layer.locked) return;
    const s = editor();
    const base = s.project;
    const comp = activeComp(s);
    const ctx = makeEditContext(base, comp);
    const snap = makeSnapper({ excludeLayers: [layer.id] });
    const startT = edge === 'in' ? layer.inPoint : layer.outPoint;
    let began = false;
    startDrag(e, {
      move: (dx, _dy, ev) => {
        if (!began) {
          editor().beginGesture('Trim Layer');
          began = true;
        }
        const ripple = editor().ripple !== ev.altKey;
        const t = snap.time(startT + dx / pxPerSec, ev);
        editor().editFrom(base, ripple ? 'Ripple Trim' : 'Trim Layer', (d) => trimLayer(d.compositions[comp.id] as Composition, layer.id, edge, t, ctx, { ripple }));
      },
      up: () => {
        if (began) editor().endGesture();
      },
    });
  };

  // ------------------------------------------------------------ reorder via left cell
  const onLeftDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.switch,.twirl,input')) return;
    select(e);
    const s = editor();
    const ids = s.selectedLayers.includes(layer.id) ? s.selectedLayers : [layer.id];
    startDrag(e, {
      threshold: 5,
      move: (_dx, _dy, ev) => {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-layer-index]')];
        let idx = rows.length;
        for (const r of rows) {
          const rect = r.getBoundingClientRect();
          if (ev.clientY < rect.top + rect.height / 2) {
            idx = Number(r.dataset.layerIndex);
            break;
          }
        }
        useTimelineUI.setState({ dropIndex: idx });
      },
      up: (moved) => {
        const idx = useTimelineUI.getState().dropIndex;
        useTimelineUI.setState({ dropIndex: null });
        if (moved && idx !== null) editor().reorderLayers(ids, idx);
      },
    });
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const s = editor();
    if (!s.selectedLayers.includes(layer.id)) s.selectLayer(layer.id);
    const items: MenuItem[] = [
      { label: 'Split at playhead', hint: '⌘⇧D', action: () => editor().splitAtPlayhead() },
      { label: 'Duplicate', hint: '⌘D', action: () => editor().duplicateSelected() },
      { label: 'Trim in to playhead', hint: '⌥[', action: () => editor().trimSelectedToPlayhead('in') },
      { label: 'Trim out to playhead', hint: '⌥]', action: () => editor().trimSelectedToPlayhead('out') },
      { label: 'Sequence layers', action: () => editor().sequenceSelected() },
      { label: 'Pre-compose', hint: '⌘⇧C', action: () => editor().precomposeSelected() },
      ...(layer.type === 'precomp' ? [{ label: 'Open composition', action: () => editor().openComp(layer.compId, { fromLayer: layer.id }) }] : []),
      { separator: true, label: '' },
      { label: layer.visible ? 'Hide' : 'Show', action: () => toggle('visible') },
      ...(hasAudio || layer.type === 'precomp' ? [{ label: layer.audible ? 'Mute' : 'Unmute', action: () => toggle('audible') }] : []),
      { label: layer.solo ? 'Unsolo' : 'Solo', action: () => toggle('solo') },
      { label: layer.locked ? 'Unlock' : 'Lock', action: () => toggle('locked') },
      { label: 'Move up', action: () => editor().reorderLayers([layer.id], Math.max(0, p.index - 1)) },
      { label: 'Move down', action: () => editor().reorderLayers([layer.id], p.index + 2) },
      { separator: true, label: '' },
      { label: 'Delete', hint: '⌫', action: () => editor().deleteSelected(false) },
      { label: 'Ripple delete', hint: '⇧⌫', action: () => editor().deleteSelected(true) },
    ];
    p.onMenu(e.clientX, e.clientY, items);
  };

  // Collapsed-bar keyframe ticks.
  const ticks: number[] = [];
  if (!p.expanded) {
    for (const prop of Object.values(layer.props)) for (const k of prop.keyframes) ticks.push(layer.startTime + k.time);
  }
  const nameOffset = Math.max(0, -barL);
  const toggle = (key: 'visible' | 'audible' | 'solo' | 'locked') => editor().updateLayer(layer.id, { [key]: !layer[key] } as Partial<Layer>);

  return (
    <div
      className={'tl-row layer' + (p.selected ? ' selected' : '')}
      data-layer-index={p.index}
      onContextMenu={onContext}
      {...longPress((x, y) => onContext({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} } as React.MouseEvent))}
    >
      <div className="tl-cell-left" style={{ width: p.leftWidth }} onPointerDown={onLeftDown} onDoubleClick={() => layer.type === 'precomp' && editor().openComp(layer.compId, { fromLayer: layer.id })}>
        <span className={'twirl' + (p.expanded ? ' open' : '')} onClick={() => editor().toggleExpanded(layer.id)}>
          ▸
        </span>
        <span className="label-chip" style={{ background: color }} />
        <span className="layer-index">{p.index + 1}</span>
        <span className="hint" style={{ width: 12, textAlign: 'center' }}>
          {TYPE_GLYPH[layer.type]}
        </span>
        <span className="layer-name" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(true))} title={layer.name}>
          {renaming ? (
            <input
              type="text"
              defaultValue={layer.name}
              autoFocus
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={(e) => {
                setRenaming(false);
                const v = e.target.value.trim();
                if (v && v !== layer.name) editor().updateLayer(layer.id, { name: v });
              }}
            />
          ) : (
            layer.name
          )}
        </span>
        {layer.type !== 'audio' ? (
          <span className={'switch eye' + (layer.visible ? ' on' : '')} title="Video (eye)" onClick={() => toggle('visible')}>
            {layer.visible ? '◉' : '○'}
          </span>
        ) : (
          <span className="switch" />
        )}
        {hasAudio || layer.type === 'precomp' ? (
          <span className={'switch' + (layer.audible ? ' on' : '')} title="Audio" onClick={() => toggle('audible')}>
            {layer.audible ? '🔊' : '🔈'}
          </span>
        ) : (
          <span className="switch" />
        )}
        <span className={'switch solo' + (layer.solo ? ' on' : '')} title="Solo" onClick={() => toggle('solo')}>
          S
        </span>
        <span className={'switch lock' + (layer.locked ? ' on' : '')} title="Lock" onClick={() => toggle('locked')}>
          {layer.locked ? '🔒' : '🔓'}
        </span>
      </div>
      <div className="tl-cell-track">
        {bounded && (
          <div
            className="ghost-extent"
            style={{ left: xOf(layer.startTime), width: (p.media!.duration as number) * pxPerSec }}
          />
        )}
        <div
          className={'bar' + (p.selected ? ' selected' : '') + (layer.locked ? ' locked' : '')}
          style={{
            left: barL,
            width: barW,
            background: layer.type === 'audio' ? `color-mix(in srgb, ${color} 45%, #15171d)` : color,
            opacity: layer.visible || layer.type === 'audio' ? 1 : 0.45,
          }}
          onPointerDown={onBarDown}
          title={layer.type === 'video' || layer.type === 'audio' ? 'Drag to move · Alt+drag to slip · drag edges to trim (Alt = ripple)' : 'Drag to move · drag edges to trim (Alt = ripple)'}
        >
          {hasAudio && p.media && (
            <Waveform
              mediaId={p.media.id}
              sourceStart={layer.inPoint - layer.startTime}
              width={barW}
              height={dims.layerH - 8}
              pxPerSec={pxPerSec}
              visibleFrom={-barL}
              visibleTo={trackWidth - barL}
              color={layer.type === 'audio' ? color : 'rgba(0,0,0,0.35)'}
            />
          )}
          <span className="bar-name" style={{ marginLeft: nameOffset, color: layer.type === 'audio' ? '#fff' : undefined }}>
            {layer.name}
          </span>
          {ticks.map((t, i) => (
            <span key={i} className="kf-tick" style={{ left: (t - layer.inPoint) * pxPerSec }} />
          ))}
          <div className="handle in" onPointerDown={(e) => onHandleDown(e, 'in')} />
          <div className="handle out" onPointerDown={(e) => onHandleDown(e, 'out')} />
        </div>
      </div>
    </div>
  );
});
