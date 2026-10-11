/** GLSL ES 3.00 programs for the WebGL2 compositor. All outputs are premultiplied. */

export const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
// Layer space -> clip space (affine, column-major 3x3).
uniform mat3 uMVP;
// Content quad in layer space: x, y, w, h.
uniform vec4 uRect;
out vec2 vUV;
out vec2 vLocal;
void main() {
  vUV = aPos;
  vLocal = uRect.xy + aPos * uRect.zw;
  vec3 p = uMVP * vec3(vLocal, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const TEXTURE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUV) * uOpacity;
}`;

/**
 * Analytic shapes via signed distance fields. Crisp at any scale and cheap,
 * which matters because solids and shapes are the bread and butter of
 * short-form edits (flashes, bars, punch-in frames).
 */
export const SHAPE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
uniform int uShape;          // 0 = rounded rect, 1 = ellipse
uniform vec2 uSize;
uniform float uRoundness;
uniform vec4 uFill;          // straight alpha
uniform vec4 uStroke;        // straight alpha
uniform float uStrokeWidth;
uniform float uOpacity;
uniform vec2 uOrigin;        // shape centre in layer space
out vec4 outColor;

float sdRoundRect(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdEllipse(vec2 p, vec2 r) {
  r = max(r, vec2(1e-3));
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

void main() {
  vec2 p = vLocal - uOrigin;
  vec2 half_ = uSize * 0.5;
  float d = uShape == 0 ? sdRoundRect(p, half_, uRoundness) : sdEllipse(p, half_);
  float aa = max(fwidth(d), 1e-4);
  float fillCov = clamp(0.5 - d / aa, 0.0, 1.0);
  vec4 col = vec4(uFill.rgb * uFill.a, uFill.a) * fillCov;
  if (uStrokeWidth > 0.0) {
    float sd = abs(d) - uStrokeWidth * 0.5;
    float strokeCov = clamp(0.5 - sd / aa, 0.0, 1.0);
    vec4 s = vec4(uStroke.rgb * uStroke.a, uStroke.a) * strokeCov;
    col = s + col * (1.0 - s.a);
  }
  outColor = col * uOpacity;
}`;

/** Fullscreen pass: vUV (0,0) is the top-left of the frame in offscreen targets. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
uniform float uFlipY;
out vec2 vUV;
void main() {
  vUV = vec2(aPos.x, uFlipY > 0.5 ? 1.0 - aPos.y : aPos.y);
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() { outColor = texture(uTex, vUV) * uOpacity; }`;

/** Adjustment layers: blend the processed frame in where the layer's mask covers. */
export const MIX_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uMask;
out vec4 outColor;
void main() {
  float m = texture(uMask, vUV).a;
  outColor = mix(texture(uA, vUV), texture(uB, vUV), m);
}`;

/** Separable + non-separable blend modes (W3C Compositing Level 1) on premultiplied input. */
export const BLEND_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uBackdrop;
uniform sampler2D uSource;
uniform float uOpacity;
uniform int uMode;
out vec4 outColor;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c); float n = min(min(c.r, c.g), c.b); float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b); float mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softLight1(float b, float s) {
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
}
float dodge(float b, float s) { return b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float hardLight1(float b, float s) { return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)); }

vec3 blendFn(vec3 b, vec3 s) {
  if (uMode == 3) return b * s;                                   // multiply
  if (uMode == 2) return b + s - b * s;                            // screen
  if (uMode == 4) return max(b, s);                                // lighten
  if (uMode == 5) return min(b, s);                                // darken
  if (uMode == 6) return vec3(hardLight1(s.r, b.r), hardLight1(s.g, b.g), hardLight1(s.b, b.b)); // overlay
  if (uMode == 7) return vec3(softLight1(b.r, s.r), softLight1(b.g, s.g), softLight1(b.b, s.b));
  if (uMode == 8) return vec3(hardLight1(b.r, s.r), hardLight1(b.g, s.g), hardLight1(b.b, s.b));
  if (uMode == 9) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (uMode == 10) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (uMode == 11) return abs(b - s);
  if (uMode == 12) return b + s - 2.0 * b * s;
  if (uMode == 13) return max(b - s, 0.0);
  if (uMode == 14) return vec3(s.r > 0.0 ? min(1.0, b.r / s.r) : 1.0, s.g > 0.0 ? min(1.0, b.g / s.g) : 1.0, s.b > 0.0 ? min(1.0, b.b / s.b) : 1.0);
  if (uMode == 15) return setLum(setSat(s, sat(b)), lum(b));       // hue
  if (uMode == 16) return setLum(setSat(b, sat(s)), lum(b));       // saturation
  if (uMode == 17) return setLum(s, lum(b));                       // color
  if (uMode == 18) return setLum(b, lum(s));                       // luminosity
  if (uMode == 1) return min(b + s, 1.0);                          // add
  return s;                                                        // normal
}

void main() {
  vec4 b = texture(uBackdrop, vUV);
  vec4 s = texture(uSource, vUV) * uOpacity;
  if (uMode == 1) { outColor = min(b + s, 1.0); return; }
  vec3 Cb = b.a > 0.0 ? b.rgb / b.a : vec3(0.0);
  vec3 Cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 B = clamp(blendFn(Cb, Cs), 0.0, 1.0);
  vec3 co = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * B;
  float ao = s.a + b.a * (1.0 - s.a);
  outColor = vec4(co, ao);
}`;

export const BLEND_MODE_INDEX: Record<string, number> = {
  normal: 0,
  add: 1,
  screen: 2,
  multiply: 3,
  lighten: 4,
  darken: 5,
  overlay: 6,
  softLight: 7,
  hardLight: 8,
  colorDodge: 9,
  colorBurn: 10,
  difference: 11,
  exclusion: 12,
  subtract: 13,
  divide: 14,
  hue: 15,
  saturation: 16,
  color: 17,
  luminosity: 18,
};
