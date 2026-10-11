import type { LuscentPreset } from '../../core/presets/types';
import { allPresets, usePresetLibrary } from '../../state/presetLibrary';
import { editor } from '../../state/store';

export const PRESET_DRAG_TYPE = 'application/x-luscent-preset';

export function findPreset(id: string): LuscentPreset | undefined {
  return allPresets(usePresetLibrary.getState().user).find((p) => p.id === id);
}

/** Apply a preset at the playhead and report the outcome as a toast. */
export function applyPresetWithToast(preset: LuscentPreset): void {
  const s = editor();
  const r = s.applyPreset(preset);
  if (!r.applied.length) {
    s.toast(r.skipped[0] ?? `Nothing to apply for “${preset.name}”.`, 'error');
    return;
  }
  const layers = new Set(r.applied.map((a) => a.split(':')[0]));
  const extra = r.skipped.length ? ` · skipped: ${r.skipped[0]}${r.skipped.length > 1 ? ` (+${r.skipped.length - 1})` : ''}` : '';
  s.toast(`${preset.name} → ${layers.size === 1 ? [...layers][0] : `${layers.size} layers`}${extra}`, r.skipped.length ? 'info' : 'success');
}
