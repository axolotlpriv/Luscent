/**
 * Short vibrations that confirm touch actions (snapping, long-press, adding a
 * keyframe). Phones only; silently does nothing elsewhere.
 */
const PATTERNS = { tick: 8, select: 12, confirm: [10, 40, 14] } as const;
let last = 0;

export function haptic(kind: keyof typeof PATTERNS = 'tick'): void {
  const nav = navigator as Navigator & { vibrate?: (p: number | readonly number[]) => boolean };
  if (!nav.vibrate || !matchMedia('(pointer: coarse)').matches) return;
  const now = performance.now();
  if (kind === 'tick' && now - last < 60) return; // don't buzz continuously while sliding along a target
  last = now;
  try {
    nav.vibrate(PATTERNS[kind] as number | number[]);
  } catch {
    /* not allowed before a user gesture */
  }
}
