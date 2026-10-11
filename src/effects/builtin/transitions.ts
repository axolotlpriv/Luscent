/**
 * Built-in transitions. A transition is applied to the incoming clip's layer
 * ("In") or the outgoing clip's layer ("Out"); `from` is the frame without
 * the transition layer's contribution and `to` the frame with it.
 */
import type { EffectPlugin } from '../../core/effects/types';

const tr = (p: Omit<EffectPlugin, 'version' | 'kind' | 'builtin' | 'author' | 'license'>): EffectPlugin => ({
  version: '1.0.0',
  kind: 'transition',
  builtin: true,
  author: 'Luscent',
  license: 'MIT',
  ...p,
});

const DIRS = ['Left', 'Right', 'Up', 'Down'];
const DIR_GLSL = `vec2 dirVec() {
  if (direction < 0.5) return vec2(1.0, 0.0);
  if (direction < 1.5) return vec2(-1.0, 0.0);
  if (direction < 2.5) return vec2(0.0, 1.0);
  return vec2(0.0, -1.0);
}`;

export const whip = tr({
  id: 'luscent.transition.whip',
  name: 'Whip Pan',
  category: 'Transitions',
  description: 'Fast motion-blurred pan from one shot into the next.',
  params: [
    { id: 'direction', label: 'Direction', type: 'choice', default: 0, options: DIRS },
    { id: 'blur', label: 'Motion Blur', type: 'percent', default: 80, min: 0, max: 100 },
  ],
  passes: [
    {
      glsl: `${DIR_GLSL}
vec4 at(vec2 uv, float s) {
  // A virtual strip: "from" then "to" laid out along the pan axis; the
  // camera slides by s (0 → 1) across it.
  vec2 d = dirVec();
  vec2 axis = abs(d);
  float sgn = d.x + d.y;
  float a = dot(uv, axis);
  float u = a + sgn * s;
  bool inFrom = sgn > 0.0 ? u < 1.0 : u >= 0.0;
  float local = inFrom ? u : u - sgn;
  vec2 p = uv * (1.0 - axis) + axis * local;
  return inFrom ? texture(from, clamp(p, 0.0, 1.0)) : texture(to, clamp(p, 0.0, 1.0));
}
vec4 effect(vec2 uv) {
  float e = progress * progress * (3.0 - 2.0 * progress);
  float spread = blur / 100.0 * 0.35 * sin(progress * PI);
  vec4 acc = vec4(0.0);
  const int N = 24;
  for (int i = 0; i < N; i++) acc += at(uv, e + (float(i) / float(N - 1) - 0.5) * spread);
  return acc / float(N);
}`,
    },
  ],
});

export const zoomThrough = tr({
  id: 'luscent.transition.zoom',
  name: 'Zoom Through',
  category: 'Transitions',
  description: 'Punch into the outgoing shot with zoom blur and land on the next.',
  params: [
    { id: 'strength', label: 'Zoom Strength', type: 'percent', default: 70, min: 0, max: 100 },
    { id: 'center', label: 'Center', type: 'point', default: [0.5, 0.5] },
    { id: 'zoomOut', label: 'Direction', type: 'choice', default: 0, options: ['Zoom In', 'Zoom Out'] },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float p = progress;
  float k = strength / 100.0;
  bool first = p < 0.5;
  float local = first ? p * 2.0 : (1.0 - p) * 2.0;     // 0 at ends, 1 at the cut
  float z = 1.0 + local * local * 2.5 * k;
  if (zoomOut > 0.5) z = 1.0 / z;
  vec4 acc = vec4(0.0);
  const int N = 20;
  for (int i = 0; i < N; i++) {
    float s = z * (1.0 - float(i) / float(N) * 0.25 * local * k);
    vec2 q = center + (uv - center) / s;
    acc += first ? texture(from, mirrorUV(q)) : texture(to, mirrorUV(q));
  }
  return acc / float(N);
}`,
    },
  ],
});

export const spin = tr({
  id: 'luscent.transition.spin',
  name: 'Spin',
  category: 'Transitions',
  params: [
    { id: 'turns', label: 'Rotation', type: 'angle', default: 180, min: -1440, max: 1440 },
    { id: 'blur', label: 'Motion Blur', type: 'percent', default: 70, min: 0, max: 100 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float e = progress * progress * (3.0 - 2.0 * progress);
  vec2 aspect = vec2(compSize.x / compSize.y, 1.0);
  vec4 acc = vec4(0.0);
  const int N = 16;
  for (int i = 0; i < N; i++) {
    float t = e + (float(i) / float(N - 1) - 0.5) * blur / 100.0 * 0.2 * sin(progress * PI);
    float a = radians(turns) * t;
    vec2 q = 0.5 + (rot2(-a) * ((uv - 0.5) * aspect)) / aspect;
    acc += t < 0.5 ? texture(from, mirrorUV(q)) : texture(to, mirrorUV(q));
  }
  return acc / float(N);
}`,
    },
  ],
});

export const flashCut = tr({
  id: 'luscent.transition.flash',
  name: 'Flash Cut',
  category: 'Transitions',
  params: [
    { id: 'fcolor', label: 'Color', type: 'color', default: [1, 1, 1, 1] },
    { id: 'intensity', label: 'Intensity', type: 'percent', default: 100, min: 0, max: 100 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec4 c = progress < 0.5 ? texture(from, uv) : texture(to, uv);
  float f = pow(1.0 - abs(progress * 2.0 - 1.0), 2.0) * intensity / 100.0;
  return vec4(mix(c.rgb, fcolor.rgb, f), max(c.a, f));
}`,
    },
  ],
});

export const glitchCut = tr({
  id: 'luscent.transition.glitch',
  name: 'Glitch Cut',
  category: 'Transitions',
  params: [{ id: 'amount', label: 'Amount', type: 'percent', default: 80, min: 0, max: 100 }],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float k = sin(progress * PI) * amount / 100.0;
  float t = floor(progress * 24.0);
  float slice = floor(uv.y * 24.0);
  float r = hash12(vec2(slice, t));
  vec2 p = uv;
  if (r < k) p.x += (hash12(vec2(t, slice)) - 0.5) * k * 0.4;
  float o = k * 0.03;
  bool useTo = hash12(vec2(slice * 0.37, t)) < progress;
  vec4 cr = useTo ? texture(to, mirrorUV(p + vec2(o, 0.0))) : texture(from, mirrorUV(p + vec2(o, 0.0)));
  vec4 cg = useTo ? texture(to, mirrorUV(p)) : texture(from, mirrorUV(p));
  vec4 cb = useTo ? texture(to, mirrorUV(p - vec2(o, 0.0))) : texture(from, mirrorUV(p - vec2(o, 0.0)));
  return vec4(cr.r, cg.g, cb.b, cg.a);
}`,
    },
  ],
});

export const rgbSplitCut = tr({
  id: 'luscent.transition.rgb-split',
  name: 'RGB Split Cut',
  category: 'Transitions',
  params: [{ id: 'offset', label: 'Max Offset', type: 'pixels', default: 80, min: 0, max: 600 }],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float k = sin(progress * PI);
  vec2 o = vec2(offset * k * compPx().x, 0.0);
  vec4 a = progress < 0.5 ? texture(from, uv) : texture(to, uv);
  vec4 r = progress < 0.5 ? texture(from, mirrorUV(uv + o)) : texture(to, mirrorUV(uv + o));
  vec4 b = progress < 0.5 ? texture(from, mirrorUV(uv - o)) : texture(to, mirrorUV(uv - o));
  return vec4(r.r, a.g, b.b, a.a);
}`,
    },
  ],
});

export const slide = tr({
  id: 'luscent.transition.slide',
  name: 'Push',
  category: 'Transitions',
  params: [{ id: 'direction', label: 'Direction', type: 'choice', default: 0, options: DIRS }],
  passes: [
    {
      glsl: `${DIR_GLSL}
vec4 effect(vec2 uv) {
  float e = progress * progress * (3.0 - 2.0 * progress);
  vec2 d = dirVec();
  vec2 pf = uv + d * e;
  vec2 pt = uv + d * (e - 1.0);
  return inside(pf) ? texture(from, pf) : texture(to, pt);
}`,
    },
  ],
});

export const dissolve = tr({
  id: 'luscent.transition.dissolve',
  name: 'Dissolve',
  category: 'Transitions',
  params: [],
  passes: [{ glsl: `vec4 effect(vec2 uv) { return mix(texture(from, uv), texture(to, uv), progress); }` }],
});

export const BUILTIN_TRANSITIONS: EffectPlugin[] = [whip, zoomThrough, spin, flashCut, glitchCut, rgbSplitCut, slide, dissolve];
