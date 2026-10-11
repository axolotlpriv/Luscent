/**
 * Luscent effect plugin format (see docs/PLUGINS.md).
 *
 * A plugin is plain JSON: metadata, a parameter schema and one or more
 * shader passes. GLSL passes run on the WebGL2 compositor; a plugin may
 * instead (or additionally) ship a WGSL pass, which runs on WebGPU.
 */
export type ParamType = 'float' | 'int' | 'angle' | 'percent' | 'pixels' | 'point' | 'vec2' | 'color' | 'bool' | 'choice';

export interface ParamSpec {
  /** Uniform name in the shader; must be a valid GLSL identifier. */
  id: string;
  label?: string;
  type: ParamType;
  /**
   * Default value: number for scalar types (bool 0/1, choice index), [x, y]
   * for vec2, [x, y] in 0..1 of the composition for points, [r, g, b, a]
   * for colors.
   */
  default: number | number[];
  min?: number;
  max?: number;
  /** Scrub step per pixel. */
  step?: number;
  /** Labels for `choice`. */
  options?: string[];
  hint?: string;
}

export interface PassSpec {
  /** Output name other passes can read as an input sampler. */
  id?: string;
  /**
   * Sampler inputs. Built-in names: "source" (the layer being processed,
   * or `from` / `to` for transitions) and earlier pass ids. Defaults to the
   * previous pass (or "source" for the first).
   */
  inputs?: string[];
  /** Render this pass at a fraction of the frame size (e.g. 0.5 for blurs). */
  scale?: number;
  /** GLSL ES 3.00 fragment code defining `vec4 effect(vec2 uv)`. */
  glsl: string;
  /**
   * Helper library to include: "full" (default: hash, noise, luma, blur1D…)
   * or "minimal" (only `lsc_`-prefixed helpers, for ported shaders whose own
   * function names might collide).
   */
  prelude?: 'full' | 'minimal';
}

export type PluginKind = 'effect' | 'transition';

export interface PluginSource {
  format: 'luscent' | 'gl-transition' | 'isf' | 'shadertoy' | 'glsl';
  /** Original shader text before conversion (kept for re-conversion / sharing). */
  original?: string;
  url?: string;
}

export interface EffectPlugin {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  category: string;
  description?: string;
  author?: string;
  license?: string;
  tags?: string[];
  params: ParamSpec[];
  passes?: PassSpec[];
  /** WGSL module with `fn effect(uv: vec2f) -> vec4f` (see docs/PLUGINS.md). */
  wgsl?: string;
  source?: PluginSource;
  /** Ships with Luscent (cannot be uninstalled, only shadowed). */
  builtin?: boolean;
}

export const PLUGIN_FORMAT = 'luscent-effect';

/** Transition plugins automatically get these two parameters. */
export const TRANSITION_PARAMS: ParamSpec[] = [
  { id: 'duration', label: 'Duration', type: 'float', default: 0.4, min: 0.03, max: 10, step: 0.01, hint: 'seconds' },
  { id: 'placement', label: 'Placement', type: 'choice', default: 0, options: ['In (start of layer)', 'Out (end of layer)'] },
];

const GLSL_RESERVED = new Set([
  'source', 'from', 'to', 'progress', 'time', 'layerTime', 'resolution', 'compSize', 'renderScale', 'seed', 'uv', 'effect', 'main',
  'float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'sampler2D', 'in', 'out', 'inout', 'uniform', 'const',
  'if', 'else', 'for', 'while', 'return', 'discard', 'break', 'continue', 'true', 'false', 'texture', 'mix', 'step', 'smoothstep',
  'clamp', 'min', 'max', 'abs', 'sin', 'cos', 'length', 'dot', 'normalize', 'fract', 'floor', 'mod', 'pow', 'exp', 'log', 'sqrt',
  'ratio', 'fragColor', 'distance', 'cross', 'reflect', 'refract', 'faceforward', 'radians', 'degrees', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'exp2', 'log2', 'inversesqrt', 'sign', 'ceil', 'round', 'trunc', 'isnan', 'isinf', 'equal', 'any', 'all', 'not',
  'mat', 'struct', 'void', 'return', 'highp', 'mediump', 'lowp', 'precision', 'sample', 'filter', 'input', 'output', 'common', 'partition',
  'active', 'attribute', 'varying', 'layout', 'centroid', 'flat', 'smooth', 'invariant', 'switch', 'case', 'default', 'do',
]);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Structural validation of a plugin (shader compilation is checked by the renderer). */
export function validatePlugin(p: unknown): ValidationResult {
  const errors: string[] = [];
  const o = p as EffectPlugin;
  if (!o || typeof o !== 'object') return { ok: false, errors: ['Plugin must be an object.'] };
  if (typeof o.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(o.id)) errors.push('id must be a non-empty identifier like "author.effect-name".');
  if (typeof o.name !== 'string' || !o.name.trim()) errors.push('name is required.');
  if (o.kind !== 'effect' && o.kind !== 'transition') errors.push('kind must be "effect" or "transition".');
  if (!Array.isArray(o.params)) errors.push('params must be an array.');
  else {
    const seen = new Set<string>();
    for (const prm of o.params) {
      if (!prm || typeof prm.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prm.id)) errors.push(`param id "${prm?.id}" is not a valid identifier.`);
      else if (GLSL_RESERVED.has(prm.id)) errors.push(`param id "${prm.id}" is reserved.`);
      else if (seen.has(prm.id)) errors.push(`duplicate param id "${prm.id}".`);
      seen.add(prm?.id);
      const types = ['float', 'int', 'angle', 'percent', 'pixels', 'point', 'vec2', 'color', 'bool', 'choice'];
      if (!types.includes(prm?.type)) errors.push(`param "${prm?.id}" has unknown type "${prm?.type}".`);
      const want = prm?.type === 'color' ? 4 : prm?.type === 'point' || prm?.type === 'vec2' ? 2 : 1;
      const d = prm?.default;
      const len = Array.isArray(d) ? d.length : typeof d === 'number' ? 1 : 0;
      if (len !== want) errors.push(`param "${prm?.id}" default must have ${want} value${want > 1 ? 's' : ''}.`);
      if (prm?.type === 'choice' && (!Array.isArray(prm.options) || prm.options.length === 0)) errors.push(`choice param "${prm.id}" needs options.`);
    }
  }
  const hasGlsl = Array.isArray(o.passes) && o.passes.length > 0;
  if (!hasGlsl && typeof o.wgsl !== 'string') errors.push('provide GLSL passes or a WGSL shader.');
  if (hasGlsl) {
    o.passes!.forEach((ps, i) => {
      if (typeof ps.glsl !== 'string' || !/vec4\s+effect\s*\(\s*vec2/.test(ps.glsl)) errors.push(`pass ${i + 1} must define "vec4 effect(vec2 uv)".`);
      if (ps.scale !== undefined && !(ps.scale > 0 && ps.scale <= 1)) errors.push(`pass ${i + 1} scale must be in (0, 1].`);
    });
  }
  if (typeof o.wgsl === 'string' && !/fn\s+effect\s*\(/.test(o.wgsl)) errors.push('WGSL shader must define "fn effect(uv: vec2f) -> vec4f".');
  return { ok: errors.length === 0, errors };
}

/** All params a plugin exposes (transitions get duration + placement). */
export function pluginParams(p: EffectPlugin): ParamSpec[] {
  return p.kind === 'transition' ? [...TRANSITION_PARAMS, ...p.params] : p.params;
}
