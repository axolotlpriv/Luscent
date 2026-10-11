/**
 * Bundled shaders authored in ISF (Interactive Shader Format) and loaded
 * through the converter, exactly as a user-installed .fs file would be.
 * Written for Luscent; MIT licensed.
 */
export const ISF_SHADERS: Array<{ id: string; src: string }> = [
  {
    id: 'isf.kaleidoscope',
    src: `/*{
  "DESCRIPTION": "Kaleidoscope",
  "CREDIT": "Luscent",
  "CATEGORIES": ["Distortion Effect"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "segments", "LABEL": "Segments", "TYPE": "float", "DEFAULT": 6.0, "MIN": 1.0, "MAX": 24.0 },
    { "NAME": "spin", "LABEL": "Rotation", "TYPE": "float", "DEFAULT": 0.0, "MIN": -3.1416, "MAX": 3.1416 },
    { "NAME": "zoom", "LABEL": "Zoom", "TYPE": "float", "DEFAULT": 1.0, "MIN": 0.2, "MAX": 4.0 }
  ]
}*/
void main() {
  vec2 p = isf_FragNormCoord - 0.5;
  p.x *= RENDERSIZE.x / RENDERSIZE.y;
  float r = length(p) / zoom;
  float a = atan(p.y, p.x) + spin;
  float seg = 6.2831853 / max(segments, 1.0);
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q.x /= RENDERSIZE.x / RENDERSIZE.y;
  gl_FragColor = IMG_NORM_PIXEL(inputImage, fract(q + 0.5));
}`,
  },
  {
    id: 'isf.halftone',
    src: `/*{
  "DESCRIPTION": "Halftone",
  "CREDIT": "Luscent",
  "CATEGORIES": ["Stylize"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "dotSize", "LABEL": "Dot Size", "TYPE": "float", "DEFAULT": 14.0, "MIN": 2.0, "MAX": 80.0 },
    { "NAME": "angle", "LABEL": "Angle", "TYPE": "float", "DEFAULT": 0.785, "MIN": 0.0, "MAX": 3.1416 },
    { "NAME": "inkColor", "LABEL": "Ink", "TYPE": "color", "DEFAULT": [0.05, 0.05, 0.08, 1.0] },
    { "NAME": "paperColor", "LABEL": "Paper", "TYPE": "color", "DEFAULT": [1.0, 0.96, 0.9, 1.0] }
  ]
}*/
void main() {
  vec2 px = isf_FragNormCoord * RENDERSIZE;
  float c = cos(angle), s = sin(angle);
  vec2 r = mat2(c, -s, s, c) * px;
  vec2 cell = floor(r / dotSize) * dotSize + dotSize * 0.5;
  vec2 center = mat2(c, s, -s, c) * cell;
  vec4 src = IMG_PIXEL(inputImage, center);
  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  float radius = (1.0 - lum) * dotSize * 0.6;
  float d = length(r - cell);
  float ink = 1.0 - smoothstep(radius - 1.0, radius + 1.0, d);
  gl_FragColor = vec4(mix(paperColor.rgb, inkColor.rgb, ink), src.a);
}`,
  },
  {
    id: 'isf.posterize',
    src: `/*{
  "DESCRIPTION": "Posterize",
  "CREDIT": "Luscent",
  "CATEGORIES": ["Color Effect"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "levels", "LABEL": "Levels", "TYPE": "float", "DEFAULT": 5.0, "MIN": 2.0, "MAX": 32.0 },
    { "NAME": "gamma", "LABEL": "Gamma", "TYPE": "float", "DEFAULT": 1.0, "MIN": 0.3, "MAX": 3.0 }
  ]
}*/
void main() {
  vec4 c = IMG_THIS_PIXEL(inputImage);
  vec3 g = pow(c.rgb, vec3(gamma));
  g = floor(g * levels + 0.5) / levels;
  gl_FragColor = vec4(pow(g, vec3(1.0 / gamma)), c.a);
}`,
  },
  {
    id: 'isf.edge-neon',
    src: `/*{
  "DESCRIPTION": "Edge Neon",
  "CREDIT": "Luscent",
  "CATEGORIES": ["Stylize"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "strength", "LABEL": "Strength", "TYPE": "float", "DEFAULT": 3.0, "MIN": 0.0, "MAX": 10.0 },
    { "NAME": "neon", "LABEL": "Color", "TYPE": "color", "DEFAULT": [0.2, 1.0, 0.9, 1.0] },
    { "NAME": "keepImage", "LABEL": "Keep Image", "TYPE": "bool", "DEFAULT": true }
  ]
}*/
void main() {
  vec2 t = 1.0 / RENDERSIZE;
  vec2 uv = isf_FragNormCoord;
  float tl = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(-1, 1)).rgb, vec3(0.333));
  float tc = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(0, 1)).rgb, vec3(0.333));
  float tr = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(1, 1)).rgb, vec3(0.333));
  float ml = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(-1, 0)).rgb, vec3(0.333));
  float mr = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(1, 0)).rgb, vec3(0.333));
  float bl = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(-1, -1)).rgb, vec3(0.333));
  float bc = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(0, -1)).rgb, vec3(0.333));
  float br = dot(IMG_NORM_PIXEL(inputImage, uv + t * vec2(1, -1)).rgb, vec3(0.333));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  float e = clamp(length(vec2(gx, gy)) * strength, 0.0, 1.0);
  vec4 base = IMG_THIS_PIXEL(inputImage);
  vec3 col = (keepImage ? base.rgb * 0.6 : vec3(0.0)) + neon.rgb * e;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), max(base.a, e));
}`,
  },
  {
    id: 'isf.soft-bloom',
    src: `/*{
  "DESCRIPTION": "Soft Bloom (multi-pass)",
  "CREDIT": "Luscent",
  "CATEGORIES": ["Stylize"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "spread", "LABEL": "Spread", "TYPE": "float", "DEFAULT": 6.0, "MIN": 0.0, "MAX": 30.0 },
    { "NAME": "amount", "LABEL": "Amount", "TYPE": "float", "DEFAULT": 0.8, "MIN": 0.0, "MAX": 3.0 }
  ],
  "PASSES": [ { "TARGET": "blurH" }, { "TARGET": "blurV" }, {} ]
}*/
vec4 blur(vec2 uv, vec2 dir, int pass) {
  vec4 acc = vec4(0.0);
  float w = 0.0;
  for (int i = -8; i <= 8; i++) {
    float k = exp(-float(i * i) / 18.0);
    vec2 o = dir * float(i) * spread / RENDERSIZE;
    acc += (pass == 0 ? IMG_NORM_PIXEL(inputImage, uv + o) : IMG_NORM_PIXEL(blurH, uv + o)) * k;
    w += k;
  }
  return acc / w;
}
void main() {
  vec2 uv = isf_FragNormCoord;
  if (PASSINDEX == 0) gl_FragColor = blur(uv, vec2(1.0, 0.0), 0);
  else if (PASSINDEX == 1) gl_FragColor = blur(uv, vec2(0.0, 1.0), 1);
  else {
    vec4 b = IMG_NORM_PIXEL(blurV, uv);
    vec4 c = IMG_THIS_PIXEL(inputImage);
    gl_FragColor = vec4(min(c.rgb + b.rgb * amount, 1.0), c.a);
  }
}`,
  },
];
