import { uid } from './ids';
import { BLACK, WHITE, staticProp, transformDefaults } from './properties';
import type {
  AnimProp,
  AudioLayer,
  Color,
  Composition,
  ImageLayer,
  Layer,
  LayerBase,
  MediaItem,
  NullLayer,
  PrecompLayer,
  Project,
  PropPath,
  ShapeKind,
  ShapeLayer,
  SolidLayer,
  TextLayer,
  Vec2,
  VideoLayer,
} from './types';

export interface CompPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
}

/** Short-form first: vertical presets lead the list. */
export const COMP_PRESETS: CompPreset[] = [
  { id: 'vertical-1080-30', label: '9:16 1080×1920 30fps', width: 1080, height: 1920, fps: 30 },
  { id: 'vertical-1080-60', label: '9:16 1080×1920 60fps', width: 1080, height: 1920, fps: 60 },
  { id: 'vertical-2160-60', label: '9:16 4K 2160×3840 60fps', width: 2160, height: 3840, fps: 60 },
  { id: 'square-1080-30', label: '1:1 1080×1080 30fps', width: 1080, height: 1080, fps: 30 },
  { id: 'portrait-1080-30', label: '4:5 1080×1350 30fps', width: 1080, height: 1350, fps: 30 },
  { id: 'landscape-1080-30', label: '16:9 1920×1080 30fps', width: 1920, height: 1080, fps: 30 },
  { id: 'landscape-1080-60', label: '16:9 1920×1080 60fps', width: 1920, height: 1080, fps: 60 },
  { id: 'landscape-2160-60', label: '16:9 4K 3840×2160 60fps', width: 3840, height: 2160, fps: 60 },
];

export function createComposition(opts: Partial<Omit<Composition, 'id'>> = {}): Composition {
  const duration = opts.duration ?? 15;
  return {
    id: uid('comp_'),
    name: opts.name ?? 'Comp 1',
    width: opts.width ?? 1080,
    height: opts.height ?? 1920,
    fps: opts.fps ?? 30,
    duration,
    background: opts.background ?? [0.04, 0.04, 0.05, 1],
    layers: opts.layers ?? [],
    markers: opts.markers ?? [],
    workArea: opts.workArea ?? { start: 0, end: duration },
  };
}

export function createProject(name = 'Untitled Project'): Project {
  const comp = createComposition({ name: 'Main' });
  return {
    version: 1,
    id: uid('proj_'),
    name,
    compositions: { [comp.id]: comp },
    compOrder: [comp.id],
    media: {},
    mediaOrder: [],
    mainCompId: comp.id,
  };
}

let labelCursor = 0;
function nextLabel(): number {
  labelCursor = (labelCursor + 1) % LABEL_COLORS.length;
  return labelCursor;
}

/** Label palette used for layer bars (AE style). */
export const LABEL_COLORS = [
  '#ff3d7f', // hot pink
  '#7c5cff', // violet
  '#2ec5ff', // sky
  '#21e6a1', // mint
  '#c8ff3d', // lime
  '#ffcf3d', // amber
  '#ff7a3d', // orange
  '#ff5555', // red
  '#9aa3b5', // slate
];

interface BaseOpts {
  name?: string;
  inPoint?: number;
  outPoint?: number;
  comp: Pick<Composition, 'width' | 'height' | 'duration'>;
}

function base(
  opts: BaseOpts,
  defaultName: string,
  anchor: Vec2 | null,
  extraProps: Record<PropPath, AnimProp>,
): LayerBase {
  const inPoint = opts.inPoint ?? 0;
  const outPoint = opts.outPoint ?? opts.comp.duration;
  return {
    id: uid('lyr_'),
    name: opts.name ?? defaultName,
    label: nextLabel(),
    inPoint,
    outPoint,
    startTime: inPoint,
    visible: true,
    audible: true,
    solo: false,
    locked: false,
    parentId: null,
    blendMode: 'normal',
    props: {
      ...(anchor ? transformDefaults(anchor, [opts.comp.width / 2, opts.comp.height / 2]) : {}),
      ...extraProps,
    },
  };
}

export function createSolidLayer(opts: BaseOpts & { color?: Color; width?: number; height?: number }): SolidLayer {
  const width = opts.width ?? opts.comp.width;
  const height = opts.height ?? opts.comp.height;
  return {
    ...base(opts, 'Solid', [width / 2, height / 2], { 'content.color': staticProp<Color>(opts.color ?? [1, 0.24, 0.5, 1]) }),
    type: 'solid',
    width,
    height,
  };
}

export function createShapeLayer(
  opts: BaseOpts & { shape?: ShapeKind; size?: Vec2; fill?: Color },
): ShapeLayer {
  const shape = opts.shape ?? 'rect';
  return {
    ...base(opts, shape === 'rect' ? 'Rectangle' : 'Ellipse', [0, 0], {
      'content.size': staticProp<Vec2>(opts.size ?? [400, 400]),
      'content.roundness': staticProp(shape === 'rect' ? 24 : 0),
      'content.fill': staticProp<Color>(opts.fill ?? WHITE),
      'content.strokeWidth': staticProp(0),
      'content.strokeColor': staticProp<Color>(BLACK),
    }),
    type: 'shape',
    shape,
  };
}

export function createTextLayer(opts: BaseOpts & { text?: string; fontSize?: number }): TextLayer {
  const text = opts.text ?? 'Your text';
  return {
    ...base(opts, text.slice(0, 24) || 'Text', [0, 0], {
      'content.fontSize': staticProp(opts.fontSize ?? 120),
      'content.fill': staticProp<Color>(WHITE),
      'content.tracking': staticProp(0),
      'content.strokeWidth': staticProp(0),
      'content.strokeColor': staticProp<Color>(BLACK),
    }),
    type: 'text',
    text,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontWeight: 800,
    italic: false,
    align: 'center',
  };
}

export function createNullLayer(opts: BaseOpts): NullLayer {
  return { ...base(opts, 'Null', [0, 0], {}), type: 'null' };
}

export function createMediaLayer(
  opts: BaseOpts & { media: MediaItem; startTime?: number },
): ImageLayer | VideoLayer | AudioLayer {
  const { media } = opts;
  const startTime = opts.startTime ?? opts.inPoint ?? 0;
  const inPoint = opts.inPoint ?? startTime;
  const outPoint =
    opts.outPoint ??
    (Number.isFinite(media.duration) ? startTime + media.duration : inPoint + Math.min(opts.comp.duration, 5));
  const o = { ...opts, inPoint, outPoint, name: opts.name ?? media.name };
  if (media.kind === 'audio') {
    const l: AudioLayer = {
      ...base(o, media.name, null, { 'audio.volume': staticProp(0) }),
      type: 'audio',
      mediaId: media.id,
    };
    l.startTime = startTime;
    return l;
  }
  // Fit media to the composition (cover on the short axis, like a typical
  // phone editor "fill") while keeping pixels 1:1 when it already fits.
  const fit = Math.min(opts.comp.width / media.width, opts.comp.height / media.height);
  const scale = fit < 1 ? fit * 100 : 100;
  const anchor: Vec2 = [media.width / 2, media.height / 2];
  if (media.kind === 'image') {
    const l: ImageLayer = { ...base(o, media.name, anchor, {}), type: 'image', mediaId: media.id };
    l.props['transform.scale'] = staticProp<Vec2>([scale, scale]);
    l.startTime = startTime;
    return l;
  }
  const l: VideoLayer = {
    ...base(o, media.name, anchor, media.hasAudio ? { 'audio.volume': staticProp(0) } : {}),
    type: 'video',
    mediaId: media.id,
  };
  l.props['transform.scale'] = staticProp<Vec2>([scale, scale]);
  l.startTime = startTime;
  return l;
}

export function createPrecompLayer(opts: BaseOpts & { target: Composition }): PrecompLayer {
  const { target } = opts;
  return {
    ...base({ ...opts, outPoint: opts.outPoint ?? (opts.inPoint ?? 0) + target.duration }, target.name, [
      target.width / 2,
      target.height / 2,
    ], {}),
    type: 'precomp',
    compId: target.id,
  };
}

/**
 * Deep copy of plain data. Unlike structuredClone this also works on immer
 * drafts (proxies), so ops can clone layers mid-edit.
 */
export function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(deepClone) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = deepClone((v as Record<string, unknown>)[k]);
    return out as T;
  }
  return v;
}

/** Deep-clone a layer giving it (and its keyframes) fresh ids. */
export function cloneLayer<L extends Layer>(layer: L, nameSuffix = ''): L {
  const copy = deepClone(layer);
  copy.id = uid('lyr_');
  copy.name = layer.name + nameSuffix;
  for (const prop of Object.values(copy.props)) {
    for (const k of prop.keyframes) k.id = uid('kf_');
  }
  return copy;
}
