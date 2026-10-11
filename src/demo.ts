/**
 * Starter project shown on first launch (no media required) so the preview,
 * keyframes and timeline have something punchy to show immediately.
 */
import { EASY_EASE, makeKeyframe } from './core/animation/keyframes';
import { createProject, createShapeLayer, createSolidLayer, createTextLayer } from './core/model/factory';
import { uid } from './core/model/ids';
import type { Keyframe, PropValue, Vec2 } from './core/model/types';
import { editor } from './state/store';

function eased<T extends PropValue>(time: number, value: T): Keyframe<T> {
  const k = makeKeyframe(time, value, 'bezier');
  k.inEase = { ...EASY_EASE };
  k.outEase = { ...EASY_EASE };
  return k;
}

export function seedDemo(): void {
  const project = createProject('Luscent Demo');
  const comp = project.compositions[project.mainCompId];
  comp.name = 'Hook 9:16';
  comp.duration = 6;
  comp.workArea = { start: 0, end: 6 };
  const cx = comp.width / 2;
  const cy = comp.height / 2;

  const bg = createSolidLayer({ comp, name: 'Background', color: [0.07, 0.05, 0.14, 1] });

  const blob = createShapeLayer({ comp, name: 'Glow Orb', shape: 'ellipse', size: [900, 900], fill: [0.49, 0.36, 1, 0.55] });
  blob.props['transform.position'] = {
    value: [cx, cy],
    keyframes: [eased<Vec2>(0, [cx - 260, cy - 420]), eased<Vec2>(3, [cx + 240, cy + 380]), eased<Vec2>(6, [cx - 260, cy - 420])],
  };
  blob.blendMode = 'screen';

  const bar = createShapeLayer({ comp, name: 'Accent Bar', shape: 'rect', size: [760, 26], fill: [1, 0.24, 0.5, 1] });
  bar.props['content.roundness'].value = 13;
  bar.props['transform.position'].value = [cx, cy + 150];
  bar.props['transform.scale'] = { value: [100, 100], keyframes: [eased<Vec2>(0.3, [0, 100]), eased<Vec2>(0.8, [100, 100])] };

  const title = createTextLayer({ comp, text: 'LUSCENT', fontSize: 210, inPoint: 0 });
  title.name = 'Title';
  title.props['transform.position'].value = [cx, cy + 60];
  // Zoom punch: overshoot then settle, the staple of short-form hooks.
  title.props['transform.scale'] = {
    value: [100, 100],
    keyframes: [eased<Vec2>(0, [60, 60]), { ...makeKeyframe<Vec2>(0.2, [118, 118], 'bezier'), inEase: { speed: 0, influence: 0.5 }, outEase: { speed: 0, influence: 0.7 } }, eased<Vec2>(0.6, [100, 100])],
  };
  title.props['transform.opacity'] = { value: 100, keyframes: [makeKeyframe(0, 0), makeKeyframe(0.12, 100)] };

  const sub = createTextLayer({ comp, text: 'cut on the beat.', fontSize: 72, inPoint: 1 });
  sub.name = 'Subtitle';
  sub.fontWeight = 600;
  sub.props['transform.position'].value = [cx, cy + 260];
  sub.props['content.fill'].value = [0.78, 1, 0.24, 1];
  sub.props['transform.opacity'] = { value: 100, keyframes: [eased(0, 0), eased(0.4, 100)] };
  sub.props['content.tracking'] = { value: 0, keyframes: [eased(0, 400), eased(0.8, 40)] };

  const flash = createSolidLayer({ comp, name: 'Flash', color: [1, 1, 1, 1], inPoint: 3, outPoint: 3 + 6 / comp.fps });
  flash.blendMode = 'add';
  flash.startTime = 3;
  flash.props['transform.opacity'] = { value: 0, keyframes: [makeKeyframe(0, 90), eased(5 / comp.fps, 0)] };

  comp.layers = [flash, sub, title, bar, blob, bg];
  comp.markers = [
    { id: uid('mk_'), time: 1, duration: 0, label: 'hook', color: 0 },
    { id: uid('mk_'), time: 3, duration: 0, label: 'drop', color: 0 },
  ];
  editor().loadProject(project);
}
