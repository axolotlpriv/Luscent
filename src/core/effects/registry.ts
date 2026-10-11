/**
 * Effect registry: built-in and installed plugins, hot-reloadable.
 *
 * Every (re)registration bumps a revision so the renderer recompiles shaders
 * and the UI refreshes. Also installs the dynamic property definitions that
 * expose effect parameters to the timeline, inspector and graph editor.
 */
import { setDynamicPropDefs, TIME_REMAP_DEF, type PropDef } from '../model/properties';
import { staticProp } from '../model/properties';
import { uid } from '../model/ids';
import type { AnimProp, Color, EffectInstance, Layer, PropPath, Vec2 } from '../model/types';
import { pluginParams, validatePlugin, type EffectPlugin, type ParamSpec } from './types';

export interface RegisteredPlugin {
  plugin: EffectPlugin;
  /** Increments on every re-registration (hot reload). */
  rev: number;
  /** Last shader compile error reported by a renderer, if any. */
  error: string | null;
}

const plugins = new Map<string, RegisteredPlugin>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  for (const l of listeners) l();
}

export const effectRegistry = {
  get version() {
    return version;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  register(plugin: EffectPlugin, opts: { silent?: boolean } = {}): RegisteredPlugin {
    const v = validatePlugin(plugin);
    if (!v.ok) throw new Error(`Invalid plugin "${plugin?.id}": ${v.errors.join(' ')}`);
    const prev = plugins.get(plugin.id);
    const entry: RegisteredPlugin = { plugin, rev: (prev?.rev ?? 0) + 1, error: null };
    plugins.set(plugin.id, entry);
    if (!opts.silent) notify();
    return entry;
  },
  registerMany(list: EffectPlugin[]): void {
    for (const p of list) {
      try {
        this.register(p, { silent: true });
      } catch (err) {
        console.warn(err);
      }
    }
    notify();
  },
  unregister(id: string): void {
    if (plugins.delete(id)) notify();
  },
  get(id: string): RegisteredPlugin | undefined {
    return plugins.get(id);
  },
  all(): RegisteredPlugin[] {
    return [...plugins.values()];
  },
  setError(id: string, error: string | null): void {
    const e = plugins.get(id);
    if (!e || e.error === error) return;
    e.error = error;
    notify();
  },
};

export const fxPath = (instanceId: string, paramId: string): PropPath => `fx.${instanceId}.${paramId}`;

export interface CompDims {
  width: number;
  height: number;
}

/** Default AnimProp for a parameter (points are stored in comp pixels). */
export function defaultParamProp(spec: ParamSpec, comp: CompDims): AnimProp {
  const d = spec.default;
  if (spec.type === 'point') {
    const [x, y] = d as number[];
    return staticProp<Vec2>([x * comp.width, y * comp.height]);
  }
  if (spec.type === 'vec2') return staticProp<Vec2>([(d as number[])[0], (d as number[])[1]]);
  if (spec.type === 'color') return staticProp<Color>((d as number[]).slice(0, 4) as Color);
  return staticProp(d as number);
}

/** Create an effect instance and its parameter props for a layer. */
export function instantiateEffect(plugin: EffectPlugin, comp: CompDims): { instance: EffectInstance; props: Record<PropPath, AnimProp> } {
  const instance: EffectInstance = { id: uid('fx_'), pluginId: plugin.id, enabled: true };
  const props: Record<PropPath, AnimProp> = {};
  for (const spec of pluginParams(plugin)) props[fxPath(instance.id, spec.id)] = defaultParamProp(spec, comp);
  return { instance, props };
}

function paramDef(plugin: EffectPlugin, inst: EffectInstance, spec: ParamSpec): PropDef {
  const kind = spec.type === 'point' || spec.type === 'vec2' ? 'vec2' : spec.type === 'color' ? 'color' : 'number';
  const unit =
    spec.type === 'angle' ? '°' : spec.type === 'percent' ? '%' : spec.type === 'pixels' || spec.type === 'point' ? 'px' : spec.hint === 'seconds' ? 's' : undefined;
  const range = spec.max !== undefined && spec.min !== undefined ? spec.max - spec.min : 100;
  return {
    path: fxPath(inst.id, spec.id),
    label: `${plugin.name} › ${spec.label ?? spec.id}`,
    group: 'effects',
    kind,
    unit,
    min: spec.type === 'bool' ? 0 : spec.type === 'choice' ? 0 : spec.min,
    max: spec.type === 'bool' ? 1 : spec.type === 'choice' ? (spec.options?.length ?? 1) - 1 : spec.max,
    step: spec.step ?? (spec.type === 'int' || spec.type === 'choice' ? 0.05 : kind === 'color' ? 0.005 : Math.max(0.001, range / 400)),
    options: spec.type === 'choice' ? spec.options : undefined,
    toggle: spec.type === 'bool' ? true : undefined,
  };
}

/** Property definitions for a layer's effect params (and time remap). */
export function layerDynamicDefs(layer: Layer): PropDef[] {
  const out: PropDef[] = [];
  if (layer.timeRemap && layer.props['time.remap']) out.push(TIME_REMAP_DEF);
  for (const inst of layer.effects ?? []) {
    const reg = plugins.get(inst.pluginId);
    if (!reg) continue;
    for (const spec of pluginParams(reg.plugin)) {
      if (layer.props[fxPath(inst.id, spec.id)]) out.push(paramDef(reg.plugin, inst, spec));
    }
  }
  return out;
}

setDynamicPropDefs((l) => layerDynamicDefs(l as Layer));
