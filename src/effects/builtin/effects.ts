/**
 * Built-in effects, written in the public plugin format (docs/PLUGINS.md).
 * Remakes of the effects short-form editors reach for most: glow,
 * chromatic aberration, RGB split, shake, blurs, VHS, grain, glitch, lens
 * distortion, plus the colour and utility effects presets build on.
 */
import type { EffectPlugin, ParamSpec } from '../../core/effects/types';

const EDGE: ParamSpec = { id: 'edgeMode', label: 'Edges', type: 'choice', default: 2, options: ['Transparent', 'Repeat edge pixels', 'Mirror', 'Tile'] };

const fx = (p: Omit<EffectPlugin, 'version' | 'kind' | 'builtin' | 'author' | 'license'> & Partial<EffectPlugin>): EffectPlugin => ({
  version: '1.0.0',
  kind: 'effect',
  builtin: true,
  author: 'Luscent',
  license: 'MIT',
  ...p,
});

// ---------------------------------------------------------------- blurs

export const gaussianBlur = fx({
  id: 'luscent.blur.gaussian',
  name: 'Gaussian Blur',
  category: 'Blur',
  description: 'Smooth separable gaussian blur.',
  params: [
    { id: 'radius', label: 'Blurriness', type: 'pixels', default: 20, min: 0, max: 400, step: 0.5 },
    { id: 'dims', label: 'Dimensions', type: 'choice', default: 0, options: ['Horizontal & Vertical', 'Horizontal', 'Vertical'] },
    { id: 'repeatEdges', label: 'Repeat Edge Pixels', type: 'bool', default: 0 },
  ],
  passes: [
    {
      id: 'h',
      glsl: `vec4 effect(vec2 uv) {
  if (dims > 1.5) return texture(source, uv);
  return blur1D(source, uv, vec2(compPx().x, 0.0), radius, repeatEdges);
}`,
    },
    {
      inputs: ['h'],
      glsl: `vec4 effect(vec2 uv) {
  if (dims > 0.5 && dims < 1.5) return texture(h, uv);
  return blur1D(h, uv, vec2(0.0, compPx().y), radius, repeatEdges);
}`,
    },
  ],
});

export const directionalBlur = fx({
  id: 'luscent.blur.directional',
  name: 'Directional Blur',
  category: 'Blur',
  description: 'Motion-style blur along an angle — the core of whip pans.',
  params: [
    { id: 'angle', label: 'Direction', type: 'angle', default: 0, step: 0.5 },
    { id: 'blurLength', label: 'Blur Length', type: 'pixels', default: 40, min: 0, max: 1000, step: 0.5 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  if (blurLength < 0.5) return texture(source, uv);
  float a = radians(angle);
  vec2 dir = vec2(cos(a), sin(a)) * compPx();
  vec4 acc = vec4(0.0);
  const int N = 32;
  for (int i = 0; i < N; i++) {
    float t = (float(i) / float(N - 1) - 0.5) * blurLength;
    acc += sampleEdge(source, uv + dir * t, 1.0);
  }
  return acc / float(N);
}`,
    },
  ],
});

export const radialBlur = fx({
  id: 'luscent.blur.radial',
  name: 'Radial / Zoom Blur',
  category: 'Blur',
  description: 'Zoom blur toward a center, or spin blur around it.',
  params: [
    { id: 'amount', label: 'Amount', type: 'float', default: 20, min: 0, max: 100, step: 0.1 },
    { id: 'center', label: 'Center', type: 'point', default: [0.5, 0.5] },
    { id: 'mode', label: 'Type', type: 'choice', default: 1, options: ['Spin', 'Zoom'] },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  if (amount <= 0.0) return texture(source, uv);
  vec2 aspect = vec2(compSize.x / compSize.y, 1.0);
  vec2 d = (uv - center) * aspect;
  vec4 acc = vec4(0.0);
  const int N = 40;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1);
    vec2 p;
    if (mode < 0.5) {
      float ang = (t - 0.5) * radians(amount);
      p = center + (rot2(ang) * d) / aspect;
    } else {
      p = center + d * (1.0 - t * amount * 0.01) / aspect;
    }
    acc += sampleEdge(source, p, 1.0);
  }
  return acc / float(N);
}`,
    },
  ],
});

// ---------------------------------------------------------------- stylize

export const glow = fx({
  id: 'luscent.glow',
  name: 'Glow',
  category: 'Stylize',
  description: 'Bloom bright areas: threshold, blur and add back.',
  params: [
    { id: 'threshold', label: 'Threshold', type: 'percent', default: 60, min: 0, max: 100 },
    { id: 'radius', label: 'Radius', type: 'pixels', default: 40, min: 0, max: 400, step: 0.5 },
    { id: 'intensity', label: 'Intensity', type: 'float', default: 1.2, min: 0, max: 10, step: 0.01 },
    { id: 'tint', label: 'Tint', type: 'color', default: [1, 1, 1, 1] },
    { id: 'composite', label: 'Composite Original', type: 'choice', default: 0, options: ['On top', 'Glow only'] },
  ],
  passes: [
    {
      id: 'bright',
      scale: 0.5,
      glsl: `vec4 effect(vec2 uv) {
  vec4 c = texture(source, uv);
  vec4 s = unpremultiply(c);
  float t = threshold / 100.0;
  float m = smoothstep(t - 0.1, t + 0.05, luma(s.rgb));
  return c * m;
}`,
    },
    { id: 'bh', scale: 0.5, inputs: ['bright'], glsl: `vec4 effect(vec2 uv) { return blur1D(bright, uv, vec2(compPx().x, 0.0), radius, 0.0); }` },
    { id: 'bv', scale: 0.5, inputs: ['bh'], glsl: `vec4 effect(vec2 uv) { return blur1D(bh, uv, vec2(0.0, compPx().y), radius, 0.0); }` },
    {
      inputs: ['source', 'bv'],
      glsl: `vec4 effect(vec2 uv) {
  vec4 g = texture(bv, uv) * intensity;
  g.rgb *= tint.rgb;
  vec4 o = composite > 0.5 ? vec4(0.0) : texture(source, uv);
  vec3 rgb = o.rgb + g.rgb;
  return vec4(min(rgb, 1.0), clamp(max(o.a, g.a), 0.0, 1.0));
}`,
    },
  ],
});

export const chromaticAberration = fx({
  id: 'luscent.chromatic-aberration',
  name: 'Chromatic Aberration',
  category: 'Stylize',
  description: 'Lens-style colour fringing that grows toward the edges.',
  params: [
    { id: 'amount', label: 'Amount', type: 'pixels', default: 12, min: 0, max: 200, step: 0.1 },
    { id: 'center', label: 'Center', type: 'point', default: [0.5, 0.5] },
    { id: 'radial', label: 'Radial Falloff', type: 'percent', default: 100, min: 0, max: 100 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec2 aspect = vec2(compSize.x / compSize.y, 1.0);
  vec2 d = (uv - center) * aspect;
  float r = length(d);
  vec2 dir = r > 0.0 ? d / r : vec2(0.0);
  float k = mix(1.0, r * 2.0, radial / 100.0);
  vec2 off = dir / aspect * amount * compPx().x * k * aspect.x;
  vec4 cr = sampleEdge(source, uv + off, 1.0);
  vec4 cg = texture(source, uv);
  vec4 cb = sampleEdge(source, uv - off, 1.0);
  return vec4(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
}`,
    },
  ],
});

export const rgbSplit = fx({
  id: 'luscent.rgb-split',
  name: 'RGB Split',
  category: 'Stylize',
  description: 'Offset red and blue channels in opposite directions.',
  params: [
    { id: 'offset', label: 'Offset', type: 'pixels', default: 16, min: -500, max: 500, step: 0.1 },
    { id: 'angle', label: 'Angle', type: 'angle', default: 0 },
    { id: 'jitter', label: 'Jitter', type: 'percent', default: 0, min: 0, max: 100 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float a = radians(angle);
  float j = 1.0 + (noise1(time * 24.0) * jitter / 50.0);
  vec2 off = vec2(cos(a), sin(a)) * offset * j * compPx();
  vec4 cr = sampleEdge(source, uv + off, 0.0);
  vec4 cg = texture(source, uv);
  vec4 cb = sampleEdge(source, uv - off, 0.0);
  float alpha = max(max(cr.a, cg.a), cb.a);
  return vec4(cr.r, cg.g, cb.b, alpha);
}`,
    },
  ],
});

export const shake = fx({
  id: 'luscent.shake',
  name: 'Shake',
  category: 'Motion',
  description: 'Procedural camera shake with rotation, zoom-to-fill and motion blur.',
  params: [
    { id: 'amplitude', label: 'Amplitude', type: 'pixels', default: 30, min: 0, max: 1000, step: 0.5 },
    { id: 'frequency', label: 'Frequency', type: 'float', default: 12, min: 0, max: 60, step: 0.1, hint: 'shakes per second' },
    { id: 'rotation', label: 'Rotation', type: 'angle', default: 2, min: 0, max: 90 },
    { id: 'zoom', label: 'Zoom', type: 'percent', default: 105, min: 50, max: 300 },
    { id: 'blur', label: 'Motion Blur', type: 'percent', default: 50, min: 0, max: 100 },
    { id: 'shakeSeed', label: 'Seed', type: 'float', default: 1, min: 0, max: 1000, step: 1 },
    EDGE,
  ],
  passes: [
    {
      glsl: `vec2 shakeAt(float t, out float ang) {
  float f = t * frequency;
  vec2 o = vec2(noise1(f + shakeSeed * 13.1), noise1(f + 71.7 + shakeSeed * 7.3)) * amplitude;
  ang = noise1(f * 0.8 + 191.3 + shakeSeed) * radians(rotation);
  return o;
}
vec4 sampleAt(vec2 uv, float t) {
  float ang;
  vec2 o = shakeAt(t, ang);
  vec2 p = uv * compSize - compSize * 0.5;
  p = rot2(-ang) * p / (zoom / 100.0) - o;
  return sampleEdge(source, (p + compSize * 0.5) / compSize, edgeMode);
}
vec4 effect(vec2 uv) {
  if (blur <= 0.0 || frequency <= 0.0) return sampleAt(uv, time);
  vec4 acc = vec4(0.0);
  const int N = 6;
  float shutter = blur / 100.0 / max(frequency, 1.0) * 0.5;
  for (int i = 0; i < N; i++) acc += sampleAt(uv, time - shutter * float(i) / float(N - 1));
  return acc / float(N);
}`,
    },
  ],
});

export const transform = fx({
  id: 'luscent.transform',
  name: 'Transform',
  category: 'Motion',
  description: 'Move, scale and rotate the rendered layer — zoom punches on adjustment layers.',
  params: [
    { id: 'anchor', label: 'Anchor Point', type: 'point', default: [0.5, 0.5] },
    { id: 'position', label: 'Position', type: 'point', default: [0.5, 0.5] },
    { id: 'scale', label: 'Scale', type: 'percent', default: 100, min: 1, max: 2000 },
    { id: 'rotation', label: 'Rotation', type: 'angle', default: 0 },
    { id: 'opacity', label: 'Opacity', type: 'percent', default: 100, min: 0, max: 100 },
    { id: 'shutter', label: 'Motion Blur', type: 'percent', default: 0, min: 0, max: 100 },
    EDGE,
  ],
  passes: [
    {
      glsl: `vec4 at(vec2 uv, float k) {
  vec2 p = uv * compSize;
  vec2 pos = position * compSize;
  vec2 anc = anchor * compSize;
  float s = mix(1.0, scale / 100.0, k);
  float r = radians(rotation) * k;
  vec2 q = rot2(-r) * (p - mix(anc, pos, k)) / max(s, 1e-3) + anc;
  return sampleEdge(source, q / compSize, edgeMode);
}
vec4 effect(vec2 uv) {
  if (shutter <= 0.0) return at(uv, 1.0) * (opacity / 100.0);
  vec4 acc = vec4(0.0);
  const int N = 8;
  for (int i = 0; i < N; i++) acc += at(uv, 1.0 - (shutter / 100.0) * 0.25 * float(i) / float(N - 1));
  return acc / float(N) * (opacity / 100.0);
}`,
    },
  ],
});

export const vhs = fx({
  id: 'luscent.vhs',
  name: 'VHS',
  category: 'Stylize',
  description: 'Tape look: line jitter, tracking band, chroma bleed, scanlines and noise.',
  params: [
    { id: 'jitter', label: 'Line Jitter', type: 'percent', default: 30, min: 0, max: 100 },
    { id: 'tracking', label: 'Tracking Band', type: 'percent', default: 40, min: 0, max: 100 },
    { id: 'bleed', label: 'Chroma Bleed', type: 'pixels', default: 6, min: 0, max: 60 },
    { id: 'scanlines', label: 'Scanlines', type: 'percent', default: 35, min: 0, max: 100 },
    { id: 'noiseAmt', label: 'Noise', type: 'percent', default: 25, min: 0, max: 100 },
    { id: 'saturation', label: 'Saturation', type: 'percent', default: 85, min: 0, max: 200 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float frame = floor(time * 30.0);
  float line = floor(uv.y * compSize.y / 3.0);
  float j = (hash12(vec2(line, frame)) - 0.5) * jitter / 100.0 * 6.0 * compPx().x;
  float bandY = fract(time * 0.13);
  float band = smoothstep(0.06, 0.0, abs(uv.y - bandY)) * tracking / 100.0;
  vec2 p = uv + vec2(j + band * 0.02 * (hash12(vec2(frame, line)) - 0.3), 0.0);
  vec2 b = vec2(bleed * compPx().x, 0.0);
  vec4 c = texture(source, p);
  vec4 cr = texture(source, p + b);
  vec4 cb = texture(source, p - b);
  vec3 rgb = vec3(cr.r, c.g, cb.b);
  float l = luma(rgb);
  rgb = mix(vec3(l), rgb, saturation / 100.0);
  float scan = 1.0 - scanlines / 100.0 * 0.5 * (0.5 + 0.5 * sin(uv.y * compSize.y * PI * 0.5));
  rgb *= scan;
  float n = (hash12(uv * compSize + frame * 17.0) - 0.5) * noiseAmt / 100.0 * 0.5;
  rgb += n + band * 0.25;
  float a = max(c.a, max(cr.a, cb.a));
  return vec4(clamp(rgb, 0.0, 1.0) * (a > 0.0 ? 1.0 : 0.0), a);
}`,
    },
  ],
});

export const grain = fx({
  id: 'luscent.grain',
  name: 'Film Grain',
  category: 'Noise',
  description: 'Animated film grain.',
  params: [
    { id: 'amount', label: 'Amount', type: 'percent', default: 20, min: 0, max: 100 },
    { id: 'size', label: 'Grain Size', type: 'pixels', default: 1.5, min: 0.5, max: 10, step: 0.05 },
    { id: 'fps', label: 'Grain FPS', type: 'float', default: 24, min: 0, max: 60, step: 1 },
    { id: 'mono', label: 'Monochrome', type: 'bool', default: 1 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec4 c = texture(source, uv);
  float f = fps > 0.0 ? floor(time * fps) : 0.0;
  vec2 cell = floor(uv * compSize / size) + f * 37.0;
  vec3 n = mono > 0.5 ? vec3(noise2(cell)) : vec3(noise2(cell), noise2(cell + 11.0), noise2(cell + 23.0));
  n = (n - 0.5) * amount / 100.0;
  return vec4(clamp(c.rgb + n * c.a, 0.0, 1.0), c.a);
}`,
    },
  ],
});

export const glitch = fx({
  id: 'luscent.glitch',
  name: 'Glitch',
  category: 'Stylize',
  description: 'Digital block displacement, slice shifts and colour tearing.',
  params: [
    { id: 'amount', label: 'Amount', type: 'percent', default: 50, min: 0, max: 100 },
    { id: 'blockSize', label: 'Block Size', type: 'pixels', default: 64, min: 4, max: 512 },
    { id: 'shift', label: 'RGB Tear', type: 'pixels', default: 20, min: 0, max: 300 },
    { id: 'speed', label: 'Speed', type: 'float', default: 12, min: 0, max: 60, step: 0.5 },
    { id: 'glitchSeed', label: 'Seed', type: 'float', default: 3, min: 0, max: 1000, step: 1 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float a = amount / 100.0;
  float t = floor(time * speed) + glitchSeed * 31.0;
  vec2 cell = floor(uv * compSize / blockSize);
  float r = hash12(cell + t);
  float slice = floor(uv.y * compSize.y / (blockSize * 0.35));
  float sr = hash12(vec2(slice, t * 1.7));
  vec2 p = uv;
  if (sr < a * 0.35) p.x += (hash12(vec2(slice, t)) - 0.5) * a * 0.3;
  if (r < a * 0.25) p += (hash22(cell + t * 3.0) - 0.5) * blockSize * compPx() * 2.0;
  float tear = (r < a * 0.5 ? shift : shift * 0.2) * a;
  vec2 o = vec2(tear * compPx().x, 0.0);
  vec4 cr = sampleEdge(source, p + o, 2.0);
  vec4 cg = sampleEdge(source, p, 2.0);
  vec4 cb = sampleEdge(source, p - o, 2.0);
  vec3 rgb = vec3(cr.r, cg.g, cb.b);
  if (hash12(cell * 1.3 + t) < a * 0.05) rgb = 1.0 - rgb;
  return vec4(rgb, max(cg.a, max(cr.a, cb.a)));
}`,
    },
  ],
});

export const lensDistortion = fx({
  id: 'luscent.lens-distortion',
  name: 'Lens Distortion',
  category: 'Distort',
  description: 'Barrel / pincushion distortion with optional fringe (BCC-style).',
  params: [
    { id: 'amount', label: 'Curvature', type: 'float', default: 30, min: -100, max: 100, step: 0.1 },
    { id: 'zoom', label: 'Zoom', type: 'percent', default: 100, min: 25, max: 300 },
    { id: 'fringe', label: 'Fringe', type: 'pixels', default: 4, min: 0, max: 60 },
    { id: 'center', label: 'Center', type: 'point', default: [0.5, 0.5] },
    EDGE,
  ],
  passes: [
    {
      glsl: `vec2 distort(vec2 uv, float k) {
  vec2 aspect = vec2(compSize.x / compSize.y, 1.0);
  vec2 d = (uv - center) * aspect;
  float r2 = dot(d, d);
  d *= 1.0 + k * r2;
  return center + d / aspect / (zoom / 100.0);
}
vec4 effect(vec2 uv) {
  float k = amount / 100.0 * 0.6;
  float f = fringe * compPx().x;
  vec4 cg = sampleEdge(source, distort(uv, k), edgeMode);
  if (f <= 0.0) return cg;
  vec4 cr = sampleEdge(source, distort(uv, k + f * 4.0), edgeMode);
  vec4 cb = sampleEdge(source, distort(uv, k - f * 4.0), edgeMode);
  return vec4(cr.r, cg.g, cb.b, max(cg.a, max(cr.a, cb.a)));
}`,
    },
  ],
});

export const wave = fx({
  id: 'luscent.wave',
  name: 'Wave Warp',
  category: 'Distort',
  params: [
    { id: 'amplitude', label: 'Amplitude', type: 'pixels', default: 12, min: 0, max: 400 },
    { id: 'wavelength', label: 'Wavelength', type: 'pixels', default: 180, min: 4, max: 4000 },
    { id: 'speed', label: 'Speed', type: 'float', default: 1, min: -20, max: 20, step: 0.05 },
    { id: 'direction', label: 'Direction', type: 'angle', default: 0 },
    EDGE,
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  float a = radians(direction);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 nrm = vec2(-dir.y, dir.x);
  float ph = dot(uv * compSize, dir) / wavelength * TAU - time * speed * TAU;
  vec2 off = nrm * sin(ph) * amplitude * compPx();
  return sampleEdge(source, uv + off, edgeMode);
}`,
    },
  ],
});

export const mosaic = fx({
  id: 'luscent.mosaic',
  name: 'Mosaic',
  category: 'Stylize',
  params: [{ id: 'blockSize', label: 'Block Size', type: 'pixels', default: 24, min: 1, max: 512 }],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec2 b = max(blockSize, 1.0) * compPx();
  return texture(source, (floor(uv / b) + 0.5) * b);
}`,
    },
  ],
});

export const mirror = fx({
  id: 'luscent.mirror',
  name: 'Mirror',
  category: 'Distort',
  params: [{ id: 'mode', label: 'Mode', type: 'choice', default: 0, options: ['Left → Right', 'Right → Left', 'Top → Bottom', 'Bottom → Top', 'Quad'] }],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv;
  if (mode < 0.5) p.x = p.x > 0.5 ? 1.0 - p.x : p.x;
  else if (mode < 1.5) p.x = p.x < 0.5 ? 1.0 - p.x : p.x;
  else if (mode < 2.5) p.y = p.y > 0.5 ? 1.0 - p.y : p.y;
  else if (mode < 3.5) p.y = p.y < 0.5 ? 1.0 - p.y : p.y;
  else p = abs(p - 0.5) * -1.0 + 0.5;
  return texture(source, p);
}`,
    },
  ],
});

// ---------------------------------------------------------------- colour

export const colorAdjust = fx({
  id: 'luscent.color-adjust',
  name: 'Color Adjust',
  category: 'Color',
  description: 'Exposure, brightness, contrast, saturation, hue and temperature in one pass.',
  params: [
    { id: 'exposure', label: 'Exposure', type: 'float', default: 0, min: -5, max: 5, step: 0.01, hint: 'stops' },
    { id: 'brightness', label: 'Brightness', type: 'float', default: 0, min: -100, max: 100, step: 0.2 },
    { id: 'contrast', label: 'Contrast', type: 'float', default: 0, min: -100, max: 100, step: 0.2 },
    { id: 'saturation', label: 'Saturation', type: 'percent', default: 100, min: 0, max: 300 },
    { id: 'hue', label: 'Hue Shift', type: 'angle', default: 0 },
    { id: 'temperature', label: 'Temperature', type: 'float', default: 0, min: -100, max: 100, step: 0.2 },
  ],
  passes: [
    {
      glsl: `vec3 hueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec4 effect(vec2 uv) {
  vec4 s = unpremultiply(texture(source, uv));
  vec3 c = s.rgb * exp2(exposure);
  c += brightness / 100.0;
  c = (c - 0.5) * (1.0 + contrast / 100.0) + 0.5;
  c = mix(vec3(luma(c)), c, saturation / 100.0);
  if (hue != 0.0) c = hueShift(c, radians(hue));
  c += vec3(temperature, temperature * 0.2, -temperature) / 400.0;
  return premultiply(vec4(clamp(c, 0.0, 1.0), s.a));
}`,
    },
  ],
});

export const tint = fx({
  id: 'luscent.tint',
  name: 'Tint',
  category: 'Color',
  params: [
    { id: 'black', label: 'Map Black To', type: 'color', default: [0.05, 0.02, 0.15, 1] },
    { id: 'white', label: 'Map White To', type: 'color', default: [1, 0.85, 0.95, 1] },
    { id: 'amount', label: 'Amount', type: 'percent', default: 100, min: 0, max: 100 },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec4 s = unpremultiply(texture(source, uv));
  vec3 t = mix(black.rgb, white.rgb, luma(s.rgb));
  return premultiply(vec4(mix(s.rgb, t, amount / 100.0), s.a));
}`,
    },
  ],
});

export const invert = fx({
  id: 'luscent.invert',
  name: 'Invert',
  category: 'Color',
  params: [{ id: 'amount', label: 'Blend With Original', type: 'percent', default: 0, min: 0, max: 100 }],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec4 s = unpremultiply(texture(source, uv));
  return premultiply(vec4(mix(1.0 - s.rgb, s.rgb, amount / 100.0), s.a));
}`,
    },
  ],
});

export const vignette = fx({
  id: 'luscent.vignette',
  name: 'Vignette',
  category: 'Color',
  params: [
    { id: 'amount', label: 'Amount', type: 'percent', default: 50, min: 0, max: 100 },
    { id: 'size', label: 'Size', type: 'percent', default: 60, min: 0, max: 150 },
    { id: 'softness', label: 'Softness', type: 'percent', default: 50, min: 1, max: 100 },
    { id: 'vcolor', label: 'Color', type: 'color', default: [0, 0, 0, 1] },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec4 c = texture(source, uv);
  vec2 d = (uv - 0.5) * vec2(compSize.x / compSize.y, 1.0);
  float r = length(d) / 0.7;
  float s = size / 100.0;
  float v = smoothstep(s, s + softness / 100.0, r) * amount / 100.0;
  return vec4(mix(c.rgb, vcolor.rgb * c.a, v), c.a);
}`,
    },
  ],
});

export const flash = fx({
  id: 'luscent.flash',
  name: 'Flash',
  category: 'Color',
  description: 'Blow the frame out toward a colour — keyframe Amount for beat flashes.',
  params: [
    { id: 'amount', label: 'Amount', type: 'percent', default: 100, min: 0, max: 100 },
    { id: 'fcolor', label: 'Color', type: 'color', default: [1, 1, 1, 1] },
    { id: 'mode', label: 'Mode', type: 'choice', default: 0, options: ['Exposure', 'Fill', 'Add'] },
  ],
  passes: [
    {
      glsl: `vec4 effect(vec2 uv) {
  vec4 c = texture(source, uv);
  float k = amount / 100.0;
  if (mode < 0.5) return vec4(clamp(c.rgb * (1.0 + k * 3.0) + fcolor.rgb * k * 0.6 * c.a, 0.0, 1.0), c.a);
  if (mode < 1.5) return vec4(mix(c.rgb, fcolor.rgb * c.a, k), c.a);
  return vec4(min(c.rgb + fcolor.rgb * k * c.a, 1.0), c.a);
}`,
    },
  ],
});

export const dropShadow = fx({
  id: 'luscent.drop-shadow',
  name: 'Drop Shadow',
  category: 'Perspective',
  description: 'Soft shadow behind text and cut-outs.',
  params: [
    { id: 'scolor', label: 'Shadow Color', type: 'color', default: [0, 0, 0, 1] },
    { id: 'opacity', label: 'Opacity', type: 'percent', default: 60, min: 0, max: 100 },
    { id: 'direction', label: 'Direction', type: 'angle', default: 135 },
    { id: 'dist', label: 'Distance', type: 'pixels', default: 12, min: 0, max: 500 },
    { id: 'softness', label: 'Softness', type: 'pixels', default: 16, min: 0, max: 200 },
  ],
  passes: [
    {
      id: 'sh',
      scale: 0.5,
      glsl: `vec4 effect(vec2 uv) {
  float a = radians(direction - 90.0);
  vec2 off = vec2(cos(a), sin(a)) * dist * compPx();
  return sampleEdge(source, uv - off, 0.0);
}`,
    },
    { id: 'sx', scale: 0.5, inputs: ['sh'], glsl: `vec4 effect(vec2 uv) { return blur1D(sh, uv, vec2(compPx().x, 0.0), softness, 0.0); }` },
    { id: 'sy', scale: 0.5, inputs: ['sx'], glsl: `vec4 effect(vec2 uv) { return blur1D(sx, uv, vec2(0.0, compPx().y), softness, 0.0); }` },
    {
      inputs: ['source', 'sy'],
      glsl: `vec4 effect(vec2 uv) {
  vec4 c = texture(source, uv);
  float sa = texture(sy, uv).a * opacity / 100.0 * scolor.a;
  vec4 s = vec4(scolor.rgb * sa, sa);
  return c + s * (1.0 - c.a);
}`,
    },
  ],
});

export const BUILTIN_EFFECTS: EffectPlugin[] = [
  gaussianBlur,
  directionalBlur,
  radialBlur,
  glow,
  chromaticAberration,
  rgbSplit,
  shake,
  transform,
  vhs,
  grain,
  glitch,
  lensDistortion,
  wave,
  mosaic,
  mirror,
  colorAdjust,
  tint,
  invert,
  vignette,
  flash,
  dropShadow,
];
