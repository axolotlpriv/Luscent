import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { frameCache } from '../../engine/cache/FrameCache';
import { cacheWorkArea } from '../../engine/cache/ramPreview';
import { GLRenderer, type SourceProvider } from '../../engine/gl/Renderer';
import { VideoPool } from '../../engine/media/VideoPool';
import { FrameSource } from '../../engine/media/FrameSource';
import { FrameInterpolator } from '../../engine/flow/FrameInterpolator';
import { mediaEngine } from '../../engine/media/MediaEngine';
import { effectRegistry } from '../../core/effects/registry';
import { getWgslBridge } from '../../engine/plugins/pluginStore';
import {
  approximateTextMeasure,
  collectVideoItems,
  evaluateComposition,
  evaluateLayer,
  isLayerActive,
  itemCorners,
  pointInQuad,
  worldMatrix,
  type CompFrame,
  type RenderItem,
} from '../../core/render/evaluate';
import { apply, invert } from '../../core/render/matrix';
import { evaluateProp } from '../../core/animation/interpolate';
import { activeComp, editor, useEditor } from '../../state/store';
import { formatTimecode } from '../../core/time';
import type { Vec2 } from '../../core/model/types';
import { haptic } from '../haptics';

const PAD = 28;

type Guides = { v: number[]; h: number[] };
const round1 = (v: number) => Math.round(v * 10) / 10;
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/** Push a quad's corners outward from its centre by `m` (for forgiving hit tests). */
function growQuad(q: [number, number][], m: number): [number, number][] {
  if (m <= 0) return q;
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  return q.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / d) * m * Math.SQRT2, y + ((y - cy) / d) * m * Math.SQRT2] as [number, number];
  });
}

/** Axis-aligned bounds [x0, y0, x1, y1] of several rendered items, in comp space. */
function boundsOf(items: RenderItem[]): [number, number, number, number] | null {
  if (!items.length) return null;
  const pts = items.flatMap((it) => itemCorners(it));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/** Closest snap of any of `edges` to any of `lines` within `reach`: the correction and the line it snapped to. */
function snapAxis(edges: number[], lines: number[], reach: number): { d: number; line: number } | null {
  let best: { d: number; line: number } | null = null;
  for (const e of edges) for (const l of lines) if (Math.abs(l - e) < reach && (!best || Math.abs(l - e) < Math.abs(best.d))) best = { d: l - e, line: l };
  return best;
}

export function Viewer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GLRenderer | null>(null);
  const poolRef = useRef<VideoPool | null>(null);
  const interpRef = useRef<FrameInterpolator | null>(null);
  const frameRef = useRef<CompFrame | null>(null);
  const rafRef = useRef(0);
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ ms: 0, fps: 0, scale: 1 });
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const fpsRef = useRef({ frames: 0, since: performance.now() });
  const [guides, setGuides] = useState<Guides | null>(null);
  const [hud, setHud] = useState<string | null>(null);

  const comp = useEditor(activeComp);
  const previewScale = useEditor((s) => s.previewScale);
  const safeZones = useEditor((s) => s.safeZones);
  const useProxies = useEditor((s) => s.useProxies);
  const playhead = useEditor((s) => s.playhead);
  const selectedLayers = useEditor((s) => s.selectedLayers);

  const fitZoom = Math.max(0.02, Math.min((stage.w - PAD * 2) / comp.width, (stage.h - PAD * 2) / comp.height));
  const zoom = zoomMode === 'fit' ? fitZoom : zoomMode;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const effectiveScale = previewScale > 0 ? previewScale : Math.min(1, Math.max(0.25, Math.ceil(zoom * dpr * 4) / 4));
  const scaleRef = useRef(effectiveScale);
  scaleRef.current = effectiveScale;

  const draw = useCallback(() => {
    rafRef.current = 0;
    const r = rendererRef.current;
    const pool = poolRef.current;
    if (!r || !pool) return;
    const s = editor();
    // RAM preview: show a pre-rendered frame when the cache covers it.
    const ac = activeComp(s);
    const fi = Math.round(s.playhead * ac.fps);
    if (frameCache.count > 0 && frameCache.validate(s.project, s.activeCompId, scaleRef.current, ac.fps) && frameCache.has(fi)) {
      r.presentBitmap(frameCache.get(fi)!);
      pool.sync([], s.playing);
      return;
    }
    const frame = evaluateComposition(s.project, s.activeCompId, s.playhead, { measureText: (spec) => r.text.measure(spec) });
    if (!frame) return;
    frameRef.current = frame;
    const videos = collectVideoItems(frame);
    pool.sync(
      videos.map((v) => ({ key: v.key, mediaId: v.mediaId, time: v.sourceTime, speed: v.speed })),
      s.playing,
    );
    const interp = interpRef.current;
    if (interp && interp.engine !== s.flowEngine) interp.engine = s.flowEngine;
    const sources: SourceProvider = {
      image: (id) => mediaEngine.image(id),
      video: (key, mediaId, item) => {
        if (item && item.frameBlending !== 'none' && interp) {
          const fps = s.project.media[mediaId]?.fps || 30;
          const f = interp.get(mediaId, item.sourceTime, fps, item.frameBlending);
          if (f) return f;
        }
        return pool.frame(key);
      },
    };
    r.render(frame, sources, { scale: scaleRef.current });
    r.retainVideo(new Set(videos.map((v) => v.key)));
    const f = fpsRef.current;
    f.frames++;
    const now = performance.now();
    if (now - f.since > 500) {
      setStats({ ms: r.stats.ms, fps: (f.frames * 1000) / (now - f.since), scale: scaleRef.current });
      f.frames = 0;
      f.since = now;
    }
  }, []);

  const requestDraw = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // Renderer lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current!;
    try {
      rendererRef.current = new GLRenderer(canvas);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    poolRef.current = new VideoPool(mediaEngine, requestDraw, () => editor().useProxies);
    const frames = new FrameSource(mediaEngine);
    interpRef.current = new FrameInterpolator(frames, requestDraw);
    interpRef.current.onError = (msg) => {
      editor().toast(msg, 'error');
      editor().set('flowEngine', 'farneback');
    };
    void getWgslBridge().then((b) => {
      if (b && rendererRef.current) {
        rendererRef.current.wgsl = b;
        requestDraw();
      }
    });
    const unsubStore = useEditor.subscribe((s, p) => {
      if (s.useProxies !== p.useProxies) poolRef.current?.disposeAll();
      if (s.project !== p.project || s.playhead !== p.playhead || s.activeCompId !== p.activeCompId || s.playing !== p.playing || s.previewScale !== p.previewScale || s.flowEngine !== p.flowEngine || s.useProxies !== p.useProxies) requestDraw();
    });
    const unsubMedia = mediaEngine.subscribe(requestDraw);
    let lastFx = effectRegistry.version;
    const unsubFx = effectRegistry.subscribe(() => {
      // Hot reload: drop compiled programs when plugins change (not on error reports).
      if (effectRegistry.version !== lastFx) rendererRef.current?.purgeEffects();
      lastFx = effectRegistry.version;
      requestDraw();
    });
    document.fonts?.ready.then(() => {
      rendererRef.current?.text.clear();
      requestDraw();
    });
    const onFonts = () => {
      rendererRef.current?.text.clear();
      requestDraw();
    };
    document.fonts?.addEventListener?.('loadingdone', onFonts);
    requestDraw();
    return () => {
      unsubStore();
      unsubMedia();
      unsubFx();
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      poolRef.current?.disposeAll();
      interpRef.current?.dispose();
      frames.dispose();
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [draw, requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [effectiveScale, requestDraw]);

  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (zoomMode === 'fit') setPan([0, 0]);
  }, [zoomMode]);

  const w = comp.width * zoom;
  const h = comp.height * zoom;
  const left = (stage.w - w) / 2 + pan[0];
  const top = (stage.h - h) / 2 + pan[1];

  // --------------------------------------------------------------- interaction
  const toComp = (clientX: number, clientY: number): [number, number] => {
    const rect = stageRef.current!.getBoundingClientRect();
    return [(clientX - rect.left - left) / zoom, (clientY - rect.top - top) / zoom];
  };

  /** Rendered items of the selected layers at the playhead (for hit tests and handles). */
  const selectedItems = (): RenderItem[] => {
    const s = editor();
    const c = activeComp(s);
    const m = (spec: Parameters<typeof approximateTextMeasure>[0]) => (rendererRef.current ? rendererRef.current.text.measure(spec) : approximateTextMeasure(spec));
    return s.selectedLayers
      .map((id) => c.layers.find((l) => l.id === id))
      .filter((l): l is NonNullable<typeof l> => !!l && !l.locked && isLayerActive(l, s.playhead) && l.visible)
      .map((l) => evaluateLayer(s.project, c, l, s.playhead, { measureText: m }))
      .filter((it): it is RenderItem => !!it);
  };

  /** Topmost layer under (x, y) in comp space. `tol` grows every quad (comp px) so small layers are easy to hit with a finger. */
  const hitTest = (x: number, y: number, tol = 0): RenderItem | null => {
    const frame = frameRef.current;
    if (!frame) return null;
    const s = editor();
    const c = activeComp(s);
    // The selected layer wins when layers overlap, so you can keep dragging what you picked.
    for (const it of selectedItems()) if (pointInQuad(x, y, growQuad(itemCorners(it), tol))) return it;
    for (let i = frame.items.length - 1; i >= 0; i--) {
      const it = frame.items[i];
      const layer = c.layers.find((l) => l.id === it.layerId);
      if (!layer || layer.locked) continue;
      if (pointInQuad(x, y, growQuad(itemCorners(it), tol))) return it;
    }
    return null;
  };

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef(0);
  const gestureRef = useRef<{ end: () => void; pinch?: (a: { x: number; y: number }, b: { x: number; y: number }) => void } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey && zoomMode !== 'fit')) {
      // Pan
      const start = [e.clientX, e.clientY, pan[0], pan[1]];
      const move = (ev: PointerEvent) => setPan([start[2] + ev.clientX - start[0], start[3] + ev.clientY - start[1]]);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    const touch = e.pointerType === 'touch';
    const pts = pointers.current;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Second finger: switch to pinch (scale + rotate the selection, or zoom the view).
    if (pts.size === 2) {
      startPinch();
      return;
    }
    if (pts.size > 2) return;

    const [x, y] = toComp(e.clientX, e.clientY);
    const s = editor();
    const snapOn = () => editor().snapping;

    // 1. Corner handle of a single selected layer: drag to scale around its anchor.
    const sel = selectedItems();
    if (sel.length === 1 && !e.shiftKey) {
      const it = sel[0];
      const reach = (touch ? 30 : 9) / zoom;
      const corner = itemCorners(it).find(([cx, cy]) => Math.hypot(cx - x, cy - y) < reach);
      const layer = activeComp(s).layers.find((l) => l.id === it.layerId);
      if (corner && layer?.props['transform.scale']) {
        const anchor = apply(it.matrix, ...(anchorOf(it) as [number, number]));
        const d0 = Math.max(1e-3, Math.hypot(x - anchor[0], y - anchor[1]));
        const s0 = evaluateProp(layer.props['transform.scale'], s.playhead - layer.startTime) as Vec2;
        let began = false;
        let snapped = false;
        track(e.pointerId, {
          move: (ev) => {
            const [px, py] = toComp(ev.clientX, ev.clientY);
            let f = Math.hypot(px - anchor[0], py - anchor[1]) / d0;
            if (!began) {
              began = true;
              editor().beginGesture('Scale Layer');
            }
            const pct = s0[0] * f;
            const near = snapOn() && Math.abs(pct - 100) < 4;
            if (near) f = 100 / s0[0];
            if (near && !snapped) haptic('tick');
            snapped = near;
            editor().setProp(layer.id, 'transform.scale', [round1(s0[0] * f), round1(s0[1] * f)]);
            setHud(`Scale ${Math.round(s0[0] * f)}%`);
          },
          up: () => {
            if (began) editor().endGesture();
            setHud(null);
          },
        });
        return;
      }
    }

    // 2. A layer under the finger (generous on touch).
    const hit = hitTest(x, y, (touch ? 18 : 0) / zoom);
    if (!hit) {
      if (!touch && !e.shiftKey) s.selectLayer(null);
      // Touch: a tap on empty space deselects; a drag pans a zoomed-in view.
      const p0 = [e.clientX, e.clientY, pan[0], pan[1]];
      let moved = false;
      track(e.pointerId, {
        move: (ev) => {
          if (Math.hypot(ev.clientX - p0[0], ev.clientY - p0[1]) > 6) moved = true;
          if (moved && zoomMode !== 'fit') setPan([p0[2] + ev.clientX - p0[0], p0[3] + ev.clientY - p0[1]]);
        },
        up: (ev) => {
          if (moved || ev.type !== 'pointerup') return;
          if (touch) editor().selectLayer(null);
          // Double-tap empty space: back to a fitted, centred preview.
          const now = performance.now();
          if (now - lastTap.current < 320) {
            setZoomMode('fit');
            setPan([0, 0]);
          }
          lastTap.current = now;
        },
      });
      return;
    }
    let ids = s.selectedLayers;
    if (e.shiftKey) {
      s.selectLayer(hit.layerId, 'toggle');
      return;
    }
    if (!ids.includes(hit.layerId)) {
      s.selectLayer(hit.layerId);
      if (touch) haptic('select');
      ids = [hit.layerId];
    }

    // 3. Move the selected layers' positions (in each layer's parent space), snapping to the frame's centre and edges.
    const c = activeComp(s);
    const t = s.playhead;
    const targets = ids
      .map((id) => c.layers.find((l) => l.id === id))
      .filter((l): l is NonNullable<typeof l> => !!l && !l.locked && !!l.props['transform.position'])
      .map((l) => {
        const parent = l.parentId ? c.layers.find((p) => p.id === l.parentId) : null;
        const inv = parent ? invert(worldMatrix(c, parent, t)) : null;
        return { id: l.id, start: evaluateProp(l.props['transform.position'], t - l.startTime) as Vec2, inv };
      });
    if (targets.length === 0) return;
    const box = boundsOf(selectedItems().filter((it) => ids.includes(it.layerId)));
    const sx = x;
    const sy = y;
    let began = false;
    let lastGuide = '';
    track(e.pointerId, {
      move: (ev) => {
        const [cx0, cy0] = toComp(ev.clientX, ev.clientY);
        let dx = cx0 - sx;
        let dy = cy0 - sy;
        if (!began && Math.hypot(dx, dy) * zoom < (touch ? 8 : 3)) return;
        if (!began) {
          began = true;
          editor().beginGesture('Move Layer');
        }
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const g: Guides = { v: [], h: [] };
        if (box && snapOn() !== (ev.ctrlKey || ev.metaKey)) {
          const reach = (touch ? 14 : 7) / zoom;
          const sxr = snapAxis([box[0] + dx, (box[0] + box[2]) / 2 + dx, box[2] + dx], [0, c.width / 2, c.width], reach);
          const syr = snapAxis([box[1] + dy, (box[1] + box[3]) / 2 + dy, box[3] + dy], [0, c.height / 2, c.height], reach);
          if (sxr) {
            dx += sxr.d;
            g.v.push(sxr.line);
          }
          if (syr) {
            dy += syr.d;
            g.h.push(syr.line);
          }
        }
        const key = g.v.join() + '|' + g.h.join();
        if (key !== lastGuide && key !== '|') haptic('tick');
        lastGuide = key;
        setGuides(g.v.length || g.h.length ? g : null);
        for (const tg of targets) {
          let d: [number, number] = [dx, dy];
          if (tg.inv) {
            const o = apply(tg.inv, 0, 0);
            const p = apply(tg.inv, dx, dy);
            d = [p[0] - o[0], p[1] - o[1]];
          }
          editor().setProp(tg.id, 'transform.position', [round1(tg.start[0] + d[0]), round1(tg.start[1] + d[1])]);
        }
      },
      up: () => {
        if (began) editor().endGesture();
        setGuides(null);
      },
    });
  };

  /** Follow one pointer until it lifts; a second finger hands over to the pinch gesture. */
  const track = (id: number, h: { move: (ev: PointerEvent) => void; up?: (ev: PointerEvent) => void }) => {
    let pinching = false;
    const move = (ev: PointerEvent) => {
      const pts = pointers.current;
      if (pts.has(ev.pointerId)) pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pts.size >= 2) {
        pinching = true;
        const [a, b] = [...pts.values()];
        gestureRef.current?.pinch?.(a, b);
        return;
      }
      if (ev.pointerId === id && !pinching) h.move(ev);
    };
    const up = (ev: PointerEvent) => {
      pointers.current.delete(ev.pointerId);
      if (pointers.current.size > 0) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      gestureRef.current?.end();
      gestureRef.current = null;
      h.up?.(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** Two fingers: scale/rotate/move the selected layers, or zoom the view when nothing is selected. */
  const startPinch = () => {
    const [a0, b0] = [...pointers.current.values()];
    const d0 = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
    const ang0 = Math.atan2(b0.y - a0.y, b0.x - a0.x);
    const mid0 = toComp((a0.x + b0.x) / 2, (a0.y + b0.y) / 2);
    const s = editor();
    const c = activeComp(s);
    const t = s.playhead;
    const layers = c.layers.filter((l) => s.selectedLayers.includes(l.id) && !l.locked);
    setGuides(null);
    if (!layers.length) {
      const zoom0 = zoom;
      const pan0 = pan;
      gestureRef.current = {
        pinch: (a, b) => {
          const f = Math.hypot(b.x - a.x, b.y - a.y) / d0;
          setZoomMode(Math.max(0.05, Math.min(8, zoom0 * f)));
          setPan([pan0[0] + ((a.x + b.x) / 2 - (a0.x + b0.x) / 2), pan0[1] + ((a.y + b.y) / 2 - (a0.y + b0.y) / 2)]);
        },
        end: () => undefined,
      };
      return;
    }
    const base = layers.map((l) => {
      const lt = t - l.startTime;
      const parent = l.parentId ? c.layers.find((p) => p.id === l.parentId) : null;
      return {
        id: l.id,
        scale: l.props['transform.scale'] ? (evaluateProp(l.props['transform.scale'], lt) as Vec2) : null,
        rot: l.props['transform.rotation'] ? (evaluateProp(l.props['transform.rotation'], lt) as number) : null,
        pos: l.props['transform.position'] ? (evaluateProp(l.props['transform.position'], lt) as Vec2) : null,
        inv: parent ? invert(worldMatrix(c, parent, t)) : null,
      };
    });
    let began = false;
    let snapKey = '';
    gestureRef.current = {
      pinch: (a, b) => {
        if (!began) {
          began = true;
          editor().beginGesture('Transform Layer');
        }
        let f = Math.hypot(b.x - a.x, b.y - a.y) / d0;
        let rot = ((Math.atan2(b.y - a.y, b.x - a.x) - ang0) * 180) / Math.PI;
        const mid = toComp((a.x + b.x) / 2, (a.y + b.y) / 2);
        const snapping = editor().snapping;
        const first = base[0];
        // Snap scale to 100% and rotation to the nearest quarter turn when close.
        let key = '';
        if (snapping && first.scale && Math.abs(first.scale[0] * f - 100) < 5) {
          f = 100 / first.scale[0];
          key += 's';
        }
        if (snapping && first.rot !== null) {
          const total = first.rot + rot;
          const q = Math.round(total / 90) * 90;
          if (Math.abs(total - q) < 6) {
            rot = q - first.rot;
            key += 'r';
          }
        }
        if (key && key !== snapKey) haptic('tick');
        snapKey = key;
        const dx = mid[0] - mid0[0];
        const dy = mid[1] - mid0[1];
        for (const bl of base) {
          if (bl.scale) editor().setProp(bl.id, 'transform.scale', [round1(bl.scale[0] * f), round1(bl.scale[1] * f)]);
          if (bl.rot !== null) editor().setProp(bl.id, 'transform.rotation', round1(bl.rot + rot));
          if (bl.pos) {
            let d: [number, number] = [dx, dy];
            if (bl.inv) {
              const o = apply(bl.inv, 0, 0);
              const p = apply(bl.inv, dx, dy);
              d = [p[0] - o[0], p[1] - o[1]];
            }
            editor().setProp(bl.id, 'transform.position', [round1(bl.pos[0] + d[0]), round1(bl.pos[1] + d[1])]);
          }
        }
        const sc = first.scale ? `${Math.round(first.scale[0] * f)}%` : '';
        const rr = first.rot !== null ? `${Math.round(first.rot + rot)}°` : '';
        setHud([sc, rr].filter(Boolean).join(' · '));
      },
      end: () => {
        if (began) editor().endGesture();
        setHud(null);
      },
    };
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.002);
      setZoomMode(Math.max(0.05, Math.min(8, zoom * factor)));
    } else if (zoomMode !== 'fit') {
      setPan(([px, py]) => [px - e.deltaX, py - e.deltaY]);
    }
  };

  // Selection overlay, evaluated directly so it never lags the picture.
  const project = useEditor((s) => s.project);
  const measure = (spec: Parameters<typeof approximateTextMeasure>[0]) => (rendererRef.current ? rendererRef.current.text.measure(spec) : approximateTextMeasure(spec));
  const selItems = selectedLayers
    .map((id) => comp.layers.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => !!l && isLayerActive(l, playhead) && l.visible)
    .map((l) => evaluateLayer(project, comp, l, playhead, { measureText: measure }))
    .filter((it): it is RenderItem => !!it);

  // Motion paths for selected layers with animated position.
  const motionPaths = selectedLayers
    .map((id) => comp.layers.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => !!l && (l.props['transform.position']?.keyframes.length ?? 0) > 1)
    .map((l) => {
      const keys = l.props['transform.position'].keyframes;
      const a = l.startTime + keys[0].time;
      const b = l.startTime + keys[keys.length - 1].time;
      const step = Math.max(1 / comp.fps, (b - a) / 300);
      const at = (t: number) => {
        const lt = t - l.startTime;
        const anchor = evaluateProp(l.props['transform.anchor'], lt) as Vec2;
        return apply(worldMatrix(comp, l, t), anchor[0], anchor[1]);
      };
      const pts: string[] = [];
      for (let t = a; t <= b + 1e-9; t += step) pts.push(at(t).map((v) => v.toFixed(1)).join(','));
      return { id: l.id, points: pts.join(' '), keys: keys.map((k) => at(l.startTime + k.time)) };
    });

  return (
    <div className="viewer">
      <div className="viewer-stage" ref={stageRef} onPointerDown={onPointerDown} onWheel={onWheel}>
        <div className="viewer-canvas-wrap" style={{ left, top, width: w, height: h }}>
          <canvas ref={canvasRef} />
        </div>
        <svg className="viewer-overlay" style={{ pointerEvents: 'none' }} width={stage.w} height={stage.h}>
          <g transform={`translate(${left} ${top}) scale(${zoom})`}>
            {safeZones && <SafeZones w={comp.width} h={comp.height} zoom={zoom} />}
            {motionPaths.map((mp) => (
              <g key={'mp' + mp.id}>
                <polyline points={mp.points} fill="none" stroke="#ffcf3d" strokeOpacity="0.8" strokeWidth={1.2 / zoom} strokeDasharray={`${3 / zoom} ${3 / zoom}`} />
                {mp.keys.map(([x, y], i) => (
                  <rect key={i} x={x - 3 / zoom} y={y - 3 / zoom} width={6 / zoom} height={6 / zoom} fill="#ffcf3d" transform={`rotate(45 ${x} ${y})`} />
                ))}
              </g>
            ))}
            {guides &&
              guides.v.map((gx) => <line key={'gv' + gx} className="snap-guide" x1={gx} y1={-2000} x2={gx} y2={comp.height + 2000} strokeWidth={1.5 / zoom} />)}
            {guides &&
              guides.h.map((gy) => <line key={'gh' + gy} className="snap-guide" x1={-2000} y1={gy} x2={comp.width + 2000} y2={gy} strokeWidth={1.5 / zoom} />)}
            {selItems.map((it) => {
              const q = itemCorners(it);
              const anchor = apply(it.matrix, ...(anchorOf(it) as [number, number]));
              return (
                <g key={it.layerId}>
                  <polygon
                    points={q.map((p) => p.join(',')).join(' ')}
                    fill="none"
                    stroke="#7c5cff"
                    strokeWidth={1.5 / zoom}
                  />
                  {q.map((p, i) =>
                    coarse ? (
                      <circle key={i} cx={p[0]} cy={p[1]} r={9 / zoom} fill="#fff" stroke="#7c5cff" strokeWidth={2 / zoom} />
                    ) : (
                      <rect key={i} x={p[0] - 3.5 / zoom} y={p[1] - 3.5 / zoom} width={7 / zoom} height={7 / zoom} fill="#fff" stroke="#7c5cff" strokeWidth={1 / zoom} />
                    ),
                  )}
                  <circle cx={anchor[0]} cy={anchor[1]} r={5 / zoom} fill="none" stroke="#fff" strokeWidth={1.2 / zoom} />
                  <path
                    d={`M${anchor[0] - 8 / zoom} ${anchor[1]}h${16 / zoom}M${anchor[0]} ${anchor[1] - 8 / zoom}v${16 / zoom}`}
                    stroke="#fff"
                    strokeWidth={1 / zoom}
                  />
                </g>
              );
            })}
          </g>
        </svg>
        {hud && <div className="viewer-hud">{hud}</div>}
        {error && (
          <div className="viewer-empty">
            <div>
              <b>Preview unavailable</b>
              <div className="hint">{error}</div>
            </div>
          </div>
        )}
        {!error && comp.layers.length === 0 && (
          <div className="viewer-empty empty-comp">
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Drop clips, images or a track here</div>
              <div className="hint" style={{ marginTop: 4 }}>
                or add a Text / Shape layer from the left panel · <kbd>?</kbd> for shortcuts
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="viewer-bar">
        <span className="timecode">{formatTimecode(playhead, comp.fps)}</span>
        <span className="hint">
          {comp.width}×{comp.height} · {comp.fps}fps
        </span>
        <span className="grow" />
        <select
          value={zoomMode === 'fit' ? 'fit' : String(zoomMode)}
          onChange={(e) => setZoomMode(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
          title="Viewer zoom (Ctrl+wheel)"
        >
          <option value="fit">Fit</option>
          {[0.25, 0.5, 1, 2].map((z) => (
            <option key={z} value={z}>
              {z * 100}%
            </option>
          ))}
          {zoomMode !== 'fit' && ![0.25, 0.5, 1, 2].includes(zoomMode) && <option value={zoomMode}>{Math.round(zoomMode * 100)}%</option>}
        </select>
        <select
          value={previewScale}
          onChange={(e) => useEditor.getState().set('previewScale', Number(e.target.value))}
          title="Preview resolution"
        >
          <option value={0}>Auto res</option>
          <option value={1}>Full</option>
          <option value={0.5}>Half</option>
          <option value={0.25}>Quarter</option>
        </select>
        <RamPreviewButton scale={effectiveScale} />
        <button className={'icon' + (useProxies ? ' on' : '')} title="Play proxies (low-res transcodes) when available — create them from a clip's context menu" onClick={() => useEditor.getState().set('useProxies', !useProxies)}>
          Proxy
        </button>
        <button className={'icon' + (safeZones ? ' on' : '')} title="Short-form safe zones (TikTok / Reels / Shorts UI)" onClick={() => useEditor.getState().set('safeZones', !safeZones)}>
          ▣
        </button>
        <span className="stats" title="Render time · display fps · render scale">
          {stats.ms.toFixed(1)}ms · {Math.round(stats.fps)}fps · {Math.round(stats.scale * 100)}%
        </span>
      </div>
    </div>
  );
}

/** Render the work area to RAM for guaranteed real-time playback. */
function RamPreviewButton({ scale }: { scale: number }) {
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cached = useSyncExternalStore(
    (fn) => frameCache.subscribe(fn),
    () => frameCache.count,
  );
  const run = async () => {
    if (abortRef.current) {
      abortRef.current.abort();
      return;
    }
    const s = editor();
    if (s.playing) s.pause();
    const ac = new AbortController();
    abortRef.current = ac;
    setProgress(0);
    try {
      const n = await cacheWorkArea(s.project, s.activeCompId, scale, mediaEngine, setProgress, ac.signal, s.flowEngine);
      if (!ac.signal.aborted) editor().toast(`RAM preview: ${n} frames cached — press Space`, 'success');
    } catch (err) {
      editor().toast(`RAM preview failed: ${(err as Error).message}`, 'error');
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  };
  return (
    <button
      className={'icon' + (progress !== null ? ' on' : '')}
      title={progress !== null ? 'Click to stop' : `Render the work area to RAM (${cached} frames cached)`}
      onClick={run}
      onContextMenu={(e) => {
        e.preventDefault();
        frameCache.clear();
      }}
    >
      {progress !== null ? `RAM ${Math.round(progress * 100)}%` : cached ? `RAM ✓${cached}` : 'RAM'}
    </button>
  );
}

function anchorOf(it: RenderItem): [number, number] {
  // Anchor is where the layer's own origin-relative anchor sits; read it back
  // from the layer model through the store for accuracy.
  const s = editor();
  const l = activeComp(s).layers.find((x) => x.id === it.layerId);
  const a = l?.props['transform.anchor'];
  if (!l || !a) return [0, 0];
  return evaluateProp(a, s.playhead - l.startTime) as [number, number];
}

/**
 * Approximate UI-safe areas shared by TikTok, Reels and Shorts in a 9:16
 * frame: top status/tabs, right action rail, bottom caption + nav.
 */
function SafeZones({ w, h, zoom }: { w: number; h: number; zoom: number }) {
  const zones = [
    { x: 0, y: 0, w: w, h: h * 0.09, label: 'Top bar' },
    { x: w * 0.86, y: h * 0.38, w: w * 0.14, h: h * 0.44, label: 'Actions' },
    { x: 0, y: h * 0.8, w: w, h: h * 0.2, label: 'Caption / nav' },
  ];
  return (
    <g>
      <defs>
        <pattern id="hatch" width={10 / zoom} height={10 / zoom} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={10 / zoom} stroke="#ff3d7f" strokeWidth={2 / zoom} strokeOpacity="0.35" />
        </pattern>
      </defs>
      {zones.map((z) => (
        <g key={z.label}>
          <rect x={z.x} y={z.y} width={z.w} height={z.h} fill="url(#hatch)" stroke="#ff3d7f" strokeOpacity="0.6" strokeWidth={1 / zoom} />
          <text x={z.x + 6 / zoom} y={z.y + 14 / zoom} fill="#ff9dbf" fontSize={11 / zoom} fontFamily="Inter, sans-serif">
            {z.label}
          </text>
        </g>
      ))}
      <rect x={w * 0.06} y={h * 0.09} width={w * 0.8} height={h * 0.71} fill="none" stroke="#c8ff3d" strokeDasharray={`${6 / zoom} ${4 / zoom}`} strokeWidth={1 / zoom} strokeOpacity="0.7" />
    </g>
  );
}
