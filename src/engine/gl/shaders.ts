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
