/**
 * Applies Luscent presets. Functions MUTATE the given layer/composition
 * (immer drafts in the app, plain objects in tests).
 */
import { applyEasing, makeKeyframe, KEY_EPSILON } from '../animation/keyframes';
import { evaluateKeys } from '../animation/interpolate';
import { evalArithmetic } from '../expr';
import { instantiateEffect, fxPath } from '../effects/registry';
import type { EffectPlugin } from '../effects/types';
import { createNullLayer, createShapeLayer, createSolidLayer, createTextLayer } from '../model/factory';
import type { AnimProp, Composition, Keyframe, Layer, MediaItem, PropValue, Id } from '../model/types';
import { currentSourceTime, REMAP } from '../timeline/timeRemap';
import { sourceDurationOf } from '../timeline/ops';
import type { LuscentPreset, PresetEffect, PresetProp, PVal, SpeedPoint } from './types';

export interface PresetContext {
  comp: Composition;
  /** Comp time where the preset starts. */
  playhead: number;
  /** Seconds per beat (from the comp's music). */
  beat: number;
  media: Record<Id, MediaItem>;
  plugin: (id: string) => EffectPlugin | undefined;
}

export interface ApplyReport {
  applied: string[];
  skipped: string[];
}

type Vars = Record<string, number>;

export function baseVars(ctx: PresetContext, dur: number): Vars {
  const { comp } = ctx;
  return { w: comp.width, h: comp.height, cx: comp.width / 2, cy: comp.height / 2, fps: comp.fps, frame: 1 / comp.fps, beat: ctx.beat, bar: ctx.beat * 4, dur };
}

function num(v: number | string | undefined, vars: Vars, fallback = 0): number {
  if (v === undefined) return fallback;
  if (typeof v === 'number') return v;
  const r = evalArithmetic(v, vars);
  if (r === null) throw new Error(`Bad preset expression "${v}"`);
  return r;
}

export function presetDuration(p: LuscentPreset, ctx: PresetContext): number {
  return Math.max(1 / ctx.comp.fps, num(p.duration, baseVars(ctx, 0), 1));
}

/** Evaluate a preset value against the current value (component-wise). */
function evalValue(v: PVal, cur: PropValue, mode: PresetProp['mode'], vars: Vars): PropValue {
  const curArr = typeof cur === 'number' ? [cur] : cur;
  const raw = Array.isArray(v) ? v : curArr.map(() => v);
  const out = curArr.map((c, i) => {
    const x = num(raw[Math.min(i, raw.length - 1)], { ...vars, cur: c });
    if (mode === 'relative') return c + x;
    if (mode === 'scale') return (c * x) / 100;
    return x;
  });
  // Colours keep their alpha unless specified.
  if (curArr.length === 4 && Array.isArray(v) && v.length === 3) out[3] = curArr[3];
  return (typeof cur === 'number' ? out[0] : out) as PropValue;
}

/** Apply a property animation starting at layer time `lt0`. */
export function applyPresetProp(layer: Layer, path: string, pp: PresetProp, lt0: number, vars: Vars, report: ApplyReport): void {
  const prop = layer.props[path];
  if (!prop) {
    report.skipped.push(`${layer.name}: no property ${path}`);
    return;
  }
  const cur = evaluateKeys(prop, lt0);
  let next: AnimProp = { ...prop, keyframes: prop.keyframes.slice() };
  if (pp.wiggle) {
    next.wiggle = {
      freq: num(pp.wiggle.freq, vars),
      amp: num(pp.wiggle.amp, vars),
      octaves: pp.wiggle.octaves ?? 1,
      ampMult: pp.wiggle.ampMult ?? 0.5,
      seed: pp.wiggle.seed ?? Math.floor(Math.random() * 1000),
    };
  }
  if (pp.keys?.length) {
    const keys: Keyframe[] = pp.keys.map((k) => {
      const t = lt0 + num(k.t, vars);
      const kf = makeKeyframe(t, evalValue(k.v, cur, pp.mode, vars), k.interp ?? 'linear');
      return kf;
    });
    const t0 = Math.min(...keys.map((k) => k.time));
    const t1 = Math.max(...keys.map((k) => k.time));
    // Replace existing animation inside the preset's span.
    const kept = next.keyframes.filter((k) => k.time < t0 - KEY_EPSILON || k.time > t1 + KEY_EPSILON);
    next = { ...next, keyframes: [...kept, ...keys].sort((a, b) => a.time - b.time) };
    pp.keys.forEach((k, i) => {
      if (k.ease) next = applyEasing(next, new Set([keys[i].id]), k.ease);
    });
    if (pp.keys.some((k) => k.ae)) next = { ...next, keyframes: applyAeEases(next.keyframes, keys, pp.keys) };
  } else if (pp.value !== undefined) {
    const v = evalValue(pp.value, cur, pp.mode, vars);
    if (next.keyframes.length) {
      const at = next.keyframes.findIndex((k) => Math.abs(k.time - lt0) < KEY_EPSILON);
      if (at >= 0) next.keyframes[at] = { ...next.keyframes[at], value: v };
      else next.keyframes = [...next.keyframes, makeKeyframe(lt0, v)].sort((a, b) => a.time - b.time);
    } else next.value = v;
  }
  layer.props[path] = next;
  report.applied.push(`${layer.name}: ${path}`);
}

/**
 * Convert AE eases (per-dimension, signed for scalars) into Luscent's single
 * path-projected ease per side.
 */
function applyAeEases(all: Keyframe[], created: Keyframe[], spec: PresetProp['keys'] & object): Keyframe[] {
  const byId = new Map(created.map((k, i) => [k.id, spec[i]]));
  const sorted = all.slice();
  const delta = (a: Keyframe, b: Keyframe) => {
    const va = typeof a.value === 'number' ? [a.value] : a.value;
    const vb = typeof b.value === 'number' ? [b.value] : b.value;
    return vb.map((x, i) => x - va[i]);
  };
  const project = (eases: Array<{ speed: number }>, d: number[], spatial: boolean, native?: boolean): number => {
    if (native) return eases[0]?.speed ?? 0;
    const L = Math.hypot(...d);
    if (spatial || eases.length === 1) {
      // Scalars: AE speed is signed; ours is along the direction of travel.
      return d.length === 1 ? eases[0].speed * (Math.sign(d[0]) || 1) : eases[0].speed;
    }
    if (L < 1e-9) return 0;
    return eases.reduce((s, e, i) => s + e.speed * (d[i] ?? 0), 0) / L;
  };
  const avgInf = (eases: Array<{ influence: number }>) => eases.reduce((s, e) => s + e.influence, 0) / Math.max(1, eases.length);
  return sorted.map((k, i) => {
    const src = byId.get(k.id)?.ae;
    if (!src) return k;
    const n: Keyframe = { ...k, inInterp: src.inInterp, outInterp: src.outInterp };
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    if (prev) n.inEase = { speed: project(src.inEase, delta(prev, k), src.spatial, src.native), influence: Math.max(0.01, avgInf(src.inEase)) };
    if (next) n.outEase = { speed: project(src.outEase, delta(k, next), src.spatial, src.native), influence: Math.max(0.01, avgInf(src.outEase)) };
    return n;
  });
}

export function applyPresetEffects(layer: Layer, effects: PresetEffect[], lt0: number, vars: Vars, ctx: PresetContext, report: ApplyReport): void {
  for (const fx of effects) {
    const plugin = ctx.plugin(fx.pluginId);
    if (!plugin) {
      report.skipped.push(`${layer.name}: effect ${fx.pluginId} is not installed`);
      continue;
    }
    const { instance, props } = instantiateEffect(plugin, ctx.comp);
    layer.effects = [...(layer.effects ?? []), instance];
    Object.assign(layer.props, props);
    report.applied.push(`${layer.name}: + ${plugin.name}`);
    for (const [param, pp] of Object.entries(fx.params ?? {})) applyPresetProp(layer, fxPath(instance.id, param), pp, lt0, vars, report);
  }
}

/** Integrate a speed curve into time-remap keyframes (velocity edits). */
export function applySpeedRamp(layer: Layer, points: SpeedPoint[], ctx: PresetContext, vars: Vars, report: ApplyReport): void {
  if (layer.type !== 'video' && layer.type !== 'precomp') {
    report.skipped.push(`${layer.name}: speed ramps need a video or precomp layer`);
    return;
  }
  const pts = points.map((p) => ({ at: num(p.at, vars), speed: Math.max(0, p.speed) })).sort((a, b) => a.at - b.at);
  if (pts.length === 0) return;
  const lt0 = ctx.playhead - layer.startTime;
  const s0 = currentSourceTime(layer, ctx.playhead);
  const dur = sourceDurationOf(layer, ctx.media);
  const maxSrc = Number.isFinite(dur) ? dur - 1 / ctx.comp.fps : Infinity;
  const prev = layer.timeRemap ? layer.props[REMAP] : undefined;
  const before = prev ? prev.keyframes.filter((k) => k.time < lt0 + pts[0].at - KEY_EPSILON) : [];
  const keys: Keyframe<number>[] = [];
  let src = s0;
  let lastAt = 0;
  let lastSpeed = pts[0].speed;
  if (!prev) keys.push(makeKeyframe(layer.inPoint - layer.startTime, currentSourceTime(layer, layer.inPoint)));
  for (const p of pts) {
    src += ((lastSpeed + p.speed) / 2) * (p.at - lastAt);
    lastAt = p.at;
    lastSpeed = p.speed;
    const k = makeKeyframe(lt0 + p.at, Math.min(maxSrc, p.at === 0 ? s0 : src), 'bezier') as Keyframe<number>;
    k.inEase = { speed: p.speed, influence: 1 / 3 };
    k.outEase = { speed: p.speed, influence: 1 / 3 };
    // Arrive at the ramp in realtime (the speed change starts at the playhead).
    if (p === pts[0]) k.inInterp = 'linear';
    keys.push(k);
  }
  // Carry the final speed to the end of the layer.
  const endLt = layer.outPoint - layer.startTime;
  if (endLt > lt0 + lastAt + 1e-3) {
    const k = makeKeyframe(endLt, Math.min(maxSrc, src + lastSpeed * (endLt - lt0 - lastAt)), 'linear') as Keyframe<number>;
    keys.push(k);
  }
  layer.props[REMAP] = { value: s0, keyframes: [...(before as Keyframe<number>[]), ...keys].sort((a, b) => a.time - b.time) };
  layer.timeRemap = true;
  report.applied.push(`${layer.name}: speed ramp (${pts.map((p) => `${Math.round(p.speed * 100)}%`).join(' → ')})`);
}

/** Beat length of a composition: first analysed music track, else 120 BPM. */
export function compBeat(comp: Composition, media: Record<Id, MediaItem>): number {
  for (const l of comp.layers) {
    if (l.type !== 'audio' && l.type !== 'video') continue;
    const bpm = media[l.mediaId]?.analysis?.bpm;
    if (bpm && bpm > 30) return 60 / bpm;
  }
  return 0.5;
}

/** Apply a layer-target preset to one layer. */
export function applyPresetToLayer(layer: Layer, preset: LuscentPreset, ctx: PresetContext, report: ApplyReport = { applied: [], skipped: [] }): ApplyReport {
  if (layer.locked) {
    report.skipped.push(`${layer.name}: locked`);
    return report;
  }
  if (preset.requires?.includes('video') && layer.type !== 'video' && layer.type !== 'precomp') {
    report.skipped.push(`${layer.name}: “${preset.name}” needs a video or precomp layer`);
    return report;
  }
  if (preset.requires?.includes('text') && layer.type !== 'text') {
    report.skipped.push(`${layer.name}: “${preset.name}” is for text layers`);
    return report;
  }
  if (preset.requires?.includes('visual') && layer.type === 'audio') {
    report.skipped.push(`${layer.name}: audio layers have no picture`);
    return report;
  }
  const dur = presetDuration(preset, ctx);
  const vars = baseVars(ctx, dur);
  const lt0 = ctx.playhead - layer.startTime;
  for (const [path, pp] of Object.entries(preset.props ?? {})) applyPresetProp(layer, path, pp, lt0, vars, report);
  if (preset.effects?.length) applyPresetEffects(layer, preset.effects, lt0, vars, ctx, report);
  if (preset.speedRamp?.length) applySpeedRamp(layer, preset.speedRamp, ctx, vars, report);
  if (preset.frameBlending && layer.type === 'video') layer.frameBlending = preset.frameBlending;
  return report;
}

/** Build the layers of a comp-target preset (not yet inserted). */
export function buildPresetLayers(preset: LuscentPreset, ctx: PresetContext, report: ApplyReport = { applied: [], skipped: [] }): Layer[] {
  const dur = presetDuration(preset, ctx);
  const vars = baseVars(ctx, dur);
  const comp = ctx.comp;
  const out: Layer[] = [];
  for (const spec of preset.layers ?? []) {
    const ld = Math.max(1 / comp.fps, num(spec.duration, vars, dur));
    const opts = { comp, inPoint: ctx.playhead, outPoint: Math.min(comp.duration + 60, ctx.playhead + ld), name: spec.name };
    let layer: Layer;
    switch (spec.kind) {
      case 'solid':
        layer = createSolidLayer({ ...opts, color: spec.color });
        break;
      case 'adjustment':
        layer = createSolidLayer({ ...opts, name: spec.name ?? 'Adjustment Layer', color: [1, 1, 1, 1] });
        layer.adjustment = true;
        break;
      case 'text':
        layer = createTextLayer({ ...opts, text: spec.text });
        break;
      case 'rect':
      case 'ellipse':
        layer = createShapeLayer({ ...opts, shape: spec.kind, fill: spec.color });
        break;
      case 'null':
        layer = createNullLayer(opts);
        break;
    }
    layer.startTime = ctx.playhead;
    if (spec.blendMode) layer.blendMode = spec.blendMode;
    for (const [path, pp] of Object.entries(spec.props ?? {})) applyPresetProp(layer, path, pp, 0, vars, report);
    if (spec.effects?.length) applyPresetEffects(layer, spec.effects, 0, vars, ctx, report);
    out.push(layer);
  }
  return out;
}
