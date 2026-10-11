/**
 * Time remapping helpers (Twixtor-style retiming). `time.remap` maps layer
 * time → source time; keyframing it makes speed ramps, and its speed graph
 * is literally the playback speed.
 */
import { evaluateProp } from '../animation/interpolate';
import { makeKeyframe } from '../animation/keyframes';
import type { AnimProp, Layer } from '../model/types';

export const REMAP = 'time.remap';

function remapProp(layer: Layer): AnimProp<number> | undefined {
  return layer.props[REMAP] as AnimProp<number> | undefined;
}

/** Source time currently shown at comp time t. */
export function currentSourceTime(layer: Layer, t: number): number {
  const p = layer.timeRemap ? remapProp(layer) : undefined;
  const lt = t - layer.startTime;
  return p ? evaluateProp(p, lt) : lt;
}

/** Enable time remap with keys at the in and out points (AE behaviour). */
export function enableTimeRemap(layer: Layer): void {
  if (layer.timeRemap && remapProp(layer)) return;
  const a = layer.inPoint - layer.startTime;
  const b = layer.outPoint - layer.startTime;
  layer.props[REMAP] = { value: a, keyframes: [makeKeyframe(a, a), makeKeyframe(b, b)] };
  layer.timeRemap = true;
}

export function disableTimeRemap(layer: Layer): void {
  delete layer.props[REMAP];
  layer.timeRemap = false;
  layer.frameBlending = 'none';
}

/**
 * Constant speed retime from the in point: speed 0.25 = 4× slow motion.
 * Extends or shortens the layer so the same source span plays.
 */
export function setConstantSpeed(layer: Layer, speed: number, sourceDuration: number): void {
  const s = Math.max(0.01, Math.min(100, speed));
  const s0 = currentSourceTime(layer, layer.inPoint);
  const s1 = Math.min(sourceDuration, currentSourceTime(layer, layer.outPoint - 1e-6));
  const span = Math.max(0, s1 - s0);
  const a = layer.inPoint - layer.startTime;
  const len = span / s;
  layer.props[REMAP] = { value: s0, keyframes: [makeKeyframe(a, s0), makeKeyframe(a + len, s0 + span)] };
  layer.timeRemap = true;
  layer.outPoint = layer.inPoint + len;
}

/** Hold the frame visible at comp time t for the rest of the layer. */
export function freezeFrame(layer: Layer, t: number): void {
  const src = currentSourceTime(layer, t);
  const lt = t - layer.startTime;
  const prev = remapProp(layer);
  const keys = (layer.timeRemap && prev ? prev.keyframes.filter((k) => k.time < lt - 1e-4) : []).map((k) => ({ ...k }));
  if (!layer.timeRemap || !prev) {
    const a = layer.inPoint - layer.startTime;
    if (lt - a > 1e-4) keys.push(makeKeyframe(a, currentSourceTime(layer, layer.inPoint)));
  }
  keys.push(makeKeyframe(lt, src, 'hold'));
  if (keys.length > 1) keys[keys.length - 2] = { ...keys[keys.length - 2], outInterp: 'linear' };
  layer.props[REMAP] = { value: src, keyframes: keys };
  layer.timeRemap = true;
}

/** Play the layer's visible span backwards. */
export function reverseLayer(layer: Layer): void {
  const s0 = currentSourceTime(layer, layer.inPoint);
  const s1 = currentSourceTime(layer, layer.outPoint - 1e-6);
  const a = layer.inPoint - layer.startTime;
  const b = layer.outPoint - layer.startTime;
  layer.props[REMAP] = { value: s1, keyframes: [makeKeyframe(a, s1), makeKeyframe(b, s0)] };
  layer.timeRemap = true;
}
