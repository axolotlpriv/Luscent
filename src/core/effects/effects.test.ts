import { describe, expect, it } from 'vitest';
import { BUILTIN_EFFECTS } from '../../effects/builtin/effects';
import { BUILTIN_TRANSITIONS } from '../../effects/builtin/transitions';
import { registerBuiltinEffects } from '../../effects';
import { effectRegistry, fxPath, instantiateEffect, layerDynamicDefs } from './registry';
import { validatePlugin } from './types';
import { createProject, createShapeLayer, createSolidLayer } from '../model/factory';
import { approximateTextMeasure, evaluateComposition } from '../render/evaluate';
import { makeKeyframe } from '../animation/keyframes';

registerBuiltinEffects();

describe('plugin format', () => {
  it('all built-ins validate', () => {
    for (const p of [...BUILTIN_EFFECTS, ...BUILTIN_TRANSITIONS]) {
      const v = validatePlugin(p);
      expect(v.errors, p.id).toEqual([]);
    }
    expect(BUILTIN_EFFECTS.length + BUILTIN_TRANSITIONS.length).toBeGreaterThanOrEqual(25);
  });

  it('rejects bad plugins with useful errors', () => {
    const v = validatePlugin({ id: 'x y', name: '', kind: 'nope', params: [{ id: 'length', type: 'float', default: 1 }, { id: 'c', type: 'color', default: 1 }] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/id must/);
    expect(v.errors.join(' ')).toMatch(/reserved/);
    expect(v.errors.join(' ')).toMatch(/4 values/);
    expect(v.errors.join(' ')).toMatch(/GLSL passes or a WGSL/);
  });
});

describe('effect instances', () => {
  it('creates params as animatable props and exposes their defs', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const layer = createShapeLayer({ comp });
    const plugin = effectRegistry.get('luscent.chromatic-aberration')!.plugin;
    const { instance, props } = instantiateEffect(plugin, comp);
    layer.effects = [instance];
    Object.assign(layer.props, props);
    // point default [0.5, 0.5] stored in comp pixels
    expect(layer.props[fxPath(instance.id, 'center')].value).toEqual([540, 960]);
    const defs = layerDynamicDefs(layer);
    expect(defs.map((d) => d.path)).toContain(fxPath(instance.id, 'amount'));
    expect(defs.find((d) => d.path.endsWith('.amount'))!.unit).toBe('px');
  });

  it('evaluates animated effect params and normalises points', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const layer = createSolidLayer({ comp });
    const plugin = effectRegistry.get('luscent.radial-blur') ?? effectRegistry.get('luscent.blur.radial')!;
    const { instance, props } = instantiateEffect(plugin.plugin, comp);
    layer.effects = [instance];
    Object.assign(layer.props, props);
    layer.props[fxPath(instance.id, 'amount')] = { value: 0, keyframes: [makeKeyframe(0, 0), makeKeyframe(1, 50)] };
    comp.layers = [layer];
    const item = evaluateComposition(project, comp.id, 0.5, { measureText: approximateTextMeasure })!.items[0];
    expect(item.effects).toHaveLength(1);
    expect(item.effects![0].params.amount).toBeCloseTo(25);
    expect(item.effects![0].params.center).toEqual([0.5, 0.5]);
  });

  it('marks adjustment layers and skips disabled effects', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const adj = createSolidLayer({ comp });
    adj.adjustment = true;
    const a = instantiateEffect(effectRegistry.get('luscent.glow')!.plugin, comp);
    const b = instantiateEffect(effectRegistry.get('luscent.vhs')!.plugin, comp);
    b.instance.enabled = false;
    adj.effects = [a.instance, b.instance];
    Object.assign(adj.props, a.props, b.props);
    comp.layers = [adj];
    const item = evaluateComposition(project, comp.id, 0, { measureText: approximateTextMeasure })!.items[0];
    expect(item.adjustment).toBe(true);
    expect(item.effects!.map((e) => e.pluginId)).toEqual(['luscent.glow']);
  });

  it('keeps transition layers alive at zero opacity', () => {
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const l = createSolidLayer({ comp, inPoint: 1, outPoint: 3 });
    const t = instantiateEffect(effectRegistry.get('luscent.transition.whip')!.plugin, comp);
    l.effects = [t.instance];
    Object.assign(l.props, t.props);
    comp.layers = [l];
    const item = evaluateComposition(project, comp.id, 1.2, { measureText: approximateTextMeasure })!.items[0];
    expect(item.effects![0].kind).toBe('transition');
    expect(item.sinceIn).toBeCloseTo(0.2);
    expect(item.effects![0].params.duration).toBeCloseTo(0.4);
  });
});
