import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { frameCache } from '../../engine/cache/FrameCache';
import { compBeatTimes } from '../../core/timeline/snap';
import { formatTimecode } from '../../core/time';
import { activeComp, editor, useEditor } from '../../state/store';
import { scrubAudio } from '../../engine/playback/Transport';
import { ContextMenu, type MenuItem } from '../components/fields';
import { makeSnapper, startDrag } from './drag';
import { useTimelineUI } from './uiState';
import type { Marker } from '../../core/model/types';

const RULER_H = 30;

/** Pick a label interval (seconds) so labels sit ≥ ~70px apart. */
export function tickStep(pxPerSec: number, fps: number): { major: number; minor: number } {
  const f = 1 / fps;
  const cands = [f, 2 * f, 5 * f, 10 * f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = cands.find((c) => c * pxPerSec >= 70) ?? 600;
  const minor = major <= f ? f : major <= 10 * f ? f : major / 5;
  return { major, minor };
}

export function Ruler({ width }: { width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const comp = useEditor(activeComp);
  const project = useEditor((s) => s.project);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const scrollTime = useEditor((s) => s.scrollTime);
  const playhead = useEditor((s) => s.playhead);
  const beatSnap = useEditor((s) => s.beatSnap);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const beats = useMemo(() => compBeatTimes(project, comp), [project, comp]);
  const xOf = (t: number) => (t - scrollTime) * pxPerSec;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(width * dpr);
    c.height = RULER_H * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${RULER_H}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, RULER_H);
    // Out-of-comp region.
    const endX = (comp.duration - scrollTime) * pxPerSec;
    if (endX < width) {
      ctx.fillStyle = '#0c0d11';
      ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), RULER_H);
    }
    const { major, minor } = tickStep(pxPerSec, comp.fps);
    const t0 = Math.max(0, Math.floor(scrollTime / minor) * minor);
    const t1 = Math.min(comp.duration, scrollTime + width / pxPerSec);
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'top';
    const steps = Math.round((t1 - t0) / minor) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = t0 + i * minor;
      if (t > t1 + 1e-9) break;
      const x = Math.round((t - scrollTime) * pxPerSec) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? '#4a5060' : '#2c303b';
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 12 : 20);
      ctx.lineTo(x, RULER_H - 8);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#8a90a2';
        ctx.fillText(formatTimecode(t, comp.fps), x + 3, 2);
      }
    }
    // Beat ticks along the bottom edge.
    if (beats.length) {
      ctx.fillStyle = beatSnap ? '#c8ff3d' : '#6b7a3d';
      beats.forEach((b, i) => {
        const x = (b - scrollTime) * pxPerSec;
        if (x < -2 || x > width + 2) return;
        const strong = i % 4 === 0;
        ctx.fillRect(Math.round(x) - (strong ? 1 : 0.5), RULER_H - (strong ? 8 : 5), strong ? 2 : 1, strong ? 8 : 5);
      });
    }
  }, [width, comp.duration, comp.fps, pxPerSec, scrollTime, beats, beatSnap]);

  const tAt = (clientX: number, el: HTMLElement) => scrollTime + (clientX - el.getBoundingClientRect().left) / pxPerSec;

  const onScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const s = editor();
    if (s.playing) s.pause();
    const snap = makeSnapper({ playhead: false });
    const go = (clientX: number, ev?: PointerEvent) => {
      const raw = tAt(clientX, el);
      const t = snap.time(raw, ev);
      editor().setPlayhead(t);
      scrubAudio(editor().playhead);
    };
    go(e.clientX);
    startDrag(e, { threshold: 0, autoScroll: true, move: (_dx, _dy, ev) => go(ev.clientX, ev) });
  };

  const dragMarker = (e: React.PointerEvent, m: Marker) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const base = editor().project;
    const compId = comp.id;
    const snap = makeSnapper();
    let began = false;
    startDrag(e, {
      move: (dx, _dy, ev) => {
        if (!began) {
          editor().beginGesture('Move Marker');
          began = true;
        }
        const t = Math.max(0, Math.min(comp.duration, snap.time(m.time + dx / pxPerSec, ev)));
        editor().editFrom(base, 'Move Marker', (p) => {
          const mk = p.compositions[compId].markers.find((x) => x.id === m.id);
          if (mk) mk.time = t;
          p.compositions[compId].markers.sort((a, b) => a.time - b.time);
        });
      },
      up: (moved) => {
        if (began) editor().endGesture();
        if (!moved) editor().setPlayhead(m.time);
      },
    });
  };

  const dragWorkArea = (e: React.PointerEvent, part: 's' | 'e' | 'both') => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const base = editor().project;
    const { start, end } = comp.workArea;
    const snap = makeSnapper();
    const f = 1 / comp.fps;
    let began = false;
    startDrag(e, {
      move: (dx, _dy, ev) => {
        if (!began) {
          editor().beginGesture('Work Area');
          began = true;
        }
        const dt = dx / pxPerSec;
        let a = start;
        let b = end;
        if (part === 's') a = Math.min(snap.time(start + dt, ev), end - f);
        else if (part === 'e') b = Math.max(snap.time(end + dt, ev), start + f);
        else {
          const d = snap.delta(dt, [start, end], ev);
          const len = end - start;
          a = Math.max(0, Math.min(comp.duration - len, start + d));
          b = a + len;
        }
        a = Math.max(0, a);
        b = Math.min(comp.duration, b);
        editor().editFrom(base, 'Work Area', (p) => {
          p.compositions[comp.id].workArea = { start: a, end: b };
        });
      },
      up: () => {
        if (began) editor().endGesture();
      },
    });
  };

  const markerMenu = (e: React.MouseEvent, m: Marker) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Rename…',
          action: () => {
            const v = window.prompt('Marker label', m.label);
            if (v !== null) editor().updateMarker(m.id, { label: v });
          },
        },
        { label: 'Delete marker', action: () => editor().removeMarker(m.id) },
      ],
    });
  };

  const waX = xOf(comp.workArea.start);
  const waW = (comp.workArea.end - comp.workArea.start) * pxPerSec;
  const isFullWA = comp.workArea.start <= 0 && comp.workArea.end >= comp.duration;

  return (
    <div className="ruler" onPointerDown={onScrub} style={{ height: RULER_H }}>
      <canvas ref={canvasRef} />
      <div
        className="workarea"
        style={{ left: waX, width: Math.max(2, waW), opacity: isFullWA ? 0.45 : 1 }}
        onPointerDown={(e) => dragWorkArea(e, 'both')}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'Extract work area (ripple)', hint: '⌘⇧⌫', action: () => editor().extractWorkArea() },
              { label: 'Reset work area', action: () => editor().setWorkArea(0, comp.duration) },
            ],
          });
        }}
        title="Work area (B / N set start / end at playhead · right-click to extract)"
      >
        <div className="wa-h s" onPointerDown={(e) => dragWorkArea(e, 's')} />
        <div className="wa-h e" onPointerDown={(e) => dragWorkArea(e, 'e')} />
      </div>
      {comp.markers.map((m) => {
        const x = xOf(m.time);
        if (x < -100 || x > width + 10) return null;
        return (
          <div
            key={m.id}
            className="marker"
            style={{ left: x }}
            title={`${m.label || 'Marker'} · ${formatTimecode(m.time, comp.fps)} (drag to move, right-click for options)`}
            onPointerDown={(e) => dragMarker(e, m)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const v = window.prompt('Marker label', m.label);
              if (v !== null) editor().updateMarker(m.id, { label: v });
            }}
            onContextMenu={(e) => markerMenu(e, m)}
          >
            {m.label && <span className="marker-label">{m.label}</span>}
          </div>
        );
      })}
      <CachedBar fps={comp.fps} xOf={xOf} />
      <div className="playhead-head" style={{ left: xOf(playhead) }} />
      <SnapGhost />
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function SnapGhost() {
  const snap = useTimelineUI((s) => s.snap);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const scrollTime = useEditor((s) => s.scrollTime);
  if (!snap) return null;
  return <div className={'snap-line ' + snap.kind} style={{ left: (snap.time - scrollTime) * pxPerSec }} />;
}

/** Green bar over frames held in the RAM preview cache. */
function CachedBar({ fps, xOf }: { fps: number; xOf: (t: number) => number }) {
  useSyncExternalStore(
    (fn) => frameCache.subscribe(fn),
    () => frameCache.count,
  );
  if (frameCache.fps !== fps) return null;
  return (
    <>
      {frameCache.ranges().map(([a, b]) => (
        <div key={a} className="cache-bar" style={{ left: xOf(a / fps), width: Math.max(1, xOf((b + 1) / fps) - xOf(a / fps)) }} />
      ))}
    </>
  );
}
