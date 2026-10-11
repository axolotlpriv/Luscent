import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerBuiltinEffects } from '../../effects';
import { effectRegistry } from '../effects/registry';
import { evaluateProp } from '../animation/interpolate';
import { createProject, createShapeLayer } from '../model/factory';
import type { Vec2 } from '../model/types';
import { applyPresetToLayer, type PresetContext } from '../presets/apply';
import { validatePreset } from '../presets/types';
import { importAfterEffects, importAfterEffectsLayers } from './import';
import { parseRifx, type RChunk } from './rifx';

// Fixtures are sample projects from py_aep (MIT), see THIRD_PARTY_NOTICES.md.
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '__fixtures__', name)));

registerBuiltinEffects();

describe('RIFX parser', () => {
  it('reads the AE project container', () => {
    const root = parseRifx(fixture('keyframe_HOLD.aep'));
    expect(root.type).toBe('RIFX');
    expect(root.list).toBe('Egg!');
    expect(root.children!.length).toBeGreaterThan(0);
  });

  it('rejects non-AE files', () => {
    expect(() => parseRifx(new TextEncoder().encode('{"format":"luscent-preset"}'))).toThrow(/RIFX/);
  });
});

describe('After Effects import', () => {
  it('maps scale keyframes with exact AE eases', () => {
    const { preset, report } = importAfterEffects(fixture('keyframe_bezier_ease_scale.aep'), 'keyframe_bezier_ease_scale.aep');
    expect(validatePreset(preset)).toEqual([]);
    const keys = preset.props!['transform.scale'].keys!;
    expect(keys.map((k) => k.t)).toEqual([0, 3, 6, 9]);
    expect(keys.map((k) => k.v)).toEqual([
      [0, 0],
      [120, 120],
      [80, 80],
      [100, 100],
    ]);
    expect(keys[0].ae!.outEase[0].influence).toBeCloseTo(0.75);
    expect(keys[1].ae!.inEase[0].influence).toBeCloseTo(0.75);
    expect(keys[1].ae!.outEase[0].influence).toBeCloseTo(0.33);
    expect(preset.duration).toBe(9);
    expect(report.unmapped).toEqual([]);
  });

  it('applies imported eases so the curve matches AE', () => {
    const { preset } = importAfterEffects(fixture('keyframe_bezier_ease_scale.aep'));
    const project = createProject();
    const comp = project.compositions[project.mainCompId];
    const layer = createShapeLayer({ comp });
    comp.layers = [layer];
    const ctx: PresetContext = { comp, playhead: 0, beat: 0.5, media: {}, plugin: (id) => effectRegistry.get(id)?.plugin };
    applyPresetToLayer(layer, preset, ctx);
    const s = (t: number) => (evaluateProp(layer.props['transform.scale'], t) as Vec2)[0];
    expect(s(0)).toBeCloseTo(0);
    expect(s(3)).toBeCloseTo(120);
    // Equal 75 % influences with zero speed on both sides: symmetric, so the midpoint is half way.
    expect(s(1.5)).toBeCloseTo(60, 1);
    // Strong ease: slow start.
    expect(s(0.3)).toBeLessThan(12 * 0.5);
    expect(s(9)).toBeCloseTo(100);
  });

  it('maps hold keyframes', () => {
    const { preset } = importAfterEffects(fixture('keyframe_HOLD.aep'));
    const keys = preset.props!['transform.opacity'].keys!;
    expect(keys.map((k) => k.v)).toEqual([100, 0, 100]);
    expect(keys[1].ae!.outInterp).toBe('hold');
  });

  it('maps Gaussian Blur to the built-in blur', () => {
    const { preset } = importAfterEffects(fixture('2_gaussian_20_30.aep'));
    expect(preset.effects!.map((e) => e.pluginId)).toEqual(['luscent.blur.gaussian', 'luscent.blur.gaussian']);
    expect(preset.effects!.map((e) => e.params!.radius.value)).toEqual([20, 30]);
  });

  it('maps common expressions and reports the rest', () => {
    const layers = importAfterEffectsLayers(fixture('expression.aep'), 'expression.aep').map((r) => r.preset);
    const opacity = layers.find((p) => p.props?.['transform.opacity'])!;
    expect(opacity.props!['transform.opacity'].value).toBe(50);
    const wig = layers.find((p) => p.props?.['transform.position']?.wiggle)!;
    expect(wig.props!['transform.position'].wiggle).toMatchObject({ freq: 2, amp: 50 });
    const spin = layers.find((p) => p.props?.['transform.rotation'])!;
    const k = spin.props!['transform.rotation'].keys!;
    expect((k[1].v as number) / (k[1].t as number)).toBeCloseTo(36);
    expect(spin.importReport!.approximated.some((s) => s.includes('time * 36'))).toBe(true);
  });

  it('lists effects it cannot map', () => {
    const all = importAfterEffectsLayers(fixture('effects.aep'), 'effects.aep');
    const unmapped = all.flatMap((r) => r.report.unmapped).join('\n');
    expect(unmapped).toMatch(/Lens Flare/);
    expect(unmapped).toMatch(/CC Sphere/);
    expect(unmapped).toMatch(/Puppet/);
  });

  it('reads .ffx presets (FaFX container)', () => {
    // Re-wrap a layer's property tree as an .ffx: RIFX FaFX { LIST tdgp }.
    const aep = parseRifx(fixture('keyframe_bezier_ease_scale.aep'));
    const layr = findList(aep, 'Layr')!;
    const tdgp = layr.children!.find((c) => c.type === 'LIST' && c.list === 'tdgp')!;
    const ffx = writeRifx({ type: 'RIFX', list: 'FaFX', children: [{ type: 'head', data: new Uint8Array(8) }, tdgp] });
    const { preset, report } = importAfterEffects(ffx, 'Bounce In.ffx');
    expect(report.source).toBe('Bounce In.ffx (ffx)');
    expect(preset.name).toBe('Bounce In');
    expect(preset.props!['transform.scale'].keys!.length).toBe(4);
  });
});

function findList(c: RChunk, list: string): RChunk | undefined {
  if (c.type === 'LIST' && c.list === list) return c;
  for (const x of c.children ?? []) {
    const f = findList(x, list);
    if (f) return f;
  }
  return undefined;
}

function writeRifx(c: RChunk): Uint8Array {
  const parts: Uint8Array[] = [];
  const write = (ch: RChunk) => {
    const body = ch.list
      ? concat([ascii(ch.list), ch.data ?? concat((ch.children ?? []).map((x) => chunkBytes(x)))])
      : (ch.data ?? new Uint8Array());
    return frame(ch.type, body);
  };
  const chunkBytes = (ch: RChunk): Uint8Array => write(ch);
  parts.push(write(c));
  return concat(parts);
}

function frame(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  out.set(ascii(type), 0);
  new DataView(out.buffer).setUint32(4, body.length, false);
  out.set(body, 8);
  return out;
}

const ascii = (s: string) => new Uint8Array([...s].map((ch) => ch.charCodeAt(0)));

function concat(arr: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arr.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arr) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
