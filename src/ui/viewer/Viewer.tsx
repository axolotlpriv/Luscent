import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GLRenderer, type SourceProvider } from '../../engine/gl/Renderer';
import { VideoPool } from '../../engine/media/VideoPool';
import { mediaEngine } from '../../engine/media/MediaEngine';
import { effectRegistry } from '../../core/effects/registry';
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

const PAD = 28;

export function Viewer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GLRenderer | null>(null);
  const poolRef = useRef<VideoPool | null>(null);
  const frameRef = useRef<CompFrame | null>(null);
  const rafRef = useRef(0);
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ ms: 0, fps: 0, scale: 1 });
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const fpsRef = useRef({ frames: 0, since: performance.now() });

  const comp = useEditor(activeComp);
  const previewScale = useEditor((s) => s.previewScale);
  const safeZones = useEditor((s) => s.safeZones);
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
    const frame = evaluateComposition(s.project, s.activeCompId, s.playhead, { measureText: (spec) => r.text.measure(spec) });
    if (!frame) return;
    frameRef.current = frame;
    const videos = collectVideoItems(frame);
    pool.sync(
      videos.map((v) => ({ key: v.key, mediaId: v.mediaId, time: v.sourceTime })),
      s.playing,
    );
    const sources: SourceProvider = {
      image: (id) => mediaEngine.image(id),
      video: (key) => pool.frame(key),
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
    poolRef.current = new VideoPool(mediaEngine, requestDraw);
    const unsubStore = useEditor.subscribe((s, p) => {
      if (s.project !== p.project || s.playhead !== p.playhead || s.activeCompId !== p.activeCompId || s.playing !== p.playing || s.previewScale !== p.previewScale) requestDraw();
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

  const hitTest = (x: number, y: number): RenderItem | null => {
    const frame = frameRef.current;
    if (!frame) return null;
    const s = editor();
    const c = activeComp(s);
    for (let i = frame.items.length - 1; i >= 0; i--) {
      const it = frame.items[i];
      const layer = c.layers.find((l) => l.id === it.layerId);
      if (!layer || layer.locked) continue;
      if (pointInQuad(x, y, itemCorners(it))) return it;
    }
    return null;
  };

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
    const [x, y] = toComp(e.clientX, e.clientY);
    const s = editor();
    const hit = hitTest(x, y);
    if (!hit) {
      if (!e.shiftKey) s.selectLayer(null);
      return;
    }
    let ids = s.selectedLayers;
    if (e.shiftKey) {
      s.selectLayer(hit.layerId, 'toggle');
      return;
    }
    if (!ids.includes(hit.layerId)) {
      s.selectLayer(hit.layerId);
      ids = [hit.layerId];
    }
    // Drag-move selected layers' positions (in each layer's parent space).
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
    const sx = x;
    const sy = y;
    let began = false;
    const move = (ev: PointerEvent) => {
      let [cx, cy] = toComp(ev.clientX, ev.clientY);
      let dx = cx - sx;
      let dy = cy - sy;
      if (!began && Math.hypot(dx, dy) * zoom < 3) return;
      if (!began) {
        began = true;
        editor().beginGesture('Move Layer');
      }
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      cx = dx;
      cy = dy;
      for (const tg of targets) {
        let d: [number, number] = [cx, cy];
        if (tg.inv) {
          const o = apply(tg.inv, 0, 0);
          const p = apply(tg.inv, cx, cy);
          d = [p[0] - o[0], p[1] - o[1]];
        }
        editor().setProp(tg.id, 'transform.position', [Math.round((tg.start[0] + d[0]) * 10) / 10, Math.round((tg.start[1] + d[1]) * 10) / 10]);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (began) editor().endGesture();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
                  {q.map((p, i) => (
                    <rect key={i} x={p[0] - 3.5 / zoom} y={p[1] - 3.5 / zoom} width={7 / zoom} height={7 / zoom} fill="#fff" stroke="#7c5cff" strokeWidth={1 / zoom} />
                  ))}
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
        {error && (
          <div className="viewer-empty">
            <div>
              <b>Preview unavailable</b>
              <div className="hint">{error}</div>
            </div>
          </div>
        )}
        {!error && comp.layers.length === 0 && (
          <div className="viewer-empty">
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
