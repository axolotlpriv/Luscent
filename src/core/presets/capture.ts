/**
 * Save a layer's animation as a Luscent preset: keyframed properties (with
 * their exact eases and curves), wiggles, effects with their settings and
 * time-remap speed changes. Times become relative to the first keyframe so
 * the preset replays from the playhead.
 */
import type { AnimProp, Keyframe, Layer, PropValue } from '../model/types';
import { REMAP } from '../timeline/timeRemap';
import type { LuscentPreset, PresetEffect, PresetKey, PresetProp, SpeedPoint } from './types';

export interface CaptureOptions {
  name: string;
  category?: string;
  description?: string;
  /** Layer time used when nothing is keyframed (static looks). */
  fallbackTime?: number;
  /** Position and anchor move relative to wherever the target layer is (default true). */
  relativePosition?: boolean;
}

const RELATIVE = new Set(['transform.position', 'transform.anchor']);
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const arr = (v: PropValue): number[] => (typeof v === 'number' ? [v] : v.slice());

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
}

function captureKeys(prop: AnimProp, t0: number, relative: boolean): PresetKey[] {
  const base = arr(prop.keyframes[0].value);
  return prop.keyframes.map((k: Keyframe): PresetKey => {
    const v = relative ? arr(k.value).map((x, i) => round(x - base[i])) : arr(k.value).map(round);
    const key: PresetKey = {
      t: round(k.time - t0),
      v: typeof k.value === 'number' ? v[0] : v,
      ae: {
        inInterp: k.inInterp,
        outInterp: k.outInterp,
        inEase: [{ ...k.inEase }],
        outEase: [{ ...k.outEase }],
        spatial: true,
        native: true,
      },
    };
    if (k.outCurve) key.ease = k.outCurve;
    return key;
  });
}

function captureProp(prop: AnimProp, t0: number, relative: boolean): PresetProp {
  const out: PresetProp = { mode: relative ? 'relative' : 'absolute' };
  if (prop.keyframes.length) out.keys = captureKeys(prop, t0, relative);
  else if (!relative) out.value = typeof prop.value === 'number' ? round(prop.value) : prop.value.map(round);
  if (prop.wiggle && prop.wiggle.amp !== 0) {
    const { freq, amp, octaves, ampMult, seed } = prop.wiggle;
    out.wiggle = { freq, amp, octaves, ampMult, seed };
  }
  return out;
}

const isAnimated = (p: AnimProp | undefined) => !!p && (p.keyframes.length > 0 || (!!p.wiggle && p.wiggle.amp !== 0));

/** Speed ramp from time-remap keyframes (slope of each segment). */
function captureSpeed(remap: AnimProp, t0: number): SpeedPoint[] {
  const ks = remap.keyframes as Keyframe<number>[];
  const pts: SpeedPoint[] = [];
  for (let i = 0; i < ks.length - 1; i++) {
    const dt = ks[i + 1].time - ks[i].time;
    if (ks[i].time < t0 - 1e-6 || dt <= 0) continue;
    pts.push({ at: round(ks[i].time - t0), speed: round(Math.max(0, (ks[i + 1].value - ks[i].value) / dt)) });
  }
  return pts;
}

export function presetFromLayer(layer: Layer, opts: CaptureOptions): LuscentPreset {
  const rel = opts.relativePosition ?? true;
  const fxIds = new Set((layer.effects ?? []).map((e) => e.id));
  const times: number[] = [];
  for (const [path, p] of Object.entries(layer.props)) {
    if (path === REMAP && !layer.timeRemap) continue;
    for (const k of p.keyframes) times.push(k.time);
  }
  const t0 = times.length ? Math.min(...times) : (opts.fallbackTime ?? 0);
  const t1 = times.length ? Math.max(...times) : t0;

  const props: Record<string, PresetProp> = {};
  for (const [path, p] of Object.entries(layer.props)) {
    if (path.startsWith('fx.') || path === REMAP || !isAnimated(p)) continue;
    props[path] = captureProp(p, t0, rel && RELATIVE.has(path));
  }

  const effects: PresetEffect[] = [];
  for (const inst of layer.effects ?? []) {
    if (!inst.enabled) continue;
    const prefix = `fx.${inst.id}.`;
    const params: Record<string, PresetProp> = {};
    for (const [path, p] of Object.entries(layer.props)) {
      if (!path.startsWith(prefix) || !fxIds.has(inst.id)) continue;
      params[path.slice(prefix.length)] = captureProp(p, t0, false);
    }
    effects.push({ pluginId: inst.pluginId, params });
  }

  const remap = layer.timeRemap ? layer.props[REMAP] : undefined;
  const speedRamp = remap && remap.keyframes.length > 1 ? captureSpeed(remap, t0) : undefined;
  const isText = layer.type === 'text' && Object.keys(props).some((p) => p.startsWith('content.'));

  const preset: LuscentPreset = {
    format: 'luscent-preset',
    version: 1,
    id: `user.${slug(opts.name)}.${Date.now().toString(36)}`,
    name: opts.name,
    category: opts.category || 'My Presets',
    description: opts.description,
    target: 'layer',
    requires: speedRamp?.length ? ['video'] : isText ? ['text'] : ['visual'],
    duration: round(Math.max(t1 - t0, 1 / 30)),
  };
  if (Object.keys(props).length) preset.props = props;
  if (effects.length) preset.effects = effects;
  if (speedRamp?.length) {
    preset.speedRamp = speedRamp;
    if (layer.frameBlending && layer.frameBlending !== 'none') preset.frameBlending = layer.frameBlending;
  }
  return preset;
}

/** True when a layer has anything a preset could capture. */
export function hasCapturableAnimation(layer: Layer): boolean {
  return Object.entries(layer.props).some(([path, p]) => (path === REMAP ? layer.timeRemap && p.keyframes.length > 1 : isAnimated(p))) || (layer.effects ?? []).some((e) => e.enabled);
}
