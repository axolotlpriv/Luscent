/**
 * Bundled Shadertoy-style shaders (mainImage), loaded through the converter.
 * Written for Luscent; MIT licensed.
 */
export const SHADERTOY_SHADERS: Array<{ id: string; name: string; src: string }> = [
  {
    id: 'shadertoy.film-burn',
    name: 'Film Burn',
    src: `// Light-leak / film burn overlay.
uniform float intensity; // = 0.8 [0, 2] Intensity
uniform float speed; // = 0.4 [0, 4] Speed
uniform vec3 warm; // = vec3(1.0, 0.45, 0.1) Leak Color

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec4 img = texture(iChannel0, uv);
  float t = iTime * speed;
  float n = vnoise(uv * 2.5 + vec2(t, -t * 0.7)) * 0.6 + vnoise(uv * 6.0 - t) * 0.4;
  float edge = smoothstep(0.35, 1.0, uv.x + n * 0.6 - 0.2);
  vec3 leak = warm * edge * intensity;
  fragColor = vec4(img.rgb + leak * (1.0 - img.rgb * 0.5), 1.0);
}`,
  },
  {
    id: 'shadertoy.crt',
    name: 'CRT Screen',
    src: `// Curved CRT tube with scanlines and RGB mask.
uniform float curve; // = 0.25 [0, 1] Curvature
uniform float lines; // = 0.5 [0, 1] Scanlines
uniform float mask; // = 0.35 [0, 1] RGB Mask

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + curve * 0.25 * dot(c.yx, c.yx);
  uv = c * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 col = texture(iChannel0, uv).rgb;
  float s = 0.5 + 0.5 * sin(fragCoord.y * 3.14159);
  col *= 1.0 - lines * 0.5 * s;
  float m = mod(fragCoord.x, 3.0);
  vec3 rgbMask = m < 1.0 ? vec3(1.0, 0.7, 0.7) : (m < 2.0 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0));
  col *= mix(vec3(1.0), rgbMask, mask);
  float v = smoothstep(1.4, 0.4, length(c));
  fragColor = vec4(col * v * 1.15, 1.0);
}`,
  },
];
