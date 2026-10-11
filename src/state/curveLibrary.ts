/**
 * User curve library: named easing curves saved from the graph editor,
 * persisted in IndexedDB and shareable as JSON files.
 */
import { create } from 'zustand';
import type { Bezier } from '../core/animation/easings';
import { uid } from '../core/model/ids';
import { idb } from '../engine/persist/db';

export interface SavedCurve {
  id: string;
  name: string;
  /** Either a cubic bezier or a reference to a built-in function curve. */
  bezier?: Bezier;
  easing?: string;
}

export const CURVES_FORMAT = 'luscent-curves';

interface CurveLibrary {
  curves: SavedCurve[];
  loaded: boolean;
  load(): Promise<void>;
  add(c: Omit<SavedCurve, 'id'>): SavedCurve;
  remove(id: string): void;
  rename(id: string, name: string): void;
  exportJSON(): string;
  importJSON(text: string): number;
}

const KEY = 'curves';

function persist(curves: SavedCurve[]) {
  void idb.put('library', KEY, curves).catch(() => undefined);
}

function valid(c: unknown): c is SavedCurve {
  const o = c as SavedCurve;
  return !!o && typeof o.name === 'string' && ((Array.isArray(o.bezier) && o.bezier.length === 4 && o.bezier.every(Number.isFinite)) || typeof o.easing === 'string');
}

export const useCurveLibrary = create<CurveLibrary>((set, get) => ({
  curves: [],
  loaded: false,
  async load() {
    const saved = await idb.get<SavedCurve[]>('library', KEY).catch(() => undefined);
    set({ curves: Array.isArray(saved) ? saved.filter(valid) : [], loaded: true });
  },
  add(c) {
    const curve = { ...c, id: uid('crv_') };
    const curves = [...get().curves, curve];
    set({ curves });
    persist(curves);
    return curve;
  },
  remove(id) {
    const curves = get().curves.filter((c) => c.id !== id);
    set({ curves });
    persist(curves);
  },
  rename(id, name) {
    const curves = get().curves.map((c) => (c.id === id ? { ...c, name } : c));
    set({ curves });
    persist(curves);
  },
  exportJSON() {
    return JSON.stringify({ format: CURVES_FORMAT, version: 1, curves: get().curves.map(({ id: _id, ...c }) => c) }, null, 2);
  },
  importJSON(text) {
    const data = JSON.parse(text) as { format?: string; curves?: unknown[] };
    if (data.format !== CURVES_FORMAT || !Array.isArray(data.curves)) throw new Error('Not a Luscent curve library file.');
    const incoming = data.curves.filter(valid).map((c) => ({ ...c, id: uid('crv_') }));
    const curves = [...get().curves, ...incoming];
    set({ curves });
    persist(curves);
    return incoming.length;
  },
}));
