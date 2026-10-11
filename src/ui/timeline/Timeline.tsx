import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { applyPresetWithToast, findPreset, PRESET_DRAG_TYPE } from '../presets/applyPreset';
import { propDefsFor, type PropDef } from '../../core/model/properties';
import type { Layer } from '../../core/model/types';
import { compBeatTimes } from '../../core/timeline/snap';
import { formatTimecode, parseTimecode } from '../../core/time';
import { activeComp, editor, useEditor } from '../../state/store';
import { ContextMenu, type MenuItem } from '../components/fields';
import { LayerRow } from './LayerRow';
import { PropRow } from './PropRow';
import { Ruler, tickStep } from './Ruler';
import { makeSnapper, startDrag } from './drag';
import { dims, useLayout, useTimelineUI } from './uiState';
import { haptic } from '../haptics';
import { scrubAudio } from '../../engine/playback/Transport';
import { GraphEditor } from '../graph/GraphEditor';
import { useEffectRegistry } from '../panels/EffectStack';

type Row = { kind: 'layer'; layer: Layer; index: number } | { kind: 'prop'; layer: Layer; def: PropDef };

export function Timeline() {
  const comp = useEditor(activeComp);
  const project = useEditor((s) => s.project);
  const compStack = useEditor((s) => s.compStack);
  const selectedLayers = useEditor((s) => s.selectedLayers);
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const expanded = useEditor((s) => s.expanded);
  const reveal = useEditor((s) => s.reveal);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const scrollTime = useEditor((s) => s.scrollTime);
  const trackWidth = useTimelineUI((s) => s.trackWidth);
  const dropIndex = useTimelineUI((s) => s.dropIndex);
  const graphMode = useEditor((s) => s.graphMode);
  const compact = useLayout((s) => s.compact);
  const fxVersion = useEffectRegistry();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [viewportH, setViewportH] = useState(200);
  const onMenu = useCallback((x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items }), []);

  // ---------------------------------------------------------------- rows
  const rows = useMemo(() => {
    const out: Row[] = [];
    comp.layers.forEach((layer, index) => {
      out.push({ kind: 'layer', layer, index });
      const defs = propDefsFor(layer.type, layer);
      let shown: PropDef[] = [];
      const revealApplies = reveal && (selectedLayers.length === 0 || selectedLayers.includes(layer.id));
      if (revealApplies && reveal === 'animated') shown = defs.filter((d) => (layer.props[d.path]?.keyframes.length ?? 0) > 0);
      else if (revealApplies && Array.isArray(reveal)) shown = defs.filter((d) => reveal.includes(d.path));
      else if (expanded[layer.id]) shown = defs;
      for (const def of shown) if (layer.props[def.path]) out.push({ kind: 'prop', layer, def });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp.layers, expanded, reveal, selectedLayers, fxVersion]);

  const keysByProp = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const k of Object.values(selectedKeys)) {
      const id = k.layerId + '|' + k.path;
      if (!m.has(id)) m.set(id, []);
      m.get(id)!.push(k.keyId);
    }
    return m;
  }, [selectedKeys]);

  const rowsHeight = rows.reduce((h, r) => h + (r.kind === 'layer' ? dims.layerH : dims.propH), 0);

  // ---------------------------------------------------------------- sizing
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => {
      useTimelineUI.setState({ trackWidth: Math.max(50, el.clientWidth - dims.leftW) });
      setViewportH(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- wheel zoom / scroll
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - dims.leftW;
      const s = editor();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        const anchorT = s.scrollTime + Math.max(0, px) / s.pxPerSec;
        s.setZoom(s.pxPerSec * Math.exp(-e.deltaY * 0.0025), anchorT, Math.max(0, px));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
        s.setScrollTime(s.scrollTime + d / s.pxPerSec);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---------------------------------------------------------------- touch: pan, pinch-zoom, tap to deselect
  useEffect(() => {
    const el = scrollRef.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let pan: { x0: number; scroll0: number; moved: boolean; row: number | null } | null = null;
    let pinch: { d0: number; zoom0: number; anchorT: number } | null = null;
    const pair = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: (a.x + b.x) / 2 };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      // A primary pointer starts a fresh gesture: drop anything left from a gesture the browser cancelled.
      if (e.isPrimary) {
        pts.clear();
        pan = null;
        pinch = null;
      }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const s = editor();
      if (pts.size === 2) {
        const { d, mid } = pair();
        const px = mid - el.getBoundingClientRect().left - dims.leftW;
        pinch = { d0: d, zoom0: s.pxPerSec, anchorT: s.scrollTime + Math.max(0, px) / s.pxPerSec };
        pan = null;
      } else if (pts.size === 1 && !(e.target as HTMLElement).closest('.bar.selected,.grip,.kf,.tl-cell-left')) {
        // Empty track or a clip that isn't selected yet: a drag scrolls, a tap selects the clip (or clears the selection).
        const target = e.target as HTMLElement;
        const row = target.closest('.bar') ? target.closest<HTMLElement>('[data-layer-index]') : null;
        pan = { x0: e.clientX, scroll0: s.scrollTime, moved: false, row: row ? Number(row.dataset.layerIndex) : null };
      }
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const s = editor();
      if (pinch && pts.size >= 2) {
        const { d, mid } = pair();
        const px = mid - el.getBoundingClientRect().left - dims.leftW;
        s.setZoom(pinch.zoom0 * (d / pinch.d0), pinch.anchorT, Math.max(0, px));
      } else if (pan) {
        const dx = e.clientX - pan.x0;
        if (!pan.moved && Math.abs(dx) < 6) return;
        pan.moved = true;
        s.setScrollTime(pan.scroll0 - dx / s.pxPerSec);
      }
    };
    const end = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        // A tap on empty track space deselects (a cancelled gesture was a scroll).
        if (pan && !pan.moved && e.type === 'pointerup') {
          const s = editor();
          const layer = pan.row !== null ? activeComp(s).layers[pan.row] : undefined;
          s.selectKeys([]);
          if (layer) {
            s.selectLayer(layer.id);
            haptic('select');
          } else s.selectLayer(null);
        }
        pan = null;
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
  }, []);

  // Follow the playhead while playing (page flip like AE).
  useEffect(
    () =>
      useEditor.subscribe((s, p) => {
        if (!s.playing || s.playhead === p.playhead) return;
        const w = useTimelineUI.getState().trackWidth;
        const x = (s.playhead - s.scrollTime) * s.pxPerSec;
        if (x > w - 20 || x < 0) s.setScrollTime(s.playhead - 20 / s.pxPerSec);
      }),
    [],
  );

  // ---------------------------------------------------------------- marquee & background clicks
  const onRowsDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch') return; // touch pans and pinches instead (below)
    const target = e.target as HTMLElement;
    if (!target.closest('.tl-cell-track') || target.closest('.bar,.kf')) return;
    const host = rowsRef.current!;
    const r0 = host.getBoundingClientRect();
    const x0 = e.clientX - r0.left;
    const y0 = e.clientY - r0.top;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    startDrag(e, {
      move: (_dx, _dy, ev) => {
        const r = host.getBoundingClientRect();
        const x1 = ev.clientX - r.left;
        const y1 = ev.clientY - r.top;
        useTimelineUI.setState({ marquee: { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) } });
      },
      up: (moved) => {
        const mq = useTimelineUI.getState().marquee;
        useTimelineUI.setState({ marquee: null });
        const s = editor();
        if (!moved || !mq) {
          if (!additive) {
            s.selectKeys([]);
            s.selectLayer(null);
          }
          return;
        }
        const r = host.getBoundingClientRect();
        const box = { l: r.left + mq.x, t: r.top + mq.y, r: r.left + mq.x + mq.w, b: r.top + mq.y + mq.h };
        const hits = [...host.querySelectorAll<HTMLElement>('.kf[data-key]')].filter((k) => {
          const kr = k.getBoundingClientRect();
          const cx = (kr.left + kr.right) / 2;
          const cy = (kr.top + kr.bottom) / 2;
          return cx >= box.l && cx <= box.r && cy >= box.t && cy <= box.b;
        });
        const keys = hits.map((h) => {
          const [layerId, path, keyId] = h.dataset.key!.split('|');
          return { layerId, path, keyId };
        });
        s.selectKeys(keys, additive ? 'add' : 'replace');
      },
    });
  };

  // ---------------------------------------------------------------- drops
  const onDragOver = (e: React.DragEvent) => {
    if ([...e.dataTransfer.types].some((t) => t === 'Files' || t.startsWith('application/x-luscent'))) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = scrollRef.current!.getBoundingClientRect();
    const s = editor();
    const raw = s.scrollTime + Math.max(0, e.clientX - rect.left - dims.leftW) / s.pxPerSec;
    const t = makeSnapper().time(raw);
    useTimelineUI.setState({ snap: null });
    const mediaId = e.dataTransfer.getData('application/x-luscent-media');
    const compId = e.dataTransfer.getData('application/x-luscent-comp');
    const presetId = e.dataTransfer.getData(PRESET_DRAG_TYPE);
    if (presetId) {
      const preset = findPreset(presetId);
      if (!preset) return;
      // Dropped on a layer: animate that layer from the drop time.
      const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-layer-index]');
      const layer = row ? comp.layers[Number(row.dataset.layerIndex)] : undefined;
      if (layer) s.selectLayer(layer.id);
      s.setPlayhead(t);
      applyPresetWithToast(preset);
    } else if (mediaId) s.addMediaToComp(mediaId, t);
    else if (compId) s.addCompToComp(compId, t);
    else if (e.dataTransfer.files.length) {
      s.setPlayhead(t);
      void s.importFiles([...e.dataTransfer.files], { addToComp: true });
    }
  };

  const fitAll = () => {
    const w = useTimelineUI.getState().trackWidth;
    editor().set('pxPerSec', Math.max(4, (w - 30) / Math.max(1, comp.duration)));
    editor().setScrollTime(-1);
  };

  let dropY: number | null = null;
  if (dropIndex !== null) {
    let y = 0;
    for (const r of rows) {
      if (r.kind === 'layer' && r.index === dropIndex) break;
      y += r.kind === 'layer' ? dims.layerH : dims.propH;
    }
    dropY = y;
  }

  return (
    <div className="timeline" onDragOver={onDragOver} onDrop={onDrop}>
      {compact ? (
        <MobileTransport fitAll={fitAll} />
      ) : (
        <TimelineToolbar fitAll={fitAll} compStack={compStack} names={compStack.map((id) => project.compositions[id]?.name ?? '?')} />
      )}
      <div className="tl-main">
        <div className="tl-head-row">
          <div className="tl-left-head" style={{ width: dims.leftW }}>
            <span style={{ flex: 1 }}>
              {comp.layers.length} layer{comp.layers.length === 1 ? '' : 's'}
            </span>
            <span title="Video · Audio · Solo · Lock">◉ 🔊 S 🔒</span>
          </div>
          <Ruler width={trackWidth} />
        </div>
        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-rows" ref={rowsRef} style={{ minHeight: '100%' }} onPointerDown={onRowsDown}>
            <GridCanvas width={trackWidth} height={Math.max(rowsHeight, viewportH)} />
            {rows.map((r) =>
              r.kind === 'layer' ? (
                <LayerRow
                  key={r.layer.id}
                  layer={r.layer}
                  index={r.index}
                  selected={selectedLayers.includes(r.layer.id)}
                  expanded={!!expanded[r.layer.id]}
                  pxPerSec={pxPerSec}
                  scrollTime={scrollTime}
                  trackWidth={trackWidth}
                  media={'mediaId' in r.layer ? (project.media[r.layer.mediaId] ?? null) : null}
                  leftWidth={dims.leftW}
                  onMenu={onMenu}
                />
              ) : (
                <PropRow
                  key={r.layer.id + r.def.path}
                  layer={r.layer}
                  def={r.def}
                  pxPerSec={pxPerSec}
                  scrollTime={scrollTime}
                  trackWidth={trackWidth}
                  leftWidth={dims.leftW}
                  selectedIds={(keysByProp.get(r.layer.id + '|' + r.def.path) ?? []).join(',')}
                  onMenu={onMenu}
                />
              ),
            )}
            {comp.layers.length === 0 && <div className="tl-empty">Drag media here, or use the Add panel. Drop a song to get a beat grid for snapping.</div>}
            {dropY !== null && <div style={{ position: 'absolute', left: 0, right: 0, top: dropY - 1, height: 2, background: 'var(--accent)', zIndex: 6 }} />}
            <Marquee />
          </div>
        </div>
        {graphMode && (
          <div className="graph-overlay" style={{ left: dims.leftW, top: 30 }}>
            <GraphEditor />
          </div>
        )}
        <PlayheadOverlay />
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Marquee() {
  const mq = useTimelineUI((s) => s.marquee);
  if (!mq) return null;
  return <div className="marquee" style={{ left: mq.x, top: mq.y, width: mq.w, height: mq.h }} />;
}

function PlayheadOverlay() {
  const playhead = useEditor((s) => s.playhead);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const scrollTime = useEditor((s) => s.scrollTime);
  const snap = useTimelineUI((s) => s.snap);
  const readout = useTimelineUI((s) => s.readout);
  const x = (playhead - scrollTime) * pxPerSec;

  // Drag the playhead by its grip (big enough for a thumb), snapping to edits, markers and beats.
  const onGrip = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const s = editor();
    if (s.playing) s.pause();
    const snapper = makeSnapper({ playhead: false });
    const t0 = s.playhead;
    haptic('select');
    startDrag(e, {
      threshold: 0,
      autoScroll: true,
      move: (dx, _dy, ev) => {
        const t = snapper.time(Math.max(0, t0 + dx / editor().pxPerSec), ev);
        editor().setPlayhead(t);
        scrubAudio(editor().playhead);
        const fps = activeComp(editor()).fps;
        useTimelineUI.setState({ readout: { time: t, text: formatTimecode(t, fps) } });
      },
    });
  };

  return (
    <div className="tl-overlay" style={{ left: dims.leftW, top: 0 }}>
      {x >= -20 && (
        <>
          <div className="playhead-line" style={{ left: x }} />
          <div className="playhead-grip" style={{ left: x }} onPointerDown={onGrip} title="Drag to scrub">
            <span />
          </div>
        </>
      )}
      {snap && <div className={'snap-line ' + snap.kind} style={{ left: (snap.time - scrollTime) * pxPerSec }} />}
      {readout && (
        <div className="drag-readout" style={{ left: Math.max(30, (readout.time - scrollTime) * pxPerSec) }}>
          {readout.text}
        </div>
      )}
    </div>
  );
}

/** Phone transport: big play button, frame steps, snapping toggle and a tools menu. */
function MobileTransport({ fitAll }: { fitAll: () => void }) {
  const playing = useEditor((s) => s.playing);
  const snapping = useEditor((s) => s.snapping);
  const playhead = useEditor((s) => s.playhead);
  const comp = useEditor(activeComp);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const s = useEditor.getState();
  const openTools = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({
      x: r.right - 230,
      y: r.bottom + 4,
      items: [
        { label: 'Add marker here', action: () => editor().addMarker() },
        { label: s.beatSnap ? 'Beat snapping: on' : 'Beat snapping: off', action: () => editor().set('beatSnap', !editor().beatSnap) },
        { label: s.ripple ? 'Ripple edits: on' : 'Ripple edits: off', action: () => editor().set('ripple', !editor().ripple) },
        { label: s.loop ? 'Loop playback: on' : 'Loop playback: off', action: () => editor().set('loop', !editor().loop) },
        { separator: true, label: '' },
        { label: s.graphMode ? 'Hide graph editor' : 'Graph editor', action: () => editor().set('graphMode', !editor().graphMode) },
        { label: 'Fit whole timeline', action: fitAll },
        { label: 'Previous cut', action: () => editor().jump('prev-edit') },
        { label: 'Next cut', action: () => editor().jump('next-edit') },
        { label: 'Jump to start', action: () => editor().jump('start') },
        { label: 'Jump to end', action: () => editor().jump('end') },
      ],
    });
  };
  return (
    <div className="m-transport">
      <div className="m-time">
        <strong>{formatTimecode(playhead, comp.fps)}</strong>
        <span>{formatTimecode(comp.duration, comp.fps)}</span>
      </div>
      <div className="m-play">
        <button className="m-tbtn" aria-label="Previous frame" onClick={() => s.stepFrames(-1)}>
          <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <button className={'m-playbtn' + (playing ? ' on' : '')} aria-label={playing ? 'Pause' : 'Play'} onClick={() => s.togglePlay()}>
          {playing ? (
            <svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="fill"><path d="M8 5l11 7-11 7z" /></svg>
          )}
        </button>
        <button className="m-tbtn" aria-label="Next frame" onClick={() => s.stepFrames(1)}>
          <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
      <div className="m-tools">
        <button className={'m-tbtn snap' + (snapping ? ' on' : '')} aria-label="Snapping" aria-pressed={snapping} onClick={() => s.set('snapping', !snapping)}>
          <svg viewBox="0 0 24 24"><path d="M6 4v7a6 6 0 0 0 12 0V4M6 8h4M14 8h4" /></svg>
        </button>
        <button className="m-tbtn" aria-label="Timeline tools" onClick={openTools}>
          <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Background grid: second lines, beat lines, work area shading. */
function GridCanvas({ width, height }: { width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const comp = useEditor(activeComp);
  const project = useEditor((s) => s.project);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const scrollTime = useEditor((s) => s.scrollTime);
  const beatSnap = useEditor((s) => s.beatSnap);
  const beats = useMemo(() => compBeatTimes(project, comp), [project, comp]);
  const h = Math.min(height, 16000);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(width * dpr);
    c.height = Math.ceil(h * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const xOf = (t: number) => (t - scrollTime) * pxPerSec;
    // Outside the work area / comp: dim.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const wa0 = xOf(comp.workArea.start);
    const wa1 = xOf(comp.workArea.end);
    if (wa0 > 0) ctx.fillRect(0, 0, Math.min(width, wa0), h);
    if (wa1 < width) ctx.fillRect(Math.max(0, wa1), 0, width - Math.max(0, wa1), h);
    const end = xOf(comp.duration);
    if (end < width) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(Math.max(0, end), 0, width, h);
    }
    const { major } = tickStep(pxPerSec, comp.fps);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let t = Math.floor(scrollTime / major) * major; t <= scrollTime + width / pxPerSec; t += major) {
      ctx.fillRect(Math.round(xOf(t)), 0, 1, h);
    }
    if (beats.length) {
      beats.forEach((b, i) => {
        const x = xOf(b);
        if (x < 0 || x > width) return;
        const strong = i % 4 === 0;
        ctx.fillStyle = beatSnap ? (strong ? 'rgba(200,255,61,0.16)' : 'rgba(200,255,61,0.07)') : 'rgba(200,255,61,0.04)';
        ctx.fillRect(Math.round(x), 0, 1, h);
      });
    }
  }, [width, h, pxPerSec, scrollTime, comp.workArea.start, comp.workArea.end, comp.duration, comp.fps, beats, beatSnap]);
  return <canvas ref={ref} className="grid-canvas" style={{ left: dims.leftW }} />;
}

function TimelineToolbar({ fitAll, compStack, names }: { fitAll: () => void; compStack: string[]; names: string[] }) {
  const comp = useEditor(activeComp);
  const playing = useEditor((s) => s.playing);
  const loop = useEditor((s) => s.loop);
  const snapping = useEditor((s) => s.snapping);
  const beatSnap = useEditor((s) => s.beatSnap);
  const ripple = useEditor((s) => s.ripple);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const project = useEditor((s) => s.project);
  const graphMode = useEditor((s) => s.graphMode);
  const graphType = useEditor((s) => s.graphType);
  const bpm = useMemo(() => {
    for (const l of comp.layers) {
      if (l.type === 'audio' || l.type === 'video') {
        const a = project.media[l.mediaId]?.analysis;
        if (a?.bpm) return a.bpm;
      }
    }
    return null;
  }, [comp.layers, project.media]);
  const s = useEditor.getState();
  return (
    <div className="tl-toolbar">
      <div className="crumbs">
        {compStack.map((id, i) => (
          <span key={id + i} className={i === compStack.length - 1 ? 'cur' : ''} onClick={() => s.breadcrumb(i)}>
            {i > 0 && '› '}
            {names[i]}
          </span>
        ))}
      </div>
      <TimecodeInput />
      <div className="row" style={{ gap: 2 }}>
        <button className="icon ghost" title="Go to start (Home)" onClick={() => s.jump('start')}>
          ⏮
        </button>
        <button className="icon ghost" title="Previous frame (←)" onClick={() => s.stepFrames(-1)}>
          ◂
        </button>
        <button className={'icon' + (playing ? ' on' : '')} title="Play / pause (Space)" onClick={() => s.togglePlay()} style={{ minWidth: 34 }}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="icon ghost" title="Next frame (→)" onClick={() => s.stepFrames(1)}>
          ▸
        </button>
        <button className="icon ghost" title="Go to end (End)" onClick={() => s.jump('end')}>
          ⏭
        </button>
        <button className={'icon' + (loop ? ' on' : '')} title="Loop work area" onClick={() => s.set('loop', !loop)}>
          ⟲
        </button>
      </div>
      <span className="sep" style={{ width: 1, height: 18, background: 'var(--line-2)' }} />
      <button className="icon" title="Split at playhead (⌘⇧D) — splits selected layers, or everything under the playhead" onClick={() => s.splitAtPlayhead()}>
        ✂ Split
      </button>
      <button className="icon" title="Add marker (M)" onClick={() => s.addMarker()}>
        ⚑
      </button>
      <span className="sep" style={{ width: 1, height: 18, background: 'var(--line-2)' }} />
      <button className={'icon' + (graphMode ? ' on' : '')} title="Graph editor (⇧F3)" onClick={() => s.set('graphMode', !graphMode)}>
        ⤳ Graph
      </button>
      {graphMode && (
        <div className="seg">
          <button className={'icon' + (graphType === 'value' ? ' on' : '')} onClick={() => s.set('graphType', 'value')} title="Value graph">
            Value
          </button>
          <button className={'icon' + (graphType === 'speed' ? ' on' : '')} onClick={() => s.set('graphType', 'speed')} title="Speed graph">
            Speed
          </button>
        </div>
      )}
      <span className="grow" />
      {bpm && (
        <span className="badge beat" title="Detected tempo of the first analysed track">
          {bpm} BPM
        </span>
      )}
      <button className={'icon' + (snapping ? ' on' : '')} title="Snapping (hold ⌘/Ctrl while dragging to invert)" onClick={() => s.set('snapping', !snapping)}>
        🧲 Snap
      </button>
      <button className={'icon' + (beatSnap ? ' on' : '')} title="Snap to detected beats & transients" onClick={() => s.set('beatSnap', !beatSnap)}>
        ♪ Beats
      </button>
      <button className={'icon' + (ripple ? ' on' : '')} title="Ripple mode: trims and deletes close gaps (Alt inverts while trimming)" onClick={() => s.set('ripple', !ripple)}>
        ⇤ Ripple
      </button>
      <input
        className="zoom-slider"
        type="range"
        min={Math.log(4)}
        max={Math.log(6000)}
        step={0.01}
        value={Math.log(pxPerSec)}
        title="Timeline zoom (Ctrl/⌘ + wheel, = / −)"
        onChange={(e) => {
          const st = editor();
          const w = useTimelineUI.getState().trackWidth;
          const anchor = st.playhead;
          st.setZoom(Math.exp(Number(e.target.value)), anchor, Math.max(0, Math.min(w, (anchor - st.scrollTime) * st.pxPerSec)));
        }}
      />
      <button className="icon ghost" title="Fit composition (\\)" onClick={fitAll}>
        ⇔
      </button>
    </div>
  );
}

function TimecodeInput() {
  const playhead = useEditor((s) => s.playhead);
  const fps = useEditor((s) => activeComp(s).fps);
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    return (
      <input
        type="text"
        className="timecode"
        style={{ width: 96 }}
        autoFocus
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(null);
        }}
        onBlur={() => {
          const t = parseTimecode(editing, fps);
          if (t !== null) editor().setPlayhead(t);
          setEditing(null);
        }}
      />
    );
  }
  return (
    <span className="timecode" style={{ cursor: 'text', minWidth: 96 }} title="Click to type a time (MM:SS:FF, 2.5s, 45f)" onClick={() => setEditing(formatTimecode(playhead, fps))}>
      {formatTimecode(playhead, fps)}
    </span>
  );
}
