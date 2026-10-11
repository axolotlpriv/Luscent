/**
 * Graph editor: value graph and speed graph for keyframed properties, with
 * After Effects-style bezier handles mapped directly onto TemporalEase
 * (speed / influence). Shares the timeline's time axis (zoom + scroll).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { evaluateKeys, segmentCurve, valueDistance } from '../../core/animation/interpolate';
import { moveKeyframes, setKeyEase, setKeyValues } from '../../core/animation/keyframes';
import { propDefsFor, type PropDef } from '../../core/model/properties';
import type { AnimProp, Composition, Keyframe, Layer, PropValue } from '../../core/model/types';
import { quantize } from '../../core/time';
import { activeComp, editor, keySelId, useEditor, type KeySel } from '../../state/store';
import { makeSnapper, startDrag } from '../timeline/drag';

const PAD = 18;
const DIM_COLORS = ['#ff6b81', '#4cd97b', '#4fa9ff', '#c9c9c9'];
const PROP_COLORS = ['#ff3d7f', '#2ec5ff', '#c8ff3d', '#ffcf3d', '#7c5cff', '#21e6a1', '#ff7a3d'];

interface GProp {
  layer: Layer;
  def: PropDef;
  prop: AnimProp;
  color: string;
  /** Value → y mapping for this property. */
  lo: number;
  hi: number;
}

function dims(v: PropValue): number[] {
  return typeof v === 'number' ? [v] : v.slice(0, v.length === 4 ? 4 : v.length);
}

/** Signed speed for 1-D props, path speed for vectors (units / second). */
function speedAt(prop: AnimProp, t: number): number {
  const h = 1e-3;
  const a = evaluateKeys(prop, t - h);
  const b = evaluateKeys(prop, t + h);
  if (typeof a === 'number') return ((b as number) - a) / (2 * h);
  return valueDistance(a, b) / (2 * h);
}

/** Dimension with the largest change across a segment (where handles are drawn). */
function dominantDim(k0: Keyframe, k1: Keyframe): number {
  const a = dims(k0.value);
  const b = dims(k1.value);
  let best = 0;
  let bestD = -1;
  for (let i = 0; i < Math.min(a.length, 3); i++) {
    const d = Math.abs(b[i] - a[i]);
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

type Hit =
  | { kind: 'key'; layerId: string; path: string; key: Keyframe; dim: number }
  | { kind: 'handle'; layerId: string; path: string; key: Keyframe; side: 'in' | 'out'; seg: [Keyframe, Keyframe]; dim: number };

export function GraphEditor() {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 200 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const comp = useEditor(activeComp);
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const selectedLayers = useEditor((s) => s.selectedLayers);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const scrollTime = useEditor((s) => s.scrollTime);
  const graphType = useEditor((s) => s.graphType);
  const hits = useRef<Array<{ x: number; y: number; hit: Hit }>>([]);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const gprops = useMemo(() => buildGraphProps(comp, selectedKeys, selectedLayers, graphType, scrollTime, scrollTime + size.w / pxPerSec), [
    comp,
    selectedKeys,
    selectedLayers,
    graphType,
    scrollTime,
    pxPerSec,
    size.w,
  ]);

  const xOf = (t: number) => (t - scrollTime) * pxPerSec;
  const yOf = (g: GProp, v: number) => {
    const span = g.hi - g.lo || 1;
    return size.h - PAD - ((v - g.lo) / span) * (size.h - 2 * PAD);
  };
  const vOfY = (g: GProp, y: number) => {
    const span = g.hi - g.lo || 1;
    return g.lo + ((size.h - PAD - y) / (size.h - 2 * PAD)) * span;
  };

  // ------------------------------------------------------------------ draw
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(size.w * dpr);
    c.height = Math.ceil(size.h * dpr);
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = '#0f1116';
    ctx.fillRect(0, 0, size.w, size.h);
    // Horizontal guides.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(PAD + (i / 4) * (size.h - 2 * PAD)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.w, y);
      ctx.stroke();
    }
    hits.current = [];
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    if (gprops.length === 0) {
      ctx.fillStyle = '#8a90a2';
      ctx.fillText('Select keyframes or an animated layer to see its curves.', 16, size.h / 2);
      return;
    }
    // Axis labels when a single property is shown.
    if (gprops.length === 1) {
      const g = gprops[0];
      ctx.fillStyle = '#5b6172';
      for (let i = 0; i <= 4; i++) {
        const v = g.lo + ((4 - i) / 4) * (g.hi - g.lo);
        ctx.fillText(v.toFixed(Math.abs(g.hi - g.lo) < 10 ? 2 : 0), 4, PAD + (i / 4) * (size.h - 2 * PAD) - 3);
      }
    }
    const t0 = scrollTime;
    gprops.forEach((g) => {
      const { layer, prop } = g;
      const isSelProp = prop.keyframes.some((k) => selectedKeys[keySelId({ layerId: layer.id, path: g.def.path, keyId: k.id })]);
      const nd = graphType === 'speed' ? 1 : dims(prop.value).length;
      for (let d = 0; d < nd; d++) {
        ctx.strokeStyle = graphType === 'speed' || nd === 1 ? g.color : DIM_COLORS[d];
        ctx.lineWidth = isSelProp ? 1.8 : 1.2;
        ctx.globalAlpha = isSelProp || Object.keys(selectedKeys).length === 0 ? 1 : 0.55;
        ctx.beginPath();
        for (let x = 0; x <= size.w; x += 2) {
          const lt = t0 + x / pxPerSec - layer.startTime;
          const v = graphType === 'speed' ? speedAt(prop, lt) : dims(evaluateKeys(prop, lt))[d];
          const y = yOf(g, v);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Keyframes + handles.
      const keys = prop.keyframes;
      keys.forEach((k, i) => {
        const sel = !!selectedKeys[keySelId({ layerId: layer.id, path: g.def.path, keyId: k.id })];
        const kx = xOf(layer.startTime + k.time);
        if (kx < -20 || kx > size.w + 20) return;
        const pts: Array<[number, number]> = [];
        if (graphType === 'speed') {
          pts.push([kx, yOf(g, speedAt(prop, k.time + (i === keys.length - 1 ? -1e-3 : 1e-3)))]);
        } else {
          dims(k.value).forEach((v) => pts.push([kx, yOf(g, v)]));
          if (pts.length > 3) pts.length = 3;
        }
        pts.forEach(([px, py], d) => {
          ctx.fillStyle = sel ? '#ffcf3d' : '#f4f5f8';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.fillRect(px - 3.5, py - 3.5, 7, 7);
          ctx.strokeRect(px - 3.5, py - 3.5, 7, 7);
          hits.current.push({ x: px, y: py, hit: { kind: 'key', layerId: layer.id, path: g.def.path, key: k, dim: d } });
        });
        if (!sel) return;
        // Handles on both adjacent segments.
        const segs: Array<{ side: 'in' | 'out'; seg: [Keyframe, Keyframe] }> = [];
        if (i < keys.length - 1) segs.push({ side: 'out', seg: [k, keys[i + 1]] });
        if (i > 0) segs.push({ side: 'in', seg: [keys[i - 1], k] });
        for (const { side, seg } of segs) {
          const h = handlePos(layer, seg, side, graphType);
          if (!h) continue;
          const hx = xOf(h.t);
          const hy = yOf(g, h.v);
          const ax = xOf(layer.startTime + (side === 'out' ? seg[0].time : seg[1].time));
          const ay = graphType === 'speed' ? yOf(g, h.anchorV) : yOf(g, dims(side === 'out' ? seg[0].value : seg[1].value)[h.dim]);
          ctx.strokeStyle = '#ffcf3d';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.fillStyle = '#ffcf3d';
          ctx.beginPath();
          ctx.arc(hx, hy, 4, 0, Math.PI * 2);
          ctx.fill();
          hits.current.push({ x: hx, y: hy, hit: { kind: 'handle', layerId: layer.id, path: g.def.path, key: k, side, seg, dim: h.dim } });
        }
      });
    });
    // Legend
    let lx = 8;
    gprops.forEach((g) => {
      const label = `${g.layer.name} · ${g.def.label}`;
      ctx.fillStyle = g.color;
      ctx.fillRect(lx, size.h - 12, 8, 8);
      ctx.fillStyle = '#c8ccd6';
      ctx.fillText(label, lx + 12, size.h - 4);
      lx += ctx.measureText(label).width + 28;
    });
  }, [gprops, size, pxPerSec, scrollTime, graphType, selectedKeys]);

  // ------------------------------------------------------------------ interaction
  const pick = (x: number, y: number): Hit | null => {
    let best: Hit | null = null;
    let bestD = 8;
    // Handles take priority over keys (they're drawn on top).
    for (const h of [...hits.current].reverse()) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bestD || (d <= bestD + 0.5 && best?.kind === 'key' && h.hit.kind === 'handle')) {
        bestD = d;
        best = h.hit;
      }
    }
    return best;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = local(e);
    const hit = pick(x, y);
    const s = editor();
    if (!hit) {
      // Marquee select keyframe points.
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      startDrag(e, {
        move: (_dx, _dy, ev) => {
          const [x1, y1] = local(ev);
          setMarquee({ x: Math.min(x, x1), y: Math.min(y, y1), w: Math.abs(x1 - x), h: Math.abs(y1 - y) });
        },
        up: (moved, ev) => {
          setMarquee(null);
          if (!moved) {
            if (!additive) s.selectKeys([]);
            return;
          }
          const [x1, y1] = local(ev);
          const box = { l: Math.min(x, x1), r: Math.max(x, x1), t: Math.min(y, y1), b: Math.max(y, y1) };
          const sel: KeySel[] = [];
          const seen = new Set<string>();
          for (const h of hits.current) {
            if (h.hit.kind !== 'key') continue;
            if (h.x < box.l || h.x > box.r || h.y < box.t || h.y > box.b) continue;
            const ks = { layerId: h.hit.layerId, path: h.hit.path, keyId: h.hit.key.id };
            if (!seen.has(keySelId(ks))) sel.push(ks);
            seen.add(keySelId(ks));
          }
          s.selectKeys(sel, additive ? 'add' : 'replace');
        },
      });
      return;
    }
    const g = gprops.find((p) => p.layer.id === hit.layerId && p.def.path === hit.path);
    if (!g) return;
    const base = s.project;
    const compId = activeComp(s).id;
    const baseLayer = base.compositions[compId].layers.find((l) => l.id === hit.layerId)!;
    const baseProp = baseLayer.props[hit.path];
    if (hit.kind === 'handle') {
      const [k0, k1] = hit.seg;
      const T = k1.time - k0.time;
      const L = valueDistance(k0.value, k1.value);
      const delta = dims(k1.value)[hit.dim] - dims(k0.value)[hit.dim];
      const sign1D = typeof k0.value === 'number' ? Math.sign(delta) || 1 : 1;
      let began = false;
      startDrag(e, {
        threshold: 1,
        move: (_dx, _dy, ev) => {
          if (!began) {
            s.beginGesture('Edit Ease');
            began = true;
          }
          const [mx, my] = local(ev);
          const t = scrollTime + mx / pxPerSec - g.layer.startTime;
          const v = vOfY(g, my);
          let influence: number;
          let speed: number;
          if (hit.side === 'out') {
            influence = Math.min(1, Math.max(0.01, (t - k0.time) / T));
            if (graphType === 'speed') speed = v / sign1D;
            else speed = Math.abs(delta) > 1e-9 ? ((v - dims(k0.value)[hit.dim]) / (influence * T)) * (L / delta) : 0;
          } else {
            influence = Math.min(1, Math.max(0.01, (k1.time - t) / T));
            if (graphType === 'speed') speed = v / sign1D;
            else speed = Math.abs(delta) > 1e-9 ? ((dims(k1.value)[hit.dim] - v) / (influence * T)) * (L / delta) : 0;
          }
          if (ev.shiftKey) speed = 0; // Shift: flat (zero-velocity) handle
          const next = setKeyEase(baseProp, hit.key.id, hit.side, { speed, influence });
          editor().editFrom(base, 'Edit Ease', (d) => {
            const l = d.compositions[compId].layers.find((x) => x.id === hit.layerId)!;
            l.props[hit.path] = next as (typeof l.props)[string];
          });
        },
        up: () => {
          if (began) editor().endGesture();
        },
      });
      return;
    }
    // Key drag: horizontal = time (all selected), vertical = value (value graph).
    const ks = { layerId: hit.layerId, path: hit.path, keyId: hit.key.id };
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      s.selectKeys([ks], 'toggle');
      return;
    }
    if (!s.selectedKeys[keySelId(ks)]) s.selectKeys([ks]);
    const sel = Object.values(editor().selectedKeys);
    const snap = makeSnapper();
    const comp0 = base.compositions[compId];
    const kt = baseLayer.startTime + hit.key.time;
    const startV = dims(hit.key.value)[hit.dim];
    // Overlapping curves (e.g. uniform scale): edit every dimension at that value.
    const editDims = dims(hit.key.value)
      .map((v, i) => (Math.abs(v - startV) < 1e-9 && i < 3 ? i : -1))
      .filter((i) => i >= 0);
    let began = false;
    let axis: 'x' | 'y' | null = null;
    startDrag(e, {
      move: (dx, dy, ev) => {
        if (!began) {
          s.beginGesture('Move Keyframes');
          began = true;
        }
        if (ev.altKey && !axis) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        const allowX = axis !== 'y';
        const allowY = axis !== 'x' && graphType === 'value';
        const dt = allowX ? snap.time(kt + dx / pxPerSec, ev) - kt : 0;
        const [, my] = local(ev);
        const dv = allowY ? vOfY(g, my) - startV : 0;
        editor().editFrom(base, 'Move Keyframes', (d) => {
          const c = d.compositions[compId];
          const groups = new Map<string, Set<string>>();
          for (const k of sel) {
            const gk = k.layerId + '|' + k.path;
            if (!groups.has(gk)) groups.set(gk, new Set());
            groups.get(gk)!.add(k.keyId);
          }
          for (const [gk, ids] of groups) {
            const [layerId, path] = gk.split('|');
            const bl = comp0.layers.find((l) => l.id === layerId);
            const dl = c.layers.find((l) => l.id === layerId);
            if (!bl || !dl || !bl.props[path] || bl.locked) continue;
            let p = bl.props[path];
            if (dv !== 0 && path === hit.path && layerId === hit.layerId) {
              const vals = new Map<string, PropValue>();
              for (const k of p.keyframes) {
                if (!ids.has(k.id)) continue;
                if (typeof k.value === 'number') vals.set(k.id, k.value + dv);
                else {
                  const arr = k.value.slice() as number[];
                  for (const d of editDims) arr[d] += dv;
                  vals.set(k.id, arr as PropValue);
                }
              }
              p = setKeyValues(p, vals);
            }
            if (dt !== 0) p = moveKeyframes(p, ids, dt, (t) => quantize(t + bl.startTime, c.fps) - bl.startTime);
            dl.props[path] = p as (typeof dl.props)[string];
          }
        });
      },
      up: (moved) => {
        if (began) editor().endGesture();
        if (!moved) editor().selectKeys([ks]);
      },
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = editor();
    const [x] = local(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      s.setZoom(s.pxPerSec * Math.exp(-e.deltaY * 0.0025), s.scrollTime + x / s.pxPerSec, x);
    } else {
      s.setScrollTime(s.scrollTime + (e.deltaX || e.deltaY) / s.pxPerSec);
    }
  };

  return (
    <div className="graph-editor" ref={wrapRef} onPointerDown={onDown} onWheel={onWheel}>
      <canvas ref={ref} />
      {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
    </div>
  );
}

/** Handle position for one side of a segment, in (layer time, value/speed). */
function handlePos(layer: Layer, seg: [Keyframe, Keyframe], side: 'in' | 'out', mode: 'value' | 'speed') {
  const [k0, k1] = seg;
  if (k0.outInterp === 'hold') return null;
  const curve = segmentCurve(k0, k1);
  if (curve.fn) return null;
  const T = k1.time - k0.time;
  if (T <= 0) return null;
  const L = valueDistance(k0.value, k1.value);
  const avg = L / T;
  const out = k0.outInterp === 'bezier' ? k0.outEase : { speed: avg, influence: 1 / 3 };
  const inn = k1.inInterp === 'bezier' ? k1.inEase : { speed: avg, influence: 1 / 3 };
  const dim = dominantDim(k0, k1);
  const delta = dims(k1.value)[dim] - dims(k0.value)[dim];
  const sign1D = typeof k0.value === 'number' ? Math.sign(delta) || 1 : 1;
  if (mode === 'speed') {
    if (side === 'out') return { t: layer.startTime + k0.time + out.influence * T, v: out.speed * sign1D, anchorV: out.speed * sign1D, dim };
    return { t: layer.startTime + k1.time - inn.influence * T, v: inn.speed * sign1D, anchorV: inn.speed * sign1D, dim };
  }
  const ratio = L > 1e-9 ? delta / L : 0;
  if (side === 'out') {
    return { t: layer.startTime + k0.time + out.influence * T, v: dims(k0.value)[dim] + out.speed * out.influence * T * ratio, anchorV: 0, dim };
  }
  return { t: layer.startTime + k1.time - inn.influence * T, v: dims(k1.value)[dim] - inn.speed * inn.influence * T * ratio, anchorV: 0, dim };
}

function buildGraphProps(
  comp: Composition,
  selectedKeys: Record<string, KeySel>,
  selectedLayers: string[],
  mode: 'value' | 'speed',
  t0: number,
  t1: number,
): GProp[] {
  const want = new Map<string, { layer: Layer; path: string }>();
  const sel = Object.values(selectedKeys);
  if (sel.length) {
    for (const k of sel) {
      const layer = comp.layers.find((l) => l.id === k.layerId);
      if (layer?.props[k.path]) want.set(k.layerId + '|' + k.path, { layer, path: k.path });
    }
  } else {
    const layers = selectedLayers.length ? comp.layers.filter((l) => selectedLayers.includes(l.id)) : comp.layers;
    for (const layer of layers) {
      for (const [path, p] of Object.entries(layer.props)) if (p.keyframes.length > 1) want.set(layer.id + '|' + path, { layer, path });
    }
  }
  const out: GProp[] = [];
  let ci = 0;
  for (const { layer, path } of [...want.values()].slice(0, 10)) {
    const def = propDefsFor(layer.type, layer).find((d) => d.path === path);
    const prop = layer.props[path];
    if (!def || !prop) continue;
    let lo = Infinity;
    let hi = -Infinity;
    const acc = (v: number) => {
      if (!Number.isFinite(v)) return;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    };
    const n = 160;
    const a = Math.max(t0, prop.keyframes.length ? layer.startTime + prop.keyframes[0].time - 0.25 : t0);
    const b = Math.min(t1, prop.keyframes.length ? layer.startTime + prop.keyframes[prop.keyframes.length - 1].time + 0.25 : t1);
    for (let i = 0; i <= n; i++) {
      const lt = a + ((b - a) * i) / n - layer.startTime;
      if (mode === 'speed') acc(speedAt(prop, lt));
      else dims(evaluateKeys(prop, lt)).slice(0, 3).forEach(acc);
    }
    if (mode === 'value') for (const k of prop.keyframes) dims(k.value).slice(0, 3).forEach(acc);
    else acc(0);
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-6) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    out.push({ layer, def, prop, color: PROP_COLORS[ci++ % PROP_COLORS.length], lo: lo - pad, hi: hi + pad });
  }
  return out;
}
