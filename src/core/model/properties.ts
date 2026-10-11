import type { AnimProp, Color, LayerType, PropPath, PropValue, Vec2 } from './types';

/**
 * Property metadata registry. Drives default values, the property UI (labels,
 * units, scrub speed, ranges) and, later, the graph editor and preset mapper.
 */
export type PropKind = 'number' | 'vec2' | 'color';

export interface PropDef {
  path: PropPath;
  label: string;
  group: 'transform' | 'content' | 'audio';
  kind: PropKind;
  unit?: '%' | '°' | 'px' | 'dB';
  min?: number;
  max?: number;
  /** Value change per pixel when scrubbing a number field. */
  step: number;
  /** Shortcut letter that reveals this property in the timeline (AE style). */
  reveal?: string;
}

const T = (d: Omit<PropDef, 'group'>): PropDef => ({ ...d, group: 'transform' });
const C = (d: Omit<PropDef, 'group'>): PropDef => ({ ...d, group: 'content' });

export const TRANSFORM_PROPS: PropDef[] = [
  T({ path: 'transform.anchor', label: 'Anchor Point', kind: 'vec2', unit: 'px', step: 1, reveal: 'a' }),
  T({ path: 'transform.position', label: 'Position', kind: 'vec2', unit: 'px', step: 1, reveal: 'p' }),
  T({ path: 'transform.scale', label: 'Scale', kind: 'vec2', unit: '%', step: 0.5, reveal: 's' }),
  T({ path: 'transform.rotation', label: 'Rotation', kind: 'number', unit: '°', step: 0.5, reveal: 'r' }),
  T({ path: 'transform.opacity', label: 'Opacity', kind: 'number', unit: '%', min: 0, max: 100, step: 0.5, reveal: 't' }),
];

const VOLUME: PropDef = {
  path: 'audio.volume',
  label: 'Volume',
  group: 'audio',
  kind: 'number',
  unit: 'dB',
  min: -60,
  max: 12,
  step: 0.1,
  reveal: 'l',
};

export const CONTENT_PROPS: Record<LayerType, PropDef[]> = {
  solid: [C({ path: 'content.color', label: 'Color', kind: 'color', step: 0.005 })],
  shape: [
    C({ path: 'content.size', label: 'Size', kind: 'vec2', unit: 'px', min: 0, step: 1 }),
    C({ path: 'content.roundness', label: 'Roundness', kind: 'number', unit: 'px', min: 0, step: 0.5 }),
    C({ path: 'content.fill', label: 'Fill', kind: 'color', step: 0.005 }),
    C({ path: 'content.strokeWidth', label: 'Stroke Width', kind: 'number', unit: 'px', min: 0, step: 0.25 }),
    C({ path: 'content.strokeColor', label: 'Stroke', kind: 'color', step: 0.005 }),
  ],
  text: [
    C({ path: 'content.fontSize', label: 'Font Size', kind: 'number', unit: 'px', min: 1, step: 0.5 }),
    C({ path: 'content.fill', label: 'Fill', kind: 'color', step: 0.005 }),
    C({ path: 'content.tracking', label: 'Tracking', kind: 'number', step: 0.5 }),
    C({ path: 'content.strokeWidth', label: 'Stroke Width', kind: 'number', unit: 'px', min: 0, step: 0.25 }),
    C({ path: 'content.strokeColor', label: 'Stroke', kind: 'color', step: 0.005 }),
  ],
  image: [],
  video: [VOLUME],
  audio: [VOLUME],
  precomp: [],
  null: [],
};

/** Layer types that have a visual representation (and therefore a transform). */
export function hasVideo(type: LayerType): boolean {
  return type !== 'audio';
}

export function propDefsFor(type: LayerType): PropDef[] {
  return hasVideo(type) ? [...TRANSFORM_PROPS, ...CONTENT_PROPS[type]] : [...CONTENT_PROPS[type]];
}

const ALL_DEFS = new Map<PropPath, PropDef>();
for (const d of TRANSFORM_PROPS) ALL_DEFS.set(d.path, d);
for (const defs of Object.values(CONTENT_PROPS)) for (const d of defs) ALL_DEFS.set(d.path, d);

export function getPropDef(path: PropPath): PropDef | undefined {
  return ALL_DEFS.get(path);
}

export function staticProp<T extends PropValue>(value: T): AnimProp<T> {
  return { value, keyframes: [] };
}

export const WHITE: Color = [1, 1, 1, 1];
export const BLACK: Color = [0, 0, 0, 1];

export function transformDefaults(anchor: Vec2, position: Vec2): Record<PropPath, AnimProp> {
  return {
    'transform.anchor': staticProp<Vec2>(anchor),
    'transform.position': staticProp<Vec2>(position),
    'transform.scale': staticProp<Vec2>([100, 100]),
    'transform.rotation': staticProp(0),
    'transform.opacity': staticProp(100),
  };
}

export function clampToDef(def: PropDef | undefined, v: number): number {
  if (!def) return v;
  if (def.min !== undefined && v < def.min) return def.min;
  if (def.max !== undefined && v > def.max) return def.max;
  return v;
}
