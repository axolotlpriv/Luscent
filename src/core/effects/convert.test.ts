import { describe, expect, it } from 'vitest';
import glTransitions from 'gl-transitions/gl-transitions.json';
import { convertShader, detectFormat, parseGlslValue } from './convert';
import { convertGlTransitionsPackage, bundledSamples } from '../../effects/bundled';
import { validatePlugin } from './types';

describe('shader converter', () => {
  it('detects formats', () => {
    expect(detectFormat('vec4 transition(vec2 uv) { return getFromColor(uv); }')).toBe('gl-transition');
    expect(detectFormat('/*{ "INPUTS": [] }*/ void main(){}')).toBe('isf');
    expect(detectFormat('void mainImage(out vec4 c, in vec2 f) {}')).toBe('shadertoy');
    expect(detectFormat('vec4 effect(vec2 uv) { return texture(source, uv); }')).toBe('glsl');
    expect(detectFormat('hello')).toBeNull();
  });

  it('parses GLSL literal defaults', () => {
    expect(parseGlslValue('0.5', 1)).toEqual([0.5]);
    expect(parseGlslValue('vec3(1.0, 0.0, 0.5)', 3)).toEqual([1, 0, 0.5]);
    expect(parseGlslValue('ivec2(4)', 2)).toEqual([4, 4]);
    expect(parseGlslValue('true', 1)).toEqual([1]);
  });

  it('converts a gl-transition with typed params', () => {
    const src = `// Author: Someone
// License: MIT
uniform float smoothness; // = 0.5
uniform ivec2 squares; // = ivec2(10, 10)
uniform bool reverse; // = false
uniform vec4 shadow; // = vec4(0.0, 0.0, 0.0, 0.6)
vec4 transition(vec2 uv) {
  float r = reverse ? 1.0 - progress : progress;
  return mix(getFromColor(uv), getToColor(uv), smoothstep(0.0, smoothness, r * float(squares.x)) * ratio);
}`;
    const { plugin, report } = convertShader(src, { name: 'Test' });
    expect(plugin.kind).toBe('transition');
    expect(plugin.author).toBe('Someone');
    expect(plugin.params.map((p) => [p.id, p.type])).toEqual([
      ['smoothness', 'float'],
      ['squares_iv', 'vec2'],
      ['reverse_b', 'bool'],
      ['shadow', 'color'],
    ]);
    expect(plugin.passes![0].glsl).toContain('#define squares ivec2(squares_iv)');
    expect(plugin.passes![0].glsl).not.toMatch(/^\s*uniform float smoothness/m);
    expect(report.unsupported).toEqual([]);
  });

  it('converts ISF including choices, colors and multi-pass targets', () => {
    const src = `/*{
  "DESCRIPTION": "Demo",
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "amt", "TYPE": "float", "DEFAULT": 0.5, "MIN": 0, "MAX": 1 },
    { "NAME": "mode", "TYPE": "long", "VALUES": [0, 1, 2], "LABELS": ["A", "B", "C"], "DEFAULT": 1 },
    { "NAME": "tint", "TYPE": "color", "DEFAULT": [1, 0, 0, 1] },
    { "NAME": "mask", "TYPE": "image" }
  ],
  "PASSES": [{ "TARGET": "buf", "PERSISTENT": true }, {}]
}*/
void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage) * amt + tint * float(mode); }`;
    const { plugin, report } = convertShader(src);
    expect(plugin.kind).toBe('effect');
    expect(plugin.params.find((p) => p.id === 'mode_ix')).toMatchObject({ type: 'choice', default: 1, options: ['A', 'B', 'C'] });
    expect(plugin.passes).toHaveLength(2);
    expect(plugin.passes![0].id).toBe('buf');
    expect(plugin.passes![1].inputs).toContain('buf');
    expect(report.unsupported.join(' ')).toMatch(/mask/);
    expect(report.unsupported.join(' ')).toMatch(/persistent/);
    expect(plugin.passes![1].glsl).toContain('isf_FragColor');
    expect(plugin.passes![1].glsl).not.toContain('gl_FragColor');
  });

  it('detects ISF transitions', () => {
    const src = `/*{ "CATEGORIES": ["Transition"], "INPUTS": [
      { "NAME": "startImage", "TYPE": "image" }, { "NAME": "endImage", "TYPE": "image" },
      { "NAME": "progress", "TYPE": "float", "DEFAULT": 0 } ] }*/
void main() { gl_FragColor = mix(IMG_THIS_PIXEL(startImage), IMG_THIS_PIXEL(endImage), progress); }`;
    const { plugin } = convertShader(src);
    expect(plugin.kind).toBe('transition');
    expect(plugin.params).toEqual([]);
  });

  it('converts Shadertoy shaders and reports what it dropped', () => {
    const src = `uniform float amount; // = 0.3 [0, 1] Amount
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = texture(iChannel0, uv) + texture(iChannel1, uv) * amount + iMouse;
}`;
    const { plugin, report } = convertShader(src, { name: 'ST' });
    expect(plugin.params[0]).toMatchObject({ id: 'amount', min: 0, max: 1, label: 'Amount', default: 0.3 });
    expect(plugin.passes![0].glsl).toContain('stTex(iChannel0,');
    expect(report.unsupported.join(' ')).toMatch(/iChannel1/);
    expect(report.unsupported.join(' ')).toMatch(/iMouse/);
  });

  it('converts plain Luscent GLSL with annotated params', () => {
    const { plugin } = convertShader(`uniform float k; // = 2 [0, 10] Strength
vec4 effect(vec2 uv) { return texture(source, uv) * k; }`);
    expect(plugin.params[0]).toMatchObject({ id: 'k', default: 2, max: 10 });
  });

  it('converts the whole gl-transitions package', () => {
    const report = { loaded: 0, skipped: [] as Array<{ name: string; reason: string }> };
    const plugins = convertGlTransitionsPackage(glTransitions as never, report);
    // Only the two texture-driven transitions (luma, displacement) are skipped.
    expect(report.skipped.map((s) => s.name).sort()).toEqual(['displacement', 'luma']);
    expect(plugins.length).toBeGreaterThanOrEqual(120);
    for (const p of plugins) expect(validatePlugin(p).errors, p.id).toEqual([]);
    expect(new Set(plugins.map((p) => p.id)).size).toBe(plugins.length);
  });

  it('loads bundled ISF and Shadertoy samples', () => {
    const report = { loaded: 0, skipped: [] as Array<{ name: string; reason: string }> };
    const list = bundledSamples(report);
    expect(report.skipped).toEqual([]);
    expect(list.length).toBe(7);
  });
});
