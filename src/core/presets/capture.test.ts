import { describe, expect, it } from 'vitest';
import { registerBuiltinEffects } from '../../effects';
import { evaluateProp } from '../animation/interpolate';
import { applyEasing, makeKeyframe } from '../animation/keyframes';
import { effectRegistry, fxPath, instantiateEffect } from '../effects/registry';
import { createProject, createShapeLayer } from '../model/factory';
import type { AnimProp, Vec2 } from '../model/types';
import { applyPresetToLayer, type PresetContext } from './apply';
import { hasCapturableAnimation, presetFromLayer } from './capture';
import { validatePreset } from './types';

registerBuiltinEffects();

function setup() {
  const project = createProject();
  const comp = project.compositions[project.mainCompId];
  const src = createShapeLayer({ comp });
  const dst = createShapeLayer({ comp });
  comp.layers = [src, dst];
  const ctx: PresetContext = { comp, playhead: 4, beat: 0.5, media: {}, plugin: (id) => effectRegistry.get(id)?.plugin };
  return { comp, src, dst, ctx };
}

describe('save layer animation as preset', () => {
  it('round-trips keyframes, eases, curves and effects', () => {
    const { comp, src, dst, ctx } = setup();
    expect(hasCapturableAnimation(src)).toBe(false);
    // Scale punch with an expo ease and an elastic settle; position moves 200 px.
    let scale: AnimProp = { value: [100, 100], keyframes: [makeKeyframe(1, [100, 100]), makeKeyframe(1.3, [140, 140]), makeKeyframe(2, [100, 100])] };
    scale = applyEasing(scale, new Set([scale.keyframes[0].id]), 'expo-out');
    scale = applyEasing(scale, new Set([scale.keyframes[1].id]), 'elastic-out');
    src.props['transform.scale'] = scale;
    src.props['transform.position'] = { value: [540, 960], keyframes: [makeKeyframe(1, [540, 960]), makeKeyframe(2, [740, 960])] };
    const glow = instantiateEffect(effectRegistry.get('luscent.glow')!.plugin, comp);
    src.effects = [glow.instance];
    Object.assign(src.props, glow.props);
    src.props[fxPath(glow.instance.id, 'radius')] = { value: 10, keyframes: [makeKeyframe(1, 10), makeKeyframe(2, 50)] };
    expect(hasCapturableAnimation(src)).toBe(true);

    const preset = presetFromLayer(src, { name: 'My Punch' });
    expect(validatePreset(preset)).toEqual([]);
    expect(preset.duration).toBe(1);
    expect(preset.props!['transform.position'].mode).toBe('relative');
    // Survives JSON (export/import).
    const loaded = JSON.parse(JSON.stringify(preset));

    dst.props['transform.position'] = { value: [100, 100], keyframes: [] };
    const r = applyPresetToLayer(dst, loaded, ctx);
    expect(r.skipped).toEqual([]);
    const s = (l: typeof src, t: number) => (evaluateProp(l.props['transform.scale'], t) as Vec2)[0];
    for (const x of [0, 0.05, 0.15, 0.3, 0.5, 0.7, 1]) expect(s(dst, 4 + x)).toBeCloseTo(s(src, 1 + x), 4);
    expect(dst.props['transform.scale'].keyframes[1].outCurve).toBe('elastic-out');
    const p = (t: number) => evaluateProp(dst.props['transform.position'], t) as Vec2;
    expect(p(4)).toEqual([100, 100]);
    expect(p(5)[0]).toBeCloseTo(300);
    const fx = dst.effects!.find((e) => e.pluginId === 'luscent.glow')!;
    expect(evaluateProp(dst.props[fxPath(fx.id, 'radius')], 5)).toBeCloseTo(50);
  });
});

describe('preset files', () => {
  it('parses single presets, arrays and bundles', async () => {
    const { parsePresetJSON, PRESET_BUNDLE_FORMAT } = await import('../../state/presetLibrary');
    const { BUILTIN_PRESETS } = await import('../../presets/builtin');
    const two = BUILTIN_PRESETS.slice(0, 2);
    expect(parsePresetJSON(JSON.stringify(two[0])).map((p) => p.id)).toEqual([two[0].id]);
    expect(parsePresetJSON(JSON.stringify(two)).length).toBe(2);
    expect(parsePresetJSON(JSON.stringify({ format: PRESET_BUNDLE_FORMAT, version: 1, presets: two })).length).toBe(2);
    expect(() => parsePresetJSON('{"format":"nope"}')).toThrow(/format/);
  });
});

describe('documented example', () => {
  it('the preset in docs/PRESETS.md is valid and applies', async () => {
    const { readFileSync } = await import('node:fs');
    const md = readFileSync(new URL('../../../docs/PRESETS.md', import.meta.url), 'utf8');
    const json = /```json\n([\s\S]*?)```/.exec(md)![1];
    const preset = JSON.parse(json);
    expect(validatePreset(preset)).toEqual([]);
    const { dst, ctx } = setup();
    const r = applyPresetToLayer(dst, preset, ctx);
    expect(r.skipped).toEqual([]);
    expect(r.applied.length).toBe(4);
    const s = (t: number) => (evaluateProp(dst.props['transform.scale'], t) as Vec2)[0];
    expect(s(4.25)).toBeCloseTo(130);
    expect(dst.props['transform.rotation'].wiggle?.amp).toBe(3);
  });
});
