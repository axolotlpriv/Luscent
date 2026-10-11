/**
 * Luscent project data model.
 *
 * Everything here is plain, serialisable data (no class instances, no DOM
 * handles) so a project can be snapshotted for undo, saved as JSON, diffed and
 * shipped to workers. Runtime-only resources (decoded media, GPU textures,
 * waveform peaks) live in engine-side caches keyed by the ids defined here.
 *
 * Time is expressed in seconds (float). Composition time is the time on a
 * composition's own timeline; layer time is `compTime - layer.startTime`.
 * Keyframe times are stored in *layer time* so moving a layer carries its
 * animation along with it (After Effects semantics).
 */

export type Id = string;

export type Vec2 = [number, number];
/** Straight (non-premultiplied) sRGB colour, each channel 0..1. */
export type Color = [number, number, number, number];
export type PropValue = number | Vec2 | Color;

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

export type Interpolation = 'linear' | 'bezier' | 'hold';

/**
 * After Effects-style temporal ease. `speed` is in property units per second
 * measured along the segment (for vectors: along the straight path between the
 * two values), `influence` is the fraction (0..1) of the segment duration the
 * bezier handle reaches into.
 */
export interface TemporalEase {
  speed: number;
  influence: number;
}

export interface Keyframe<T extends PropValue = PropValue> {
  id: Id;
  /** Layer time in seconds. */
  time: number;
  value: T;
  /** Interpolation of the segment arriving at this keyframe. */
  inInterp: Interpolation;
  /** Interpolation of the segment leaving this keyframe. */
  outInterp: Interpolation;
  inEase: TemporalEase;
  outEase: TemporalEase;
  /**
   * Function curve (easing id, e.g. "elastic-out") overriding the segment
   * leaving this keyframe. Used for curves a cubic bezier can't express.
   */
  outCurve?: string;
}

/** AE `wiggle(freq, amp, octaves, ampMult)` as a deterministic modifier. */
export interface Wiggle {
  /** Wiggles per second. */
  freq: number;
  /** Maximum offset in property units. */
  amp: number;
  octaves: number;
  ampMult: number;
  seed: number;
}

/** An animatable property. Animated iff `keyframes.length > 0`. */
export interface AnimProp<T extends PropValue = PropValue> {
  value: T;
  keyframes: Keyframe<T>[];
  /** Optional procedural offset added on top of the animated value. */
  wiggle?: Wiggle;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type LayerType =
  | 'solid'
  | 'shape'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'precomp'
  | 'null';

export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'lighten';

/** Property paths are "group.name", e.g. "transform.position". */
export type PropPath = string;

export interface LayerBase {
  id: Id;
  name: string;
  /** Index into the label colour palette. */
  label: number;
  /** Composition time the layer becomes visible (inclusive). */
  inPoint: number;
  /** Composition time the layer stops being visible (exclusive). */
  outPoint: number;
  /** Composition time at which layer time / source time 0 occurs. */
  startTime: number;
  /** Video switch (eye). */
  visible: boolean;
  /** Audio switch (speaker). */
  audible: boolean;
  solo: boolean;
  locked: boolean;
  parentId: Id | null;
  blendMode: BlendMode;
  props: Record<PropPath, AnimProp>;
}

export interface SolidLayer extends LayerBase {
  type: 'solid';
  width: number;
  height: number;
}

export type ShapeKind = 'rect' | 'ellipse';
export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: ShapeKind;
}

export type TextAlign = 'left' | 'center' | 'right';
export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  align: TextAlign;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  mediaId: Id;
}

export interface VideoLayer extends LayerBase {
  type: 'video';
  mediaId: Id;
}

export interface AudioLayer extends LayerBase {
  type: 'audio';
  mediaId: Id;
}

export interface PrecompLayer extends LayerBase {
  type: 'precomp';
  compId: Id;
}

export interface NullLayer extends LayerBase {
  type: 'null';
}

export type Layer =
  | SolidLayer
  | ShapeLayer
  | TextLayer
  | ImageLayer
  | VideoLayer
  | AudioLayer
  | PrecompLayer
  | NullLayer;

export type MediaLayer = ImageLayer | VideoLayer | AudioLayer;

// ---------------------------------------------------------------------------
// Compositions, media, project
// ---------------------------------------------------------------------------

export interface Marker {
  id: Id;
  time: number;
  /** Optional span; 0 for a point marker. */
  duration: number;
  label: string;
  color: number;
}

export interface Composition {
  id: Id;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  background: Color;
  /** Index 0 is the TOP of the stack (drawn last), as in After Effects. */
  layers: Layer[];
  markers: Marker[];
  workArea: { start: number; end: number };
}

export type MediaKind = 'image' | 'video' | 'audio';

export interface AudioAnalysis {
  bpm: number;
  /** Beat times in source seconds. */
  beats: number[];
  /** Detected transient (onset) times in source seconds. */
  onsets: number[];
  /** 0..1 — how clearly periodic the rhythm is (low for rubato / ambient). */
  confidence: number;
}

export interface MediaItem {
  id: Id;
  name: string;
  kind: MediaKind;
  mimeType: string;
  /** Bytes. */
  size: number;
  width: number;
  height: number;
  /** Seconds; Infinity for stills. */
  duration: number;
  fps: number;
  hasAudio: boolean;
  analysis: AudioAnalysis | null;
}

export interface Project {
  version: 1;
  id: Id;
  name: string;
  compositions: Record<Id, Composition>;
  /** Display order of compositions in the project panel. */
  compOrder: Id[];
  media: Record<Id, MediaItem>;
  mediaOrder: Id[];
  /** Composition opened when the project loads. */
  mainCompId: Id;
}
