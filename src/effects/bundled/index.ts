/**
 * Bundled third-party and format-sample shaders, converted at load time with
 * the same converter users get (so it is exercised on ~130 real shaders).
 */
import { convertGlTransition, convertIsf, convertShadertoy } from '../../core/effects/convert';
import type { EffectPlugin } from '../../core/effects/types';
import { ISF_SHADERS } from './isf';
import { SHADERTOY_SHADERS } from './shadertoy';

export interface BundleReport {
  loaded: number;
  skipped: Array<{ name: string; reason: string }>;
}

interface GlTransitionEntry {
  name: string;
  glsl: string;
  author: string;
  license: string;
  description?: string;
  tags?: string[];
  defaultParams: Record<string, unknown>;
  params?: Record<string, { type?: string; default?: unknown; min?: number; max?: number; step?: number; color?: boolean; description?: string }>;
}

const pretty = (name: string) =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

export function convertGlTransitionsPackage(entries: GlTransitionEntry[], report: BundleReport): EffectPlugin[] {
  const out: EffectPlugin[] = [];
  for (const e of entries) {
    try {
      const { plugin } = convertGlTransition(e.glsl, {
        id: `gl-transitions.${e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: pretty(e.name),
        category: 'gl-transitions',
        author: e.author,
        license: e.license,
        description: e.description,
        defaults: e.defaultParams,
        paramMeta: e.params,
      });
      plugin.builtin = true;
      plugin.tags = ['gl-transitions', ...(e.tags ?? [])];
      plugin.source = { ...plugin.source!, url: 'https://github.com/gl-transitions/gl-transitions' };
      out.push(plugin);
      report.loaded++;
    } catch (err) {
      report.skipped.push({ name: e.name, reason: (err as Error).message });
    }
  }
  return out;
}

export function bundledSamples(report: BundleReport): EffectPlugin[] {
  const out: EffectPlugin[] = [];
  for (const s of ISF_SHADERS) {
    try {
      const { plugin } = convertIsf(s.src, { id: s.id, license: 'MIT' });
      plugin.builtin = true;
      out.push(plugin);
      report.loaded++;
    } catch (err) {
      report.skipped.push({ name: s.id, reason: (err as Error).message });
    }
  }
  for (const s of SHADERTOY_SHADERS) {
    try {
      const { plugin } = convertShadertoy(s.src, { id: s.id, name: s.name, category: 'Shadertoy', author: 'Luscent', license: 'MIT' });
      plugin.builtin = true;
      out.push(plugin);
      report.loaded++;
    } catch (err) {
      report.skipped.push({ name: s.id, reason: (err as Error).message });
    }
  }
  return out;
}

/** Load gl-transitions lazily (it's ~1 MB of JSON) and convert every entry. */
export async function loadGlTransitions(report: BundleReport): Promise<EffectPlugin[]> {
  const mod = (await import('gl-transitions/gl-transitions.json')) as unknown as { default: GlTransitionEntry[] };
  return convertGlTransitionsPackage(mod.default, report);
}
