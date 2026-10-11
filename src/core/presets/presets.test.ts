import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS } from '../../presets/builtin';
import { registerBuiltinEffects } from '../../effects';
import { bundledSamples } from '../../effects/bundled';
import { effectRegistry } from '../effects/registry';
import { createMediaLayer, createProject, createShapeLayer, createTextLayer } from '../model/factory';
import { evaluateProp } from '../animation/interpolate';
import { sourceTimeOf } from '../render/evaluate';
import { applyPresetToLayer, buildPresetLayers, compBeat, type PresetContext } from './apply';
import { validatePreset, type LuscentPreset } from './types';
import type { MediaItem, Vec2 } from '../model/types';

registerBuiltinEffects();
effectRegistry.registerMany(bundledSamples({ loaded: 0, skipped: [] }));

const video: MediaItem = { id: 'v', name: 'clip', kind: 'video', mimeType: 'video/mp4', size: 1, width: 1080, height: 1920, duration: 20, fps: 30, hasAudio: false, analysis: null };
const song: MediaItem = { id: 'a', name: 'song', kind: 'audio', mimeType: 'audio/mp3', size: 1, width: 0, height: 0, duration: 60, fps: 0, hasAudio: true, analysis: { bpm: 100, beats: [], onsets: [], confidence: 1 } };

function setup() {
  const project = createProject();
  const comp = project.compositions[project.mainCompId];
  project.media = { v: video, a: song };
  const clip = createMediaLayer({ comp, media: video, startTime: 0 });
  const music = createMediaLayer({ comp, media: song, startTime: 0 });
  const text = createTextLayer({ comp, text: 'HELLO' });
  const shape = createShapeLayer({ comp });
  comp.layers = [text, shape, clip, music];
  const ctx: PresetContext = { comp, playhead: 2, beat: compBeat(comp, project.media), media: project.media, plugin: (id) => effectRegistry.get(id)?.plugin };
  return { project, comp, clip, text, shape, ctx };
}

describe('built-in presets', () => {
  it('ships 50+ valid presets across categories', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(50);
    for (const p of BUILTIN_PRESETS) expect(validatePreset(p), p.id).toEqual([]);
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
    const cats = new Set(BUILTIN_PRESETS.map((p) => p.category));
    for (const c of ['Shake', 'Flash', 'Zoom', 'Velocity', 'Transitions', 'Text', 'Stylize']) expect(cats.has(c)).toBe(true);
  });

  it.each(BUILTIN_PRESETS.map((p) => [p.id, p] as const))('applies %s without errors', (_id, p: LuscentPreset) => {
    const { clip, text, ctx } = setup();
    if (p.target === 'comp') {
      const layers = buildPresetLayers(p, ctx);
      expect(layers.length).toBeGreaterThan(0);
      for (const l of layers) expect(l.inPoint).toBe(2);
    } else {
      const target = p.requires?.includes('text') ? text : p.requires?.includes('video') ? clip : text;
      const r = applyPresetToLayer(target, p, ctx);
      expect(r.skipped, JSON.stringify(r.skipped)).toEqual([]);
      expect(r.applied.length).toBeGreaterThan(0);
    }
  });
});

describe('preset semantics', () => {
  it('scale mode is relative to the current value', () => {
    const { shape, ctx } = setup();
    shape.props['transform.scale'].value = [50, 50];
    applyPresetToLayer(shape, BUILTIN_PRESETS.find((p) => p.id === 'zoom.punch-in')!, ctx);
    const s = (t: number) => evaluateProp(shape.props['transform.scale'], t - shape.startTime) as Vec2;
    expect(s(2)[0]).toBeCloseTo(50);
    expect(s(2.35)[0]).toBeCloseTo(62.5);
    // back-out overshoots past the target.
    let max = 0;
    for (let t = 2; t <= 2.35; t += 0.01) max = Math.max(max, s(t)[0]);
    expect(max).toBeGreaterThan(62.5);
  });

  it('relative position offsets from where the layer is', () => {
    const { text, ctx } = setup();
    const before = text.props['transform.position'].value as Vec2;
    applyPresetToLayer(text, BUILTIN_PRESETS.find((p) => p.id === 'text.slide-up')!, ctx);
    const p0 = evaluateProp(text.props['transform.position'], 2) as Vec2;
    const p1 = evaluateProp(text.props['transform.position'], 2.5) as Vec2;
    expect(p0[1]).toBeCloseTo(before[1] + 120);
    expect(p1[1]).toBeCloseTo(before[1]);
  });

  it('beat-timed presets follow the music tempo', () => {
    const { ctx } = setup();
    expect(ctx.beat).toBeCloseTo(0.6); // 100 BPM
    const [layer] = buildPresetLayers(BUILTIN_PRESETS.find((p) => p.id === 'flash.beat')!, ctx);
    const times = layer.props['transform.opacity'].keyframes.filter((k) => k.value === 70).map((k) => +k.time.toFixed(3));
    expect(times).toEqual([0, 0.6, 1.2, 1.8]);
    expect(layer.outPoint - layer.inPoint).toBeCloseTo(2.4);
  });

  it('speed ramps integrate into time remap', () => {
    const { clip, ctx } = setup();
    applyPresetToLayer(clip, BUILTIN_PRESETS.find((p) => p.id === 'vel.hit')!, ctx);
    expect(clip.timeRemap).toBe(true);
    expect(clip.frameBlending).toBe('optical-flow');
    // Before the ramp: realtime. During: fast, then slow.
    expect(sourceTimeOf(clip, 1).time).toBeCloseTo(1);
    expect(sourceTimeOf(clip, 2.2).speed).toBeGreaterThan(2);
    expect(sourceTimeOf(clip, 2.9).speed).toBeLessThan(0.4);
    expect(sourceTimeOf(clip, 2.0).time).toBeCloseTo(2);
  });

  it('skips presets on unsuitable layers with a reason', () => {
    const { text, ctx } = setup();
    const r = applyPresetToLayer(text, BUILTIN_PRESETS.find((p) => p.id === 'vel.slowmo-25')!, ctx);
    expect(r.skipped[0]).toMatch(/video/);
  });
});
