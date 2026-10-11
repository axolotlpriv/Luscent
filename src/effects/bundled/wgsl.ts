/** A WGSL-only sample plugin (runs on WebGPU through the bridge). MIT. */
import type { EffectPlugin } from '../../core/effects/types';

export const WGSL_SAMPLES: EffectPlugin[] = [
  {
    id: 'wgsl.ripple',
    name: 'Ripple (WGSL)',
    version: '1.0.0',
    kind: 'effect',
    category: 'WebGPU',
    description: 'Concentric water ripple written in WGSL; runs on WebGPU.',
    author: 'Luscent',
    license: 'MIT',
    builtin: true,
    params: [
      { id: 'amplitude', label: 'Amplitude', type: 'pixels', default: 10, min: 0, max: 200 },
      { id: 'wavelength', label: 'Wavelength', type: 'pixels', default: 60, min: 4, max: 1000 },
      { id: 'speed', label: 'Speed', type: 'float', default: 2, min: -20, max: 20, step: 0.05 },
      { id: 'center', label: 'Center', type: 'point', default: [0.5, 0.5] },
    ],
    source: { format: 'luscent' },
    wgsl: `fn effect(uv: vec2f) -> vec4f {
  let aspect = vec2f(compSize.x / compSize.y, 1.0);
  let d = (uv - center) * aspect;
  let r = length(d) * compSize.y;
  let dir = select(vec2f(0.0), normalize(d), r > 0.0);
  let w = sin(r / wavelength * 6.2831853 - time * speed * 6.2831853);
  let off = dir / aspect * w * amplitude / compSize.y;
  return sampleSource(uv + off);
}`,
  },
];
