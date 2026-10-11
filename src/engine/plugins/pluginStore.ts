/**
 * Installed plugins: persistence (IndexedDB), install from file / URL / text,
 * export for sharing, uninstall, and loading the bundled shader packs.
 */
import { effectRegistry } from '../../core/effects/registry';
import { convertShader, type ConversionReport, type ConvertOptions } from '../../core/effects/convert';
import { PLUGIN_FORMAT, validatePlugin, type EffectPlugin } from '../../core/effects/types';
import { bundledSamples, loadGlTransitions, type BundleReport } from '../../effects/bundled';
import { WGSL_SAMPLES } from '../../effects/bundled/wgsl';
import { idb } from '../persist/db';

export interface InstallResult {
  plugin: EffectPlugin;
  report: ConversionReport | null;
}

export const bundleReport: BundleReport = { loaded: 0, skipped: [] };

/** Plugin file (shareable JSON). */
export function serializePlugin(p: EffectPlugin): string {
  const { builtin: _b, ...rest } = p;
  return JSON.stringify({ format: PLUGIN_FORMAT, version: 1, plugin: rest }, null, 2);
}

/** Parse plugin JSON or convert shader source text. */
export function parsePluginText(text: string, opts: ConvertOptions = {}): InstallResult {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && /"format"\s*:\s*"luscent-effect"/.test(trimmed)) {
    const data = JSON.parse(trimmed) as { plugin: EffectPlugin };
    const v = validatePlugin(data.plugin);
    if (!v.ok) throw new Error(v.errors.join(' '));
    return { plugin: { ...data.plugin, builtin: false }, report: null };
  }
  if (trimmed.startsWith('{')) {
    // A bare plugin object.
    const p = JSON.parse(trimmed) as EffectPlugin;
    const v = validatePlugin(p);
    if (!v.ok) throw new Error(v.errors.join(' '));
    return { plugin: { ...p, builtin: false }, report: null };
  }
  const r = convertShader(text, opts);
  return { plugin: { ...r.plugin, builtin: false }, report: r.report };
}

export const pluginStore = {
  async loadInstalled(): Promise<number> {
    const list = await idb.all<EffectPlugin>('plugins').catch(() => [] as EffectPlugin[]);
    const ok = list.filter((p) => validatePlugin(p).ok);
    effectRegistry.registerMany(ok.map((p) => ({ ...p, builtin: false })));
    return ok.length;
  },

  async install(plugin: EffectPlugin): Promise<void> {
    const v = validatePlugin(plugin);
    if (!v.ok) throw new Error(v.errors.join(' '));
    const existing = effectRegistry.get(plugin.id);
    if (existing?.plugin.builtin) throw new Error(`"${plugin.id}" is a built-in plugin id; choose another id.`);
    effectRegistry.register({ ...plugin, builtin: false });
    await idb.put('plugins', plugin.id, { ...plugin, builtin: false });
  },

  async uninstall(id: string): Promise<void> {
    const e = effectRegistry.get(id);
    if (!e || e.plugin.builtin) return;
    effectRegistry.unregister(id);
    await idb.del('plugins', id);
  },

  async installFromUrl(url: string, opts: ConvertOptions = {}): Promise<InstallResult> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const text = await res.text();
    const name = decodeURIComponent(url.split('/').pop() ?? 'Shader').replace(/\.[^.]+$/, '');
    const r = parsePluginText(text, { name, ...opts });
    r.plugin.source = { ...(r.plugin.source ?? { format: 'luscent' }), url };
    await this.install(r.plugin);
    return r;
  },

  /** Register bundled ISF/Shadertoy samples now and gl-transitions in the background. */
  async loadBundled(): Promise<void> {
    effectRegistry.registerMany([...bundledSamples(bundleReport), ...WGSL_SAMPLES]);
    const gl = await loadGlTransitions(bundleReport);
    effectRegistry.registerMany(gl);
  },
};

let bridgePromise: Promise<import('../gpu/WgslBridge').WebGpuWgslBridge | null> | null = null;

/** Shared WebGPU bridge for WGSL plugins (null when WebGPU is unavailable). */
export function getWgslBridge() {
  bridgePromise ??= import('../gpu/WgslBridge').then((m) => m.WebGpuWgslBridge.create()).catch(() => null);
  return bridgePromise;
}
