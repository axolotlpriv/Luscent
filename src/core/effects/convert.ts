/**
 * Shader converter: ports existing shaders to Luscent effect plugins.
 *
 * Supported inputs
 *  - gl-transitions (`vec4 transition(vec2 uv)` + getFromColor/getToColor)
 *  - ISF (Interactive Shader Format: JSON header comment + GLSL, incl. multi-pass)
 *  - Shadertoy (`void mainImage(out vec4, in vec2)`)
 *  - plain Luscent GLSL (`vec4 effect(vec2 uv)`)
 *
 * Parameters come from the format's own metadata (ISF INPUTS, gl-transitions
 * defaults) or from annotated uniforms: `uniform float amount; // = 0.5 [0, 1] Amount`.
 * Anything that can't be mapped (extra textures, audio inputs, persistent
 * buffers, mouse input…) is listed in the conversion report.
 */
import { validatePlugin, type EffectPlugin, type ParamSpec, type PassSpec, type PluginKind, type PluginSource } from './types';

export type ShaderFormat = 'gl-transition' | 'isf' | 'shadertoy' | 'glsl';

export interface ConversionReport {
  format: ShaderFormat;
  warnings: string[];
  /** Features that were dropped; the shader may not look identical. */
  unsupported: string[];
}

export interface ConversionResult {
  plugin: EffectPlugin;
  report: ConversionReport;
}

export interface ConvertOptions {
  id?: string;
  name?: string;
  category?: string;
  author?: string;
  license?: string;
  description?: string;
  /** gl-transitions metadata (from the gl-transitions package). */
  defaults?: Record<string, unknown>;
  paramMeta?: Record<string, { type?: string; default?: unknown; min?: number; max?: number; step?: number; color?: boolean; description?: string }>;
}

export function detectFormat(src: string): ShaderFormat | null {
  if (/^\s*\/\*[\s\S]*?"INPUTS"[\s\S]*?\*\//.test(src) || /^\s*\/\*\s*\{[\s\S]*?\}\s*\*\//.test(src)) return 'isf';
  if (/vec4\s+transition\s*\(\s*vec2/.test(src) && /getFromColor|getToColor/.test(src)) return 'gl-transition';
  if (/void\s+mainImage\s*\(/.test(src)) return 'shadertoy';
  if (/vec4\s+effect\s*\(\s*vec2/.test(src)) return 'glsl';
  return null;
}

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'shader';

/** Identifiers our generated shader already owns. */
const OWNED = new Set([
  'source', 'from', 'to', 'progress', 'time', 'layerTime', 'resolution', 'compSize', 'renderScale', 'seed', 'effect', 'main', 'ratio',
  'length', 'distance', 'texture', 'mix', 'step', 'smoothstep', 'clamp', 'min', 'max', 'abs', 'sin', 'cos', 'dot', 'normalize',
  'fract', 'floor', 'mod', 'pow', 'exp', 'log', 'sqrt', 'sample', 'filter', 'input', 'output', 'common', 'active', 'partition',
]);

interface UniformDecl {
  type: string;
  name: string;
  defaultText?: string;
  min?: number;
  max?: number;
  label?: string;
}

const UNIFORM_RE = /^[ \t]*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(float|int|bool|vec2|vec3|vec4|ivec2|sampler2D)\s+(\w+)\s*;[ \t]*(?:\/\/[ \t]*(.*))?$/gm;

function parseUniforms(src: string): { decls: UniformDecl[]; stripped: string } {
  const decls: UniformDecl[] = [];
  const stripped = src.replace(UNIFORM_RE, (_m, type: string, name: string, comment?: string) => {
    const d: UniformDecl = { type, name };
    if (comment) {
      const m = /^=\s*([^[\]]+?)\s*(?:\[\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\])?\s*([^[\]]*)$/.exec(comment.trim());
      if (m) {
        d.defaultText = m[1].trim().replace(/;$/, '');
        if (m[2] !== undefined) d.min = Number(m[2]);
        if (m[3] !== undefined) d.max = Number(m[3]);
        if (m[4]?.trim()) d.label = m[4].trim();
      }
    }
    decls.push(d);
    return `// (uniform ${name} provided by Luscent)`;
  });
  return { decls, stripped };
}

/** Parse "0.5", "true", "vec3(1.0, 0.0, 0.0)", "ivec2(4)" into numbers. */
export function parseGlslValue(text: string | undefined, components: number): number[] | null {
  if (text === undefined) return null;
  const t = text.trim();
  if (t === 'true') return [1];
  if (t === 'false') return [0];
  const m = /^[a-z]*\d?\s*\(([^)]*)\)$/i.exec(t);
  const parts = (m ? m[1] : t).split(',').map((x) => Number(x.trim()));
  if (parts.some((x) => !Number.isFinite(x))) return null;
  if (parts.length === 1 && components > 1) return Array(components).fill(parts[0]);
  return parts;
}

interface ParamMapping {
  spec: ParamSpec;
  /** Extra preprocessor line mapping the original identifier onto the uniform. */
  define?: string;
}

/** Map a declared shader uniform onto a Luscent parameter (+ adapter macro). */
function mapParam(
  name: string,
  glslType: string,
  defaultValue: unknown,
  meta: { min?: number; max?: number; step?: number; label?: string; color?: boolean; description?: string },
  report: ConversionReport,
): ParamMapping | null {
  const needsAlias = OWNED.has(name);
  const label = meta.label ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const num = (v: unknown, n: number): number[] => {
    if (Array.isArray(v)) return v.map(Number);
    if (typeof v === 'boolean') return [v ? 1 : 0];
    if (typeof v === 'number') return Array(n).fill(v);
    return Array(n).fill(0);
  };
  const base = { label, hint: meta.description };
  switch (glslType) {
    case 'float': {
      const id = needsAlias ? `${name}_` : name;
      return {
        spec: { ...base, id, type: 'float', default: num(defaultValue, 1)[0], min: meta.min, max: meta.max, step: meta.step },
        define: needsAlias ? `#define ${name} ${id}` : undefined,
      };
    }
    case 'int':
      return { spec: { ...base, id: `${name}_i`, type: 'int', default: num(defaultValue, 1)[0], min: meta.min, max: meta.max, step: meta.step ?? 0.05 }, define: `#define ${name} int(${name}_i)` };
    case 'bool':
      return { spec: { ...base, id: `${name}_b`, type: 'bool', default: num(defaultValue, 1)[0] ? 1 : 0 }, define: `#define ${name} (${name}_b > 0.5)` };
    case 'vec2': {
      const id = needsAlias ? `${name}_` : name;
      const d = num(defaultValue, 2);
      return { spec: { ...base, id, type: 'vec2', default: [d[0] ?? 0, d[1] ?? 0], step: meta.step ?? 0.005 }, define: needsAlias ? `#define ${name} ${id}` : undefined };
    }
    case 'ivec2': {
      const d = num(defaultValue, 2);
      return { spec: { ...base, id: `${name}_iv`, type: 'vec2', default: [d[0] ?? 0, d[1] ?? 0], step: 0.05 }, define: `#define ${name} ivec2(${name}_iv)` };
    }
    case 'vec3': {
      const d = num(defaultValue, 3);
      if (!meta.color) report.warnings.push(`vec3 "${name}" is edited as a colour.`);
      return { spec: { ...base, id: `${name}_c3`, type: 'color', default: [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, 1] }, define: `#define ${name} (${name}_c3.rgb)` };
    }
    case 'vec4': {
      const d = num(defaultValue, 4);
      const id = needsAlias ? `${name}_` : name;
      if (!meta.color) report.warnings.push(`vec4 "${name}" is edited as a colour.`);
      return { spec: { ...base, id, type: 'color', default: [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 1] }, define: needsAlias ? `#define ${name} ${id}` : undefined };
    }
    default:
      report.unsupported.push(`uniform ${glslType} ${name}`);
      return null;
  }
}

function finish(plugin: EffectPlugin, report: ConversionReport): ConversionResult {
  const v = validatePlugin(plugin);
  if (!v.ok) throw new Error(`Conversion produced an invalid plugin: ${v.errors.join(' ')}`);
  return { plugin, report };
}

function baseMeta(opts: ConvertOptions, fallbackName: string, kind: PluginKind, format: PluginSource['format'], original: string) {
  const name = opts.name ?? fallbackName;
  return {
    id: opts.id ?? `user.${slug(name)}`,
    name,
    version: '1.0.0',
    kind,
    category: opts.category ?? (kind === 'transition' ? 'Converted' : 'Converted'),
    description: opts.description,
    author: opts.author,
    license: opts.license,
    source: { format, original },
  };
}

/** Header comments like "// Author: X" / "// License: MIT". */
function headerField(src: string, field: string): string | undefined {
  const m = new RegExp(`^\\s*//\\s*${field}\\s*:\\s*(.+)$`, 'mi').exec(src);
  return m ? m[1].trim() : undefined;
}

// ------------------------------------------------------------------ gl-transitions

export function convertGlTransition(src: string, opts: ConvertOptions = {}): ConversionResult {
  const report: ConversionReport = { format: 'gl-transition', warnings: [], unsupported: [] };
  const { decls, stripped } = parseUniforms(src);
  const params: ParamSpec[] = [];
  const defines: string[] = [];
  for (const d of decls) {
    if (d.name === 'ratio' || d.name === 'progress') continue;
    const meta = opts.paramMeta?.[d.name] ?? {};
    const def = opts.defaults?.[d.name] ?? meta.default ?? parseGlslValue(d.defaultText, d.type === 'vec2' || d.type === 'ivec2' ? 2 : d.type === 'vec3' ? 3 : d.type === 'vec4' ? 4 : 1);
    const mapped = mapParam(d.name, d.type, def, { ...meta, min: meta.min ?? d.min, max: meta.max ?? d.max, label: d.label }, report);
    if (!mapped) continue;
    params.push(mapped.spec);
    if (mapped.define) defines.push(mapped.define);
  }
  if (report.unsupported.some((u) => u.startsWith('uniform sampler2D'))) {
    throw new Error(`Needs extra textures (${report.unsupported.join(', ')}), which Luscent transitions don't provide yet.`);
  }
  const body = stripped.replace(/\btexture2D\s*\(/g, 'texture(');
  // A global (not a macro): some transitions use "ratio" as a local name too.
  const glsl = `float ratio;
${defines.join('\n')}
vec4 getFromColor(vec2 p) { return texture(from, vec2(p.x, 1.0 - p.y)); }
vec4 getToColor(vec2 p) { return texture(to, vec2(p.x, 1.0 - p.y)); }
${body}
vec4 effect(vec2 uv) { ratio = compSize.x / compSize.y; return transition(vec2(uv.x, 1.0 - uv.y)); }`;
  const name = opts.name ?? 'Transition';
  const plugin: EffectPlugin = {
    ...baseMeta({ ...opts, author: opts.author ?? headerField(src, 'Author'), license: opts.license ?? headerField(src, 'License') }, name, 'transition', 'gl-transition', src),
    params,
    passes: [{ glsl, prelude: 'minimal' }],
  };
  return finish(plugin, report);
}

// ------------------------------------------------------------------ ISF

interface IsfInput {
  NAME: string;
  TYPE: string;
  DEFAULT?: unknown;
  MIN?: unknown;
  MAX?: unknown;
  LABEL?: string;
  VALUES?: number[];
  LABELS?: string[];
}

export function convertIsf(src: string, opts: ConvertOptions = {}): ConversionResult {
  const report: ConversionReport = { format: 'isf', warnings: [], unsupported: [] };
  const m = /^\s*\/\*([\s\S]*?)\*\//.exec(src);
  if (!m) throw new Error('ISF shader is missing its JSON header comment.');
  let header: { DESCRIPTION?: string; CREDIT?: string; CATEGORIES?: string[]; INPUTS?: IsfInput[]; PASSES?: Array<{ TARGET?: string; PERSISTENT?: boolean }> };
  try {
    header = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`ISF header is not valid JSON: ${(err as Error).message}`);
  }
  let code = src.slice(m.index + m[0].length).replace(/^\s*#version.*$/gm, '');
  const inputs = header.INPUTS ?? [];
  const isTransition =
    (header.CATEGORIES ?? []).some((c) => /transition/i.test(c)) || (inputs.some((i) => i.NAME === 'startImage') && inputs.some((i) => i.NAME === 'endImage'));
  const params: ParamSpec[] = [];
  const defines: string[] = [];
  const images: string[] = [];
  for (const inp of inputs) {
    const label = inp.LABEL ?? inp.NAME;
    switch (inp.TYPE) {
      case 'image':
        if (inp.NAME === 'inputImage' || inp.NAME === 'startImage' || inp.NAME === 'endImage') images.push(inp.NAME);
        else report.unsupported.push(`image input "${inp.NAME}"`);
        break;
      case 'float': {
        if (isTransition && inp.NAME === 'progress') break;
        const mp = mapParam(inp.NAME, 'float', inp.DEFAULT ?? 0, { min: num(inp.MIN), max: num(inp.MAX), label }, report);
        if (mp) {
          params.push(mp.spec);
          if (mp.define) defines.push(mp.define);
        }
        break;
      }
      case 'bool':
      case 'event': {
        const mp = mapParam(inp.NAME, 'bool', inp.DEFAULT ?? false, { label }, report);
        params.push(mp!.spec);
        defines.push(mp!.define!);
        if (inp.TYPE === 'event') report.warnings.push(`event "${inp.NAME}" is a toggle.`);
        break;
      }
      case 'long': {
        if (inp.VALUES && inp.LABELS) {
          const idx = Math.max(0, inp.VALUES.indexOf(Number(inp.DEFAULT ?? inp.VALUES[0])));
          params.push({ id: `${inp.NAME}_ix`, label, type: 'choice', default: idx, options: inp.LABELS.map(String) });
          defines.push(`#define ${inp.NAME} (int[](${inp.VALUES.map((v) => Math.round(v)).join(',')})[int(${inp.NAME}_ix + 0.5)])`);
        } else {
          const mp = mapParam(inp.NAME, 'int', inp.DEFAULT ?? 0, { min: num(inp.MIN), max: num(inp.MAX), label }, report);
          params.push(mp!.spec);
          defines.push(mp!.define!);
        }
        break;
      }
      case 'point2D': {
        // ISF points are in pixels of the render size; keep raw values.
        const mp = mapParam(inp.NAME, 'vec2', inp.DEFAULT ?? [0, 0], { label }, report);
        params.push(mp!.spec);
        if (mp!.define) defines.push(mp!.define);
        report.warnings.push(`point2D "${inp.NAME}" stays in render pixels.`);
        break;
      }
      case 'color': {
        const mp = mapParam(inp.NAME, 'vec4', inp.DEFAULT ?? [1, 1, 1, 1], { label, color: true }, report);
        params.push(mp!.spec);
        if (mp!.define) defines.push(mp!.define);
        break;
      }
      default:
        report.unsupported.push(`${inp.TYPE} input "${inp.NAME}"`);
    }
  }
  code = code.replace(/\bgl_FragColor\b/g, 'isf_FragColor').replace(/\btexture2D\s*\(/g, 'texture(').replace(/\bvoid\s+main\s*\(\s*(void)?\s*\)/, 'void isf_main()');
  const passes = header.PASSES?.length ? header.PASSES : [{}];
  if (passes.some((p) => p.PERSISTENT)) report.unsupported.push('persistent buffers (feedback effects render without history)');
  const targets = passes.map((p, i) => p.TARGET ?? `isfpass${i}`);
  const imageAliases = isTransition ? ['#define startImage from', '#define endImage to'] : ['#define inputImage source'];
  const out: PassSpec[] = passes.map((_p, i) => {
    // Every pass sees every named target (the same source runs per pass);
    // targets not rendered yet read as the input image.
    const earlier = targets.filter((_t, j) => passes[j].TARGET);
    const glsl = `${imageAliases.join('\n')}
#define RENDERSIZE resolution
#define TIME time
#define TIMEDELTA (1.0 / 60.0)
#define FRAMEINDEX int(time * 60.0)
#define PASSINDEX ${i}
#define DATE vec4(2026.0, 1.0, 1.0, time)
${defines.join('\n')}
vec2 isf_FragNormCoord;
vec4 isf_FragColor;
vec4 isfTex(sampler2D s, vec2 c) { return lsc_unpremultiply(texture(s, vec2(c.x, 1.0 - c.y))); }
#define IMG_NORM_PIXEL(img, c) isfTex(img, c)
#define IMG_PIXEL(img, c) isfTex(img, (c) / RENDERSIZE)
#define IMG_THIS_PIXEL(img) isfTex(img, isf_FragNormCoord)
#define IMG_THIS_NORM_PIXEL(img) isfTex(img, isf_FragNormCoord)
#define IMG_SIZE(img) RENDERSIZE
${code}
vec4 effect(vec2 uv) {
  isf_FragNormCoord = vec2(uv.x, 1.0 - uv.y);
  isf_FragColor = vec4(0.0);
  isf_main();
  return lsc_premultiply(clamp(isf_FragColor, 0.0, 1.0));
}`;
    const inputsList = isTransition ? ['from', 'to', ...earlier] : ['source', ...earlier];
    return { id: passes[i].TARGET ?? (i === passes.length - 1 ? undefined : targets[i]), inputs: inputsList, glsl, prelude: 'minimal' as const };
  });
  const name = opts.name ?? header.DESCRIPTION?.split(/[.\n]/)[0]?.slice(0, 40) ?? 'ISF Effect';
  const plugin: EffectPlugin = {
    ...baseMeta({ ...opts, author: opts.author ?? header.CREDIT, description: opts.description ?? header.DESCRIPTION }, name, isTransition ? 'transition' : 'effect', 'isf', src),
    category: opts.category ?? header.CATEGORIES?.[0] ?? 'ISF',
    params,
    passes: out,
  };
  return finish(plugin, report);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ------------------------------------------------------------------ Shadertoy

export function convertShadertoy(src: string, opts: ConvertOptions = {}): ConversionResult {
  const report: ConversionReport = { format: 'shadertoy', warnings: [], unsupported: [] };
  const { decls, stripped } = parseUniforms(src);
  const params: ParamSpec[] = [];
  const defines: string[] = [];
  for (const d of decls) {
    const mp = mapParam(d.name, d.type, parseGlslValue(d.defaultText, d.type === 'vec2' ? 2 : d.type === 'vec3' ? 3 : d.type === 'vec4' ? 4 : 1) ?? 0, { min: d.min, max: d.max, label: d.label }, report);
    if (!mp) continue;
    params.push(mp.spec);
    if (mp.define) defines.push(mp.define);
  }
  let code = stripped.replace(/\btexture2D\s*\(/g, 'texture(');
  code = code.replace(/\b(texture|textureLod)\s*\(\s*iChannel([0-3])\s*,/g, (_m, fn: string) => (fn === 'textureLod' ? 'stTexLod(iChannel0,' : 'stTex(iChannel0,'));
  code = code.replace(/\biChannelResolution\s*\[\s*\d\s*\]/g, 'vec3(resolution, 1.0)');
  for (const ch of ['1', '2', '3']) if (new RegExp(`\\biChannel${ch}\\b`).test(src)) report.unsupported.push(`iChannel${ch} (mapped to the layer image)`);
  if (/\biMouse\b/.test(src)) report.unsupported.push('iMouse (always zero)');
  if (/\biChannel\d\b/.test(src)) report.warnings.push('iChannel0 is the layer being processed.');
  else report.warnings.push('Shader ignores its input; it renders as an opaque generator over the layer area.');
  const glsl = `#define iResolution vec3(resolution, 1.0)
#define iTime time
#define iGlobalTime time
#define iTimeDelta (1.0 / 60.0)
#define iFrame int(time * 60.0)
#define iFrameRate 60.0
#define iMouse vec4(0.0)
#define iDate vec4(2026.0, 1.0, 1.0, time)
#define iChannel0 source
#define iChannel1 source
#define iChannel2 source
#define iChannel3 source
${defines.join('\n')}
vec4 stTex(sampler2D s, vec2 p) { return lsc_unpremultiply(texture(s, vec2(p.x, 1.0 - p.y))); }
vec4 stTexLod(sampler2D s, vec2 p, float l) { return stTex(s, p); }
${code}
vec4 effect(vec2 uv) {
  vec4 c = vec4(0.0);
  mainImage(c, vec2(uv.x, 1.0 - uv.y) * resolution);
  return vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}`;
  const name = opts.name ?? 'Shadertoy Effect';
  const plugin: EffectPlugin = { ...baseMeta(opts, name, 'effect', 'shadertoy', src), params, passes: [{ glsl, prelude: 'minimal' }] };
  return finish(plugin, report);
}

// ------------------------------------------------------------------ plain GLSL

export function convertGlsl(src: string, opts: ConvertOptions = {}): ConversionResult {
  const report: ConversionReport = { format: 'glsl', warnings: [], unsupported: [] };
  const { decls, stripped } = parseUniforms(src);
  const params: ParamSpec[] = [];
  const defines: string[] = [];
  for (const d of decls) {
    if (['source', 'from', 'to'].includes(d.name)) continue;
    const mp = mapParam(d.name, d.type, parseGlslValue(d.defaultText, d.type === 'vec2' ? 2 : d.type === 'vec3' ? 3 : d.type === 'vec4' ? 4 : 1) ?? 0, { min: d.min, max: d.max, label: d.label }, report);
    if (!mp) continue;
    params.push(mp.spec);
    if (mp.define) defines.push(mp.define);
  }
  const isTransition = /\b(from|to)\b/.test(stripped) && /\bprogress\b/.test(stripped) && !/\bsource\b/.test(stripped);
  const glsl = `${defines.join('\n')}\n${stripped}`;
  const plugin: EffectPlugin = { ...baseMeta(opts, opts.name ?? 'Custom Effect', isTransition ? 'transition' : 'effect', 'glsl', src), params, passes: [{ glsl }] };
  return finish(plugin, report);
}

/** Detect the format and convert. */
export function convertShader(src: string, opts: ConvertOptions = {}): ConversionResult {
  const fmt = detectFormat(src);
  switch (fmt) {
    case 'gl-transition':
      return convertGlTransition(src, opts);
    case 'isf':
      return convertIsf(src, opts);
    case 'shadertoy':
      return convertShadertoy(src, opts);
    case 'glsl':
      return convertGlsl(src, opts);
    default:
      throw new Error('Unrecognised shader. Expected a gl-transition, an ISF shader, a Shadertoy mainImage() or a Luscent effect().');
  }
}
