/**
 * After Effects animation presets (.ffx) → Luscent presets.
 *
 * Maps transform properties (with exact keyframe eases), time remapping,
 * audio levels, a set of first-party effects and common third-party
 * equivalents onto Luscent properties and effects. Everything that can't be
 * mapped is listed in the report. Also accepts a layer from an .aep project.
 */
import type { LuscentPreset, PresetEffect, PresetKey, PresetProp, SpeedPoint } from '../presets/types';
import { readGroup, type AeGroup, type AeKey, type AeNode, type AeProp } from './properties';
import { parseRifx, type RChunk } from './rifx';

export interface FfxReport {
  source: string;
  mapped: string[];
  approximated: string[];
  unmapped: string[];
}

export interface FfxResult {
  preset: LuscentPreset;
  report: FfxReport;
}

// ------------------------------------------------------------------ helpers

type Conv = (v: number[]) => number[];
const id: Conv = (v) => v;
const pct: Conv = (v) => v.map((x) => x * 100);

interface TrackSpec {
  path: string;
  dims: number;
  conv: Conv;
  mode?: PresetProp['mode'];
}

/** Map one AE property's keys/static value into a PresetProp. */
function toPresetProp(p: AeProp, spec: TrackSpec, t0: number, report: FfxReport, label: string): PresetProp | null {
  const take = (v: number[]) => spec.conv(v).slice(0, spec.dims);
  const speedScale = spec.conv([1])[0];
  const out: PresetProp = { mode: spec.mode ?? 'absolute' };
  if (p.keys.length) {
    out.keys = p.keys.map(
      (k: AeKey): PresetKey => ({
        t: k.time - t0,
        v: spec.dims === 1 ? take(k.value)[0] : take(k.value),
        ae: {
          inInterp: k.inInterp,
          outInterp: k.outInterp,
          inEase: k.inEase.slice(0, p.spatial ? 1 : spec.dims).map((e) => ({ speed: e.speed * speedScale, influence: e.influence })),
          outEase: k.outEase.slice(0, p.spatial ? 1 : spec.dims).map((e) => ({ speed: e.speed * speedScale, influence: e.influence })),
          spatial: p.spatial,
        },
      }),
    );
    if (spec.mode === 'relative' && out.keys.length) {
      // Offsets from the first key, so the move applies wherever the layer is.
      const first = out.keys[0].v as number | number[];
      out.keys = out.keys.map((k) => ({ ...k, v: Array.isArray(k.v) ? (k.v as number[]).map((x, i) => x - (first as number[])[i]) : (k.v as number) - (first as number) }));
    }
    report.mapped.push(`${label} (${p.keys.length} keyframes)`);
  } else if (p.staticValue && spec.mode !== 'relative') {
    const v = take(p.staticValue);
    out.value = spec.dims === 1 ? v[0] : v;
    report.mapped.push(label);
  } else if (!p.expression) return null;
  if (p.expression) mapExpression(p.expression, out, spec, report, label);
  return out;
}

/** Recognise the expressions presets use most; report the rest. */
function mapExpression(expr: string, out: PresetProp, spec: TrackSpec, report: FfxReport, label: string): void {
  const e = expr.trim().replace(/;$/, '');
  const wig = /^wiggle\s*\(\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?(?:\s*,\s*([\d.]+))?/.exec(e);
  if (wig) {
    out.wiggle = { freq: Number(wig[1]), amp: Number(wig[2]), octaves: wig[3] ? Number(wig[3]) : 1, ampMult: wig[4] ? Number(wig[4]) : 0.5 };
    report.mapped.push(`${label}: expression ${e} → wiggle`);
    return;
  }
  const lin = /^(?:time\s*\*\s*(-?[\d.]+)|(-?[\d.]+)\s*\*\s*time)$/.exec(e);
  if (lin && spec.dims === 1) {
    const rate = Number(lin[1] ?? lin[2]);
    out.keys = [
      { t: 0, v: 0, interp: 'linear' },
      { t: 10, v: rate * 10, interp: 'linear' },
    ];
    out.mode = 'relative';
    report.approximated.push(`${label}: expression ${e} → linear keyframes for 10 s`);
    return;
  }
  if (/^-?[\d.]+$/.test(e) && spec.dims === 1) {
    out.value = Number(e);
    delete out.keys;
    out.mode = 'absolute';
    report.mapped.push(`${label}: expression ${e} → static value`);
    return;
  }
  report.unmapped.push(`${label}: expression “${e.length > 60 ? e.slice(0, 57) + '…' : e}”`);
}

function walkProps(g: AeGroup, fn: (p: AeProp, path: AeGroup[]) => void, path: AeGroup[] = []): void {
  for (const c of g.children) {
    if (c.kind === 'group') walkProps(c, fn, [...path, c]);
    else if (c.kind === 'prop') fn(c, path);
  }
}

function earliestKey(root: AeGroup): number {
  let t = Infinity;
  walkProps(root, (p) => {
    for (const k of p.keys) t = Math.min(t, k.time);
  });
  return Number.isFinite(t) ? t : 0;
}

function latestKey(root: AeGroup): number {
  let t = 0;
  walkProps(root, (p) => {
    for (const k of p.keys) t = Math.max(t, k.time);
  });
  return t;
}

const isAnimatedOrSet = (n: AeNode | undefined): boolean => !!n && n.kind === 'prop' && (n.keys.length > 0 || !!n.expression);

// ------------------------------------------------------------------ effects

interface ParamMap {
  to: string;
  conv?: (v: number[]) => number | number[];
}

interface EffectMap {
  plugin: string;
  params: Record<string, ParamMap>;
  extra?: Record<string, number>;
}

const first = (v: number[]) => v[0];
const popup = (v: number[]) => Math.max(0, Math.round(v[0]) - 1);
const color = (v: number[]) => v.slice(0, 4);
const point = (v: number[]) => v.slice(0, 2);

/** First-party AE effects → Luscent built-ins (param index → param id). */
const EFFECTS: Record<string, EffectMap> = {
  'ADBE Gaussian Blur 2': { plugin: 'luscent.blur.gaussian', params: { '0001': { to: 'radius', conv: first }, '0002': { to: 'dims', conv: popup }, '0003': { to: 'repeatEdges', conv: first } } },
  'ADBE Box Blur2': { plugin: 'luscent.blur.gaussian', params: { '0001': { to: 'radius', conv: (v) => v[0] * 1.5 }, '0003': { to: 'dims', conv: popup }, '0004': { to: 'repeatEdges', conv: first } } },
  'ADBE Motion Blur': { plugin: 'luscent.blur.directional', params: { '0001': { to: 'angle', conv: (v) => v[0] - 90 }, '0002': { to: 'blurLength', conv: (v) => v[0] * 2 } } },
  'ADBE Radial Blur': { plugin: 'luscent.blur.radial', params: { '0001': { to: 'amount', conv: first }, '0002': { to: 'center', conv: point }, '0003': { to: 'mode', conv: popup } } },
  'CC Radial Fast Blur': { plugin: 'luscent.blur.radial', params: { '0001': { to: 'center', conv: point }, '0002': { to: 'amount', conv: first } }, extra: { mode: 1 } },
  'ADBE Glo2': { plugin: 'luscent.glow', params: { '0002': { to: 'threshold', conv: (v) => (v[0] <= 1 ? v[0] * 100 : v[0]) }, '0003': { to: 'radius', conv: first }, '0004': { to: 'intensity', conv: first } } },
  'ADBE Geometry2': {
    plugin: 'luscent.transform',
    params: {
      '0001': { to: 'anchor', conv: point },
      '0002': { to: 'position', conv: point },
      '0004': { to: 'scale', conv: first },
      '0007': { to: 'rotation', conv: first },
      '0008': { to: 'opacity', conv: (v) => (v[0] <= 1 ? v[0] * 100 : v[0]) },
      '0010': { to: 'shutter', conv: (v) => Math.min(100, (v[0] / 360) * 100) },
    },
  },
  'ADBE Brightness & Contrast 2': { plugin: 'luscent.color-adjust', params: { '0001': { to: 'brightness', conv: (v) => v[0] / 1.5 }, '0002': { to: 'contrast', conv: first } } },
  'ADBE HUE SATURATION': { plugin: 'luscent.color-adjust', params: { '0003': { to: 'hue', conv: first }, '0004': { to: 'saturation', conv: (v) => 100 + v[0] }, '0005': { to: 'brightness', conv: first } } },
  'ADBE Exposure2': { plugin: 'luscent.color-adjust', params: { '0002': { to: 'exposure', conv: first } } },
  'ADBE Invert': { plugin: 'luscent.invert', params: { '0002': { to: 'amount', conv: (v) => (v[0] <= 1 ? v[0] * 100 : v[0]) } } },
  'ADBE Tint': { plugin: 'luscent.tint', params: { '0001': { to: 'black', conv: color }, '0002': { to: 'white', conv: color }, '0003': { to: 'amount', conv: (v) => (v[0] <= 1 ? v[0] * 100 : v[0]) } } },
  'ADBE Noise': { plugin: 'luscent.grain', params: { '0001': { to: 'amount', conv: (v) => (v[0] <= 1 ? v[0] * 100 : v[0]) } } },
  'ADBE Optics Compensation': { plugin: 'luscent.lens-distortion', params: { '0001': { to: 'amount', conv: (v) => v[0] / 1.8 } } },
  'ADBE Mosaic': { plugin: 'luscent.mosaic', params: { '0001': { to: 'blockSize', conv: (v) => Math.max(1, 1080 / Math.max(1, v[0])) } } },
  'ADBE Drop Shadow': {
    plugin: 'luscent.drop-shadow',
    params: {
      '0001': { to: 'scolor', conv: color },
      '0002': { to: 'opacity', conv: (v) => (v[0] <= 1 ? v[0] * 100 : v[0] > 100 ? (v[0] / 255) * 100 : v[0]) },
      '0003': { to: 'direction', conv: first },
      '0004': { to: 'dist', conv: first },
      '0005': { to: 'softness', conv: first },
    },
  },
  'ADBE Wave Warp': { plugin: 'luscent.wave', params: { '0002': { to: 'amplitude', conv: first }, '0003': { to: 'wavelength', conv: first }, '0004': { to: 'direction', conv: (v) => v[0] - 90 }, '0005': { to: 'speed', conv: first } } },
};

/** Third-party effects matched by display name (defaults only). */
const BY_NAME: Array<[RegExp, string]> = [
  [/shake|wiggle/i, 'luscent.shake'],
  [/deep glow|glow/i, 'luscent.glow'],
  [/chromatic|aberration|prism/i, 'luscent.chromatic-aberration'],
  [/rgb|channel.*(shift|split)/i, 'luscent.rgb-split'],
  [/glitch|datamosh/i, 'luscent.glitch'],
  [/lens distort|optics|fisheye|barrel|pincushion/i, 'luscent.lens-distortion'],
  [/vhs|tape|retro/i, 'luscent.vhs'],
  [/grain|noise/i, 'luscent.grain'],
  [/directional blur|motion blur|whip/i, 'luscent.blur.directional'],
  [/zoom blur|radial blur|spin blur/i, 'luscent.blur.radial'],
  [/blur/i, 'luscent.blur.gaussian'],
  [/flash|exposure|flicker/i, 'luscent.flash'],
  [/vignette/i, 'luscent.vignette'],
];

function mapEffect(g: AeGroup, t0: number, report: FfxReport): PresetEffect | null {
  const display = g.effect?.displayName ?? g.matchName;
  const m = EFFECTS[g.matchName];
  if (m) {
    const fx: PresetEffect = { pluginId: m.plugin, params: {} };
    for (const [k, v] of Object.entries(m.extra ?? {})) fx.params![k] = { value: v };
    for (const c of g.children) {
      if (c.kind !== 'prop') continue;
      const idx = c.matchName.split('-').pop() ?? '';
      if (idx === '0000' || c.matchName === 'ADBE Effect Built In Params') continue;
      const pm = m.params[idx];
      const pname = g.effect?.params.find((p) => p.matchName === c.matchName)?.name || c.name || idx;
      if (!pm) {
        if (c.keys.length || c.expression) report.unmapped.push(`${display} › ${pname}`);
        continue;
      }
      const conv = (v: number[]) => {
        const r = pm.conv ? pm.conv(v) : v[0];
        return Array.isArray(r) ? r : [r];
      };
      const dims = conv([0, 0, 0, 0]).length;
      const prop = toPresetProp(c, { path: pm.to, dims, conv }, t0, { ...report, mapped: [] }, `${display} › ${pname}`);
      if (prop) fx.params![pm.to] = prop;
    }
    report.mapped.push(`${display} → ${m.plugin}`);
    return fx;
  }
  for (const [re, plugin] of BY_NAME) {
    if (re.test(display) || re.test(g.matchName)) {
      report.approximated.push(`${display} (${g.matchName}) → ${plugin} with default settings`);
      return { pluginId: plugin };
    }
  }
  report.unmapped.push(`effect ${display} (${g.matchName})`);
  return null;
}

// ------------------------------------------------------------------ main

const TRANSFORM: Record<string, TrackSpec> = {
  'ADBE Anchor Point': { path: 'transform.anchor', dims: 2, conv: id, mode: 'relative' },
  'ADBE Position': { path: 'transform.position', dims: 2, conv: id, mode: 'relative' },
  'ADBE Scale': { path: 'transform.scale', dims: 2, conv: pct },
  'ADBE Rotate Z': { path: 'transform.rotation', dims: 1, conv: id },
  'ADBE Opacity': { path: 'transform.opacity', dims: 1, conv: pct },
};

const IGNORE_GROUPS = new Set(['ADBE Marker', 'ADBE Effect Built In Params', 'ADBE Layer Overrides', 'ADBE Layer Sets', 'ADBE Material Options Group', 'ADBE Plane Options Group', 'ADBE Extrsn Options Group', 'ADBE Source Options Group']);

const IGNORE_DEFAULTS = new Set(['ADBE Envir Appear in Reflect', 'ADBE Orientation', 'ADBE Rotate X', 'ADBE Rotate Y', 'ADBE Position_2']);

function mapLayerRoot(root: AeGroup, name: string, source: string): FfxResult {
  const report: FfxReport = { source, mapped: [], approximated: [], unmapped: [] };
  const t0 = earliestKey(root);
  const preset: LuscentPreset = {
    format: 'luscent-preset',
    version: 1,
    id: `ffx.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    category: 'Imported',
    target: 'layer',
    requires: ['visual'],
    description: `Imported from ${source}`,
    duration: Math.max(1 / 30, latestKey(root) - t0) || 1,
    props: {},
    effects: [],
  };
  for (const node of root.children) {
    switch (node.matchName) {
      case 'ADBE Transform Group': {
        if (node.kind !== 'group') break;
        const px = node.children.find((c) => c.matchName === 'ADBE Position_0');
        const py = node.children.find((c) => c.matchName === 'ADBE Position_1');
        for (const c of node.children) {
          if (c.kind !== 'prop') continue;
          const spec = TRANSFORM[c.matchName];
          if (spec) {
            const pp = toPresetProp(c, spec, t0, report, c.matchName.replace('ADBE ', ''));
            if (pp) preset.props![spec.path] = pp;
          } else if (c.matchName === 'ADBE Position_0' || c.matchName === 'ADBE Position_1') {
            // handled below
          } else if (!IGNORE_DEFAULTS.has(c.matchName) || isAnimatedOrSet(c)) {
            if (c.keys.length || c.expression) report.unmapped.push(`${c.matchName.replace('ADBE ', '')} (3D / unsupported transform)`);
          }
        }
        if ((px && px.kind === 'prop' && (px.keys.length || px.expression)) || (py && py.kind === 'prop' && (py.keys.length || py.expression))) {
          const sep = separatedPosition(px as AeProp | undefined, py as AeProp | undefined, t0);
          if (sep) {
            preset.props!['transform.position'] = sep;
            report.approximated.push('Separated Position X/Y merged into one position track');
          }
        }
        break;
      }
      case 'ADBE Effect Parade': {
        if (node.kind !== 'group') break;
        for (const fx of node.children) {
          if (fx.kind !== 'group') continue;
          const mapped = mapEffect(fx, t0, report);
          if (mapped) preset.effects!.push(mapped);
        }
        break;
      }
      case 'ADBE Time Remapping': {
        if (node.kind === 'prop' && node.keys.length > 1) {
          preset.speedRamp = remapToSpeed(node, t0);
          preset.requires = ['video'];
          preset.frameBlending = 'optical-flow';
          report.approximated.push(`Time Remap (${node.keys.length} keys) → speed ramp`);
        }
        break;
      }
      case 'ADBE Audio Group': {
        if (node.kind !== 'group') break;
        const lv = node.children.find((c) => c.matchName === 'ADBE Audio Levels');
        if (lv && lv.kind === 'prop' && (lv.keys.length || lv.expression)) {
          const pp = toPresetProp(lv, { path: 'audio.volume', dims: 1, conv: id }, t0, report, 'Audio Levels');
          if (pp) preset.props!['audio.volume'] = pp;
        }
        break;
      }
      default: {
        if (IGNORE_GROUPS.has(node.matchName)) break;
        const has = (n: AeNode): boolean => (n.kind === 'group' ? n.children.some(has) : n.kind === 'prop' ? n.keys.length > 0 || !!n.expression : n.kind === 'unsupported');
        if (has(node)) report.unmapped.push(`${node.matchName.replace('ADBE ', '')}${node.matchName.includes('Mask') ? ' (masks)' : node.matchName.includes('Text') ? ' (text animators)' : ''}`);
      }
    }
  }
  if (!Object.keys(preset.props!).length) delete preset.props;
  if (!preset.effects!.length) delete preset.effects;
  preset.importReport = report;
  return { preset, report };
}

function separatedPosition(px: AeProp | undefined, py: AeProp | undefined, t0: number): PresetProp | null {
  const times = [...new Set([...(px?.keys ?? []), ...(py?.keys ?? [])].map((k) => k.time))].sort((a, b) => a - b);
  if (!times.length) return null;
  const sample = (p: AeProp | undefined, t: number) => {
    if (!p) return 0;
    if (!p.keys.length) return p.staticValue?.[0] ?? 0;
    const ks = p.keys;
    if (t <= ks[0].time) return ks[0].value[0];
    for (let i = 0; i < ks.length - 1; i++) {
      if (t <= ks[i + 1].time) {
        const f = (t - ks[i].time) / (ks[i + 1].time - ks[i].time);
        return ks[i].value[0] + (ks[i + 1].value[0] - ks[i].value[0]) * f;
      }
    }
    return ks[ks.length - 1].value[0];
  };
  const v0 = [sample(px, times[0]), sample(py, times[0])];
  return { mode: 'relative', keys: times.map((t) => ({ t: t - t0, v: [sample(px, t) - v0[0], sample(py, t) - v0[1]], ease: 'ease-inOut' })) };
}

function remapToSpeed(p: AeProp, t0: number): SpeedPoint[] {
  const ks = p.keys;
  const pts: SpeedPoint[] = [];
  for (let i = 0; i < ks.length - 1; i++) {
    const dt = ks[i + 1].time - ks[i].time;
    const speed = dt > 0 ? Math.max(0, (ks[i + 1].value[0] - ks[i].value[0]) / dt) : 1;
    pts.push({ at: ks[i].time - t0, speed });
  }
  return pts;
}

/** Find property-tree roots: layer roots in .aep, preset roots in .ffx. */
function findRoots(root: RChunk): RChunk[] {
  const layers: RChunk[] = [];
  const tops: RChunk[] = [];
  const visit = (c: RChunk, inTdgp: boolean) => {
    if (c.type === 'LIST' && c.list === 'Layr') {
      const t = c.children?.find((x) => x.type === 'LIST' && x.list === 'tdgp');
      if (t) layers.push(t);
      return;
    }
    if (c.type === 'LIST' && c.list === 'tdgp' && !inTdgp) {
      tops.push(c);
      return;
    }
    for (const x of c.children ?? []) visit(x, inTdgp || (c.type === 'LIST' && c.list === 'tdgp'));
  };
  visit(root, false);
  return layers.length ? layers : tops;
}

function scoreRoot(g: AeGroup): number {
  let n = 0;
  walkProps(g, (p) => {
    n += p.keys.length * 2 + (p.expression ? 3 : 0);
  });
  const parade = g.children.find((c) => c.matchName === 'ADBE Effect Parade');
  if (parade && parade.kind === 'group') n += parade.children.length * 5;
  return n;
}

function rootsOf(bytes: ArrayBuffer | Uint8Array): { kind: string; roots: AeGroup[] } {
  const root = parseRifx(bytes);
  const kind = root.list === 'FaFX' ? 'ffx' : root.list === 'Egg!' ? 'aep' : root.list ?? '?';
  const roots = findRoots(root).map((c) => readGroup('root', c));
  if (!roots.length) throw new Error('No animation data found in this file.');
  return { kind, roots };
}

/** Import every layer-like root (all layers of an .aep, the preset of an .ffx). */
export function importAfterEffectsLayers(bytes: ArrayBuffer | Uint8Array, fileName = 'preset.ffx'): FfxResult[] {
  const { kind, roots } = rootsOf(bytes);
  const name = fileName.replace(/\.[^.]+$/, '');
  return roots.map((r, i) => mapLayerRoot(r, roots.length > 1 ? `${name} ${i + 1}` : name, `${fileName} (${kind})`));
}

/** Import an .ffx preset (or the most animated layer of an .aep). */
export function importAfterEffects(bytes: ArrayBuffer | Uint8Array, fileName = 'preset.ffx'): FfxResult {
  const { kind, roots } = rootsOf(bytes);
  const best = roots.reduce((a, b) => (scoreRoot(b) > scoreRoot(a) ? b : a));
  const name = fileName.replace(/\.[^.]+$/, '');
  const res = mapLayerRoot(best, name, `${fileName} (${kind})`);
  if (kind === 'aep' && roots.length > 1) res.report.approximated.push(`Project has ${roots.length} layers; imported the most animated one`);
  return res;
}
