import { effectRegistry } from '../core/effects/registry';
import { BUILTIN_EFFECTS } from './builtin/effects';
import { BUILTIN_TRANSITIONS } from './builtin/transitions';

let done = false;

/** Register every built-in effect and transition (idempotent). */
export function registerBuiltinEffects(): void {
  if (done) return;
  done = true;
  effectRegistry.registerMany([...BUILTIN_EFFECTS, ...BUILTIN_TRANSITIONS]);
}
