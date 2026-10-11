/**
 * Luscent preset format ("luscent-preset", JSON).
 *
 * A preset either animates the selected layer(s) (`target: "layer"`) or adds
 * new layers at the playhead (`target: "comp"`). Times and values may be
 * numbers or expressions over these variables:
 *
 *   w, h        composition size        cx, cy   composition centre
 *   fps, frame  frame rate, one frame   beat     seconds per beat (from the
 *   bar         4 beats                          comp's music, 0.5 s fallback)
 *   dur         preset duration         cur      current value of the property
 *                                                (per component)
 */
import type { Bezier } from '../animation/easings';
import type { BlendMode, Color, FrameBlending, Interpolation, PropPath } from '../model/types';

export type PVal = number | string | Array<number | string>;

export interface PresetKey {
  /** Seconds from the preset start (playhead). */
  t: number | string;
  v: PVal;
  /** Easing applied to the segment leaving this key (preset id or bezier). */
  ease?: string | Bezier;
  interp?: Interpolation;
  /**
   * Exact After Effects temporal ease (imported presets). Speeds are in the
   * property's Luscent units per second; one entry per dimension for
   * non-spatial vectors, one for scalars and spatial properties.
   */
  ae?: {
    inInterp: Interpolation;
    outInterp: Interpolation;
    inEase: Array<{ speed: number; influence: number }>;
    outEase: Array<{ speed: number; influence: number }>;
    spatial: boolean;
    /** Speeds are already Luscent's path-projected speeds (presets saved from Luscent). */
    native?: boolean;
  };
}

export interface PresetProp {
  /** absolute (default), relative (added to the current value) or scale (percent of current). */
  mode?: 'absolute' | 'relative' | 'scale';
  value?: PVal;
  keys?: PresetKey[];
  wiggle?: { freq: number | string; amp: number | string; octaves?: number; ampMult?: number; seed?: number };
}

export interface PresetEffect {
  pluginId: string;
  params?: Record<string, PresetProp>;
}

export interface SpeedPoint {
  /** Seconds from the preset start. */
  at: number | string;
  /** Playback speed (1 = realtime, 0.25 = 4× slow motion, 0 = freeze). */
  speed: number;
}

export interface PresetLayerSpec {
  kind: 'solid' | 'adjustment' | 'text' | 'rect' | 'ellipse' | 'null';
  name?: string;
  text?: string;
  color?: Color;
  blendMode?: BlendMode;
  /** Seconds (defaults to the preset duration). */
  duration?: number | string;
  props?: Record<PropPath, PresetProp>;
  effects?: PresetEffect[];
}

export interface LuscentPreset {
  format: 'luscent-preset';
  version: 1;
  id: string;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
  author?: string;
  target: 'layer' | 'comp';
  /** Layer types the preset needs (layer target). */
  requires?: Array<'video' | 'text' | 'visual'>;
  duration?: number | string;
  props?: Record<PropPath, PresetProp>;
  effects?: PresetEffect[];
  speedRamp?: SpeedPoint[];
  frameBlending?: FrameBlending;
  layers?: PresetLayerSpec[];
  /** Kept on imported presets: what could not be mapped (e.g. from .ffx). */
  importReport?: { source: string; mapped: string[]; approximated: string[]; unmapped: string[] };
  builtin?: boolean;
}

export const PRESET_FORMAT = 'luscent-preset';

export function validatePreset(p: unknown): string[] {
  const o = p as LuscentPreset;
  const errs: string[] = [];
  if (!o || typeof o !== 'object') return ['Preset must be an object.'];
  if (o.format !== PRESET_FORMAT) errs.push('format must be "luscent-preset".');
  if (typeof o.id !== 'string' || !o.id) errs.push('id is required.');
  if (typeof o.name !== 'string' || !o.name) errs.push('name is required.');
  if (o.target !== 'layer' && o.target !== 'comp') errs.push('target must be "layer" or "comp".');
  if (o.target === 'comp' && !Array.isArray(o.layers)) errs.push('comp presets need layers.');
  return errs;
}
