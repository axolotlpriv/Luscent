/**
 * Composition evaluation: turns the project model at a given time into a flat,
 * renderer-agnostic draw list. Precomps evaluate recursively into nested lists
 * that the renderer composites through an offscreen target.
 */
import { evaluateProp } from '../animation/interpolate';
import type { BlendMode, Color, Composition, FrameBlending, Id, Layer, Project, TextAlign, Vec2 } from '../model/types';
import { effectRegistry, fxPath } from '../effects/registry';
import { pluginParams } from '../effects/types';
import { IDENTITY, apply, layerMatrix, multiply, type Mat2D } from './matrix';

export type Rect = [number, number, number, number];

export interface TextSpec {
  text: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  tracking: number;
  align: TextAlign;
  fill: Color;
  strokeWidth: number;
  strokeColor: Color;
}

/** An enabled effect with its parameters evaluated for this frame. */
export interface EvaluatedEffect {
  instanceId: Id;
  pluginId: string;
  kind: 'effect' | 'transition';
  /**
   * Uniform values by param id: scalars, [x, y] (points normalised to 0..1
   * of the comp), or straight RGBA colours.
   */
  params: Record<string, number | number[]>;
}

interface ItemBase {
  layerId: Id;
  /** Layer space → composition pixel space. */
  matrix: Mat2D;
  /** Quad covered by the layer content, in layer space. */
  rect: Rect;
  opacity: number;
  blend: BlendMode;
  /** Enabled effects in stack order (absent when none). */
  effects?: EvaluatedEffect[];
  /** Adjustment layer: content is a mask; effects process everything below. */
  adjustment?: boolean;
  /** Seconds since the layer's in point / until its out point (transitions). */
  sinceIn: number;
  untilOut: number;
  /** Layer time (for effects that animate on their own clock). */
  layerTime: number;
}

export interface ShapeItem extends ItemBase {
  kind: 'shape';
  shape: 'rect' | 'ellipse';
  size: Vec2;
  roundness: number;
  fill: Color;
  strokeWidth: number;
  strokeColor: Color;
}

export interface TextItem extends ItemBase {
  kind: 'text';
  spec: TextSpec;
}

export interface ImageItem extends ItemBase {
  kind: 'image';
  mediaId: Id;
}

export interface VideoItem extends ItemBase {
  kind: 'video';
  mediaId: Id;
  /**
   * Unique per on-screen instance: the layer id prefixed by the chain of
   * precomp layer ids it is nested in (a precomp used twice shows the same
   * video layer at two different source times).
   */
  key: string;
  /** Seconds into the source media. */
  sourceTime: number;
  /** Playback speed of the source (1 = realtime; derivative of time remap). */
  speed: number;
  frameBlending: FrameBlending;
}

export interface PrecompItem extends ItemBase {
  kind: 'precomp';
  frame: CompFrame;
}

export type RenderItem = ShapeItem | TextItem | ImageItem | VideoItem | PrecompItem;

export interface CompFrame {
  compId: Id;
  width: number;
  height: number;
  background: Color;
  time: number;
  /** Draw order: first item is drawn first (bottom of the stack). */
  items: RenderItem[];
}

export interface EvalContext {
  /** Layer-space bounds of a text block (origin = alignment point on first baseline). */
  measureText: (spec: TextSpec) => Rect;
  maxDepth?: number;
}

/** Rough text metrics for non-DOM environments (tests, workers without canvas). */
export const approximateTextMeasure = (spec: TextSpec): Rect => {
  const lines = spec.text.split('\n');
  const w = Math.max(...lines.map((l) => l.length)) * spec.fontSize * 0.6;
  const h = lines.length * spec.fontSize * 1.2;
  const x = spec.align === 'left' ? 0 : spec.align === 'right' ? -w : -w / 2;
  return [x, -spec.fontSize * 0.9, w, h];
};

function num(layer: Layer, path: string, lt: number, fallback = 0): number {
  const p = layer.props[path];
  return p ? (evaluateProp(p, lt) as number) : fallback;
}
function vec(layer: Layer, path: string, lt: number, fallback: Vec2 = [0, 0]): Vec2 {
  const p = layer.props[path];
  return p ? (evaluateProp(p, lt) as Vec2) : fallback;
}
function col(layer: Layer, path: string, lt: number, fallback: Color = [1, 1, 1, 1]): Color {
  const p = layer.props[path];
  return p ? (evaluateProp(p, lt) as Color) : fallback;
}

export function isLayerActive(layer: Layer, t: number): boolean {
  return t >= layer.inPoint - 1e-9 && t < layer.outPoint - 1e-9;
}

/** Local (unparented) layer matrix at comp time t. */
export function localMatrix(layer: Layer, t: number): Mat2D {
  if (layer.type === 'audio') return IDENTITY;
  const lt = t - layer.startTime;
  return layerMatrix(
    vec(layer, 'transform.anchor', lt),
    vec(layer, 'transform.position', lt),
    vec(layer, 'transform.scale', lt, [100, 100]),
    num(layer, 'transform.rotation', lt),
  );
}

/** World matrix including the parent chain. Parents are evaluated at the same comp time. */
export function worldMatrix(comp: Composition, layer: Layer, t: number): Mat2D {
  let m = localMatrix(layer, t);
  const seen = new Set<Id>([layer.id]);
  let pid = layer.parentId;
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const parent = comp.layers.find((l) => l.id === pid);
    if (!parent) break;
    m = multiply(localMatrix(parent, t), m);
    pid = parent.parentId;
  }
  return m;
}

export function textSpecOf(layer: Layer & { type: 'text' }, lt: number): TextSpec {
  return {
    text: layer.text,
    fontFamily: layer.fontFamily,
    fontWeight: layer.fontWeight,
    italic: layer.italic,
    align: layer.align,
    fontSize: Math.max(1, num(layer, 'content.fontSize', lt, 100)),
    tracking: num(layer, 'content.tracking', lt),
    fill: col(layer, 'content.fill', lt),
    strokeWidth: Math.max(0, num(layer, 'content.strokeWidth', lt)),
    strokeColor: col(layer, 'content.strokeColor', lt),
  };
}

/** Source time for a layer (time remap aware), and the instantaneous source speed. */
export function sourceTimeOf(layer: Layer, t: number): { time: number; speed: number } {
  const lt = t - layer.startTime;
  const remap = layer.timeRemap ? layer.props['time.remap'] : undefined;
  if (!remap) return { time: lt, speed: 1 };
  const h = 1 / 240;
  const a = evaluateProp(remap, lt - h) as number;
  const b = evaluateProp(remap, lt + h) as number;
  return { time: evaluateProp(remap, lt) as number, speed: (b - a) / (2 * h) };
}

/** Evaluate a layer's enabled effects for this frame. */
export function evaluateEffects(layer: Layer, comp: Composition, lt: number): EvaluatedEffect[] | undefined {
  const list = layer.effects;
  if (!list || list.length === 0) return undefined;
  const out: EvaluatedEffect[] = [];
  for (const inst of list) {
    if (!inst.enabled) continue;
    const reg = effectRegistry.get(inst.pluginId);
    if (!reg) continue;
    const params: Record<string, number | number[]> = {};
    for (const spec of pluginParams(reg.plugin)) {
      const prop = layer.props[fxPath(inst.id, spec.id)];
      let v: number | number[];
      if (prop) v = evaluateProp(prop, lt) as number | number[];
      else if (spec.type === 'point') v = (spec.default as number[]).slice();
      else v = Array.isArray(spec.default) ? spec.default.slice() : spec.default;
      if (spec.type === 'point' && prop) v = [(v as number[])[0] / comp.width, (v as number[])[1] / comp.height];
      params[spec.id] = v;
    }
    out.push({ instanceId: inst.id, pluginId: inst.pluginId, kind: reg.plugin.kind, params });
  }
  return out.length ? out : undefined;
}

/** Build the draw item for one layer, or null if it draws nothing. */
export function evaluateLayer(
  project: Project,
  comp: Composition,
  layer: Layer,
  t: number,
  ctx: EvalContext,
  depth = 0,
  prefix = '',
): RenderItem | null {
  const item = evaluateContent(project, comp, layer, t, ctx, depth, prefix);
  const lt = t - layer.startTime;
  if (layer.adjustment && layer.type !== 'audio') {
    const effects = evaluateEffects(layer, comp, lt);
    const base = item ?? {
      // A null adjustment layer covers the whole frame.
      layerId: layer.id,
      kind: 'shape' as const,
      shape: 'rect' as const,
      matrix: IDENTITY,
      rect: [0, 0, comp.width, comp.height] as Rect,
      size: [comp.width, comp.height] as Vec2,
      roundness: 0,
      fill: [1, 1, 1, 1] as Color,
      strokeWidth: 0,
      strokeColor: [0, 0, 0, 0] as Color,
      opacity: Math.min(1, Math.max(0, num(layer, 'transform.opacity', lt, 100) / 100)),
      blend: layer.blendMode,
      sinceIn: t - layer.inPoint,
      untilOut: layer.outPoint - t,
      layerTime: lt,
    };
    return { ...base, adjustment: true, effects };
  }
  if (!item) return null;
  const effects = evaluateEffects(layer, comp, lt);
  return effects ? { ...item, effects } : item;
}

function evaluateContent(
  project: Project,
  comp: Composition,
  layer: Layer,
  t: number,
  ctx: EvalContext,
  depth: number,
  prefix: string,
): RenderItem | null {
  const lt = t - layer.startTime;
  const opacity = Math.min(1, Math.max(0, num(layer, 'transform.opacity', lt, 100) / 100));
  const base = {
    layerId: layer.id,
    matrix: worldMatrix(comp, layer, t),
    opacity,
    blend: layer.blendMode,
    sinceIn: t - layer.inPoint,
    untilOut: layer.outPoint - t,
    layerTime: lt,
  };
  switch (layer.type) {
    case 'solid':
      return {
        ...base,
        kind: 'shape',
        shape: 'rect',
        rect: [0, 0, layer.width, layer.height],
        size: [layer.width, layer.height],
        roundness: 0,
        fill: col(layer, 'content.color', lt),
        strokeWidth: 0,
        strokeColor: [0, 0, 0, 0],
      };
    case 'shape': {
      const size = vec(layer, 'content.size', lt, [100, 100]).map((v) => Math.max(0, v)) as Vec2;
      const sw = Math.max(0, num(layer, 'content.strokeWidth', lt));
      const pad = sw / 2 + 1;
      return {
        ...base,
        kind: 'shape',
        shape: layer.shape,
        rect: [-size[0] / 2 - pad, -size[1] / 2 - pad, size[0] + 2 * pad, size[1] + 2 * pad],
        size,
        roundness: Math.max(0, num(layer, 'content.roundness', lt)),
        fill: col(layer, 'content.fill', lt),
        strokeWidth: sw,
        strokeColor: col(layer, 'content.strokeColor', lt),
      };
    }
    case 'text': {
      const spec = textSpecOf(layer, lt);
      if (!spec.text) return null;
      return { ...base, kind: 'text', spec, rect: ctx.measureText(spec) };
    }
    case 'image': {
      const m = project.media[layer.mediaId];
      if (!m) return null;
      return { ...base, kind: 'image', mediaId: m.id, rect: [0, 0, m.width, m.height] };
    }
    case 'video': {
      const m = project.media[layer.mediaId];
      if (!m) return null;
      const src = sourceTimeOf(layer, t);
      return {
        ...base,
        kind: 'video',
        mediaId: m.id,
        key: prefix + layer.id,
        sourceTime: src.time,
        speed: src.speed,
        frameBlending: layer.timeRemap ? (layer.frameBlending ?? 'none') : 'none',
        rect: [0, 0, m.width, m.height],
      };
    }
    case 'precomp': {
      const max = ctx.maxDepth ?? 16;
      if (depth >= max) return null;
      const frame = evaluateComposition(project, layer.compId, sourceTimeOf(layer, t).time, ctx, depth + 1, `${prefix}${layer.id}/`);
      if (!frame) return null;
      return { ...base, kind: 'precomp', frame, rect: [0, 0, frame.width, frame.height] };
    }
    case 'audio':
    case 'null':
      return null;
  }
}

export function visibleLayers(comp: Composition, t: number): Layer[] {
  const anySolo = comp.layers.some((l) => l.solo && l.type !== 'audio');
  return comp.layers.filter((l) => l.visible && (!anySolo || l.solo) && isLayerActive(l, t));
}

export function evaluateComposition(
  project: Project,
  compId: Id,
  t: number,
  ctx: EvalContext,
  depth = 0,
  prefix = '',
): CompFrame | null {
  const comp = project.compositions[compId];
  if (!comp) return null;
  const items: RenderItem[] = [];
  const layers = visibleLayers(comp, t);
  // Bottom of the stack draws first.
  for (let i = layers.length - 1; i >= 0; i--) {
    const item = evaluateLayer(project, comp, layers[i], t, ctx, depth, prefix);
    if (item && (item.opacity > 0 || item.effects?.some((e) => e.kind === 'transition'))) items.push(item);
  }
  return { compId, width: comp.width, height: comp.height, background: comp.background, time: t, items };
}

/** Corners of a layer's content quad in comp space (for selection boxes & hit tests). */
export function itemCorners(item: Pick<RenderItem, 'matrix' | 'rect'>): [number, number][] {
  const [x, y, w, h] = item.rect;
  return [apply(item.matrix, x, y), apply(item.matrix, x + w, y), apply(item.matrix, x + w, y + h), apply(item.matrix, x, y + h)];
}

/** Point-in-convex-quad test (works for any winding). */
export function pointInQuad(px: number, py: number, q: [number, number][]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross !== 0) {
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/** Collect every media id referenced (transitively) by a composition. */
export function referencedMedia(project: Project, compId: Id, out = new Set<Id>(), seen = new Set<Id>()): Set<Id> {
  if (seen.has(compId)) return out;
  seen.add(compId);
  const comp = project.compositions[compId];
  if (!comp) return out;
  for (const l of comp.layers) {
    if (l.type === 'image' || l.type === 'video' || l.type === 'audio') out.add(l.mediaId);
    else if (l.type === 'precomp') referencedMedia(project, l.compId, out, seen);
  }
  return out;
}

/** Every video item in a frame tree (for driving decoders). */
export function collectVideoItems(frame: CompFrame, out: VideoItem[] = []): VideoItem[] {
  for (const it of frame.items) {
    if (it.kind === 'video') out.push(it);
    else if (it.kind === 'precomp') collectVideoItems(it.frame, out);
  }
  return out;
}
