/**
 * Preset library: the built-in presets plus the user's own (saved from
 * layers, imported from JSON or After Effects .ffx), persisted in IndexedDB.
 */
import { create } from 'zustand';
import { importAfterEffects, type FfxReport } from '../core/ffx/import';
import { validatePreset, type LuscentPreset } from '../core/presets/types';
import { idb } from '../engine/persist/db';
import { BUILTIN_PRESETS } from '../presets/builtin';

/** A file holding several presets. */
export const PRESET_BUNDLE_FORMAT = 'luscent-presets';

interface PresetLibrary {
  user: LuscentPreset[];
  loaded: boolean;
  load(): Promise<void>;
  save(p: LuscentPreset): LuscentPreset;
  remove(id: string): void;
  /** Import .json (one preset, an array or a bundle) or AE .ffx/.aep. */
  importFile(file: File): Promise<{ presets: LuscentPreset[]; report?: FfxReport }>;
  exportJSON(ids: string[]): string;
}

function persist(p: LuscentPreset) {
  void idb.put('presets', p.id, p).catch(() => undefined);
}

/** Built-ins first, then user presets. */
export function allPresets(user: LuscentPreset[]): LuscentPreset[] {
  return [...BUILTIN_PRESETS, ...user];
}

/** Parse preset JSON text: a single preset, an array or a bundle. */
export function parsePresetJSON(text: string): LuscentPreset[] {
  const data = JSON.parse(text) as unknown;
  const list = Array.isArray(data)
    ? data
    : (data as { format?: string }).format === PRESET_BUNDLE_FORMAT
      ? ((data as { presets?: unknown[] }).presets ?? [])
      : [data];
  const out: LuscentPreset[] = [];
  const errors: string[] = [];
  for (const p of list) {
    const errs = validatePreset(p);
    if (errs.length) errors.push(`${(p as LuscentPreset)?.name ?? 'preset'}: ${errs.join(' ')}`);
    else out.push(p as LuscentPreset);
  }
  if (!out.length) throw new Error(errors[0] ?? 'No presets found in this file.');
  return out;
}

export const usePresetLibrary = create<PresetLibrary>((set, get) => ({
  user: [],
  loaded: false,
  async load() {
    const saved = await idb.all<LuscentPreset>('presets').catch(() => [] as LuscentPreset[]);
    set({ user: saved.filter((p) => validatePreset(p).length === 0), loaded: true });
  },
  save(p) {
    // Never shadow a built-in id; re-saving a user preset replaces it.
    const preset: LuscentPreset = { ...p, builtin: undefined };
    if (BUILTIN_PRESETS.some((b) => b.id === preset.id)) preset.id = `${preset.id}.copy`;
    set({ user: [...get().user.filter((u) => u.id !== preset.id), preset] });
    persist(preset);
    return preset;
  },
  remove(id) {
    set({ user: get().user.filter((p) => p.id !== id) });
    void idb.del('presets', id).catch(() => undefined);
  },
  async importFile(file) {
    if (/\.(ffx|aep)$/i.test(file.name)) {
      const { preset, report } = importAfterEffects(new Uint8Array(await file.arrayBuffer()), file.name);
      return { presets: [get().save(preset)], report };
    }
    const presets = parsePresetJSON(await file.text()).map((p) => get().save(p));
    return { presets };
  },
  exportJSON(ids) {
    const pick = allPresets(get().user).filter((p) => ids.includes(p.id));
    const clean = pick.map(({ builtin: _b, ...p }) => p);
    if (clean.length === 1) return JSON.stringify(clean[0], null, 2);
    return JSON.stringify({ format: PRESET_BUNDLE_FORMAT, version: 1, presets: clean }, null, 2);
  },
}));
