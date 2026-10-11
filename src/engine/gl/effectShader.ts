/**
 * Builds complete GLSL ES 3.00 fragment shaders from plugin passes.
 *
 * Contract for pass code (docs/PLUGINS.md):
 *  - define `vec4 effect(vec2 uv)`; uv (0,0) is the TOP-LEFT of the frame
 *  - inputs are premultiplied-alpha samplers named after `inputs`
 *    ("source", or "from"/"to" for transitions, or earlier pass ids)
 *  - every parameter is a uniform named after its id
 *  - built-in uniforms: resolution, compSize, renderScale, time, layerTime,
 *    progress, seed; helpers below (hash, noise, luma, blur1D, …)
 */
import type { EffectPlugin, ParamSpec, PassSpec } from '../../core/effects/types';
import { pluginParams } from '../../core/effects/types';

export const EFFECT_PRELUDE = /* glsl */ `
#define PI 3.141592653589793
#define TAU 6.283185307179586
uniform vec2 resolution;   // output size in device pixels
uniform vec2 compSize;     // composition size in comp pixels
uniform float renderScale; // device pixels per comp pixel
uniform float time;        // composition time (s)
uniform float layerTime;   // layer time (s)
uniform float progress;    // transitions: 0 → 1
uniform float seed;
vec2 compPx() { return 1.0 / compSize; }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float noise1(float x) { float i = floor(x); float f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u) * 2.0 - 1.0; }
float noise2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 unpremultiply(vec4 c) { return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 premultiply(vec4 c) { return vec4(c.rgb * c.a, c.a); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
bool inside(vec2 uv) { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
vec2 mirrorUV(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
// Edge modes: 0 transparent, 1 clamp (repeat edge pixels), 2 mirror, 3 tile.
vec4 sampleEdge(sampler2D s, vec2 uv, float mode) {
  if (mode < 0.5) return inside(uv) ? texture(s, uv) : vec4(0.0);
  if (mode < 1.5) return texture(s, clamp(uv, 0.0, 1.0));
  if (mode < 2.5) return texture(s, mirrorUV(uv));
  return texture(s, fract(uv));
}
// Separable gaussian along dir (uv units per comp pixel), radius in comp px.
vec4 blur1D(sampler2D s, vec2 uv, vec2 dir, float radius, float edgeMode) {
  if (radius < 0.5) return sampleEdge(s, uv, edgeMode);
  float sigma = max(radius / 2.5, 0.5);
  float stepPx = max(1.0, radius / 20.0);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -32; i <= 32; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > radius * 1.25) continue;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += sampleEdge(s, uv + dir * x, edgeMode) * w;
    wsum += w;
  }
  return acc / wsum;
}
`;

function uniformType(p: ParamSpec): string {
  if (p.type === 'point' || p.type === 'vec2') return 'vec2';
  if (p.type === 'color') return 'vec4';
  return 'float';
}

/** Input sampler names a pass reads. */
export function passInputs(plugin: EffectPlugin, index: number): string[] {
  const pass = plugin.passes![index];
  if (pass.inputs?.length) return pass.inputs;
  if (index === 0) return plugin.kind === 'transition' ? ['from', 'to'] : ['source'];
  const prev = plugin.passes![index - 1];
  return [prev.id ?? `pass${index - 1}`];
}

export function passOutputName(pass: PassSpec, index: number): string {
  return pass.id ?? `pass${index}`;
}

export function buildPassShader(plugin: EffectPlugin, index: number): string {
  const pass = plugin.passes![index];
  const inputs = new Set(passInputs(plugin, index));
  // Transitions always see both clips; effects always see the source.
  if (plugin.kind === 'transition') {
    inputs.add('from');
    inputs.add('to');
  } else inputs.add('source');
  const samplers = [...inputs].map((n) => `uniform sampler2D ${n};`).join('\n');
  const params = pluginParams(plugin)
    .map((p) => `uniform ${uniformType(p)} ${p.id};`)
    .join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 fragColor;
${samplers}
${params}
${EFFECT_PRELUDE}
#line 1
${pass.glsl}
void main() { fragColor = effect(vUV); }
`;
}
