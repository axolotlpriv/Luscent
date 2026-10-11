/**
 * Editor state (zustand) and every user-facing action.
 *
 * The project is immutable: edits run through immer and each committed change
 * pushes the previous project onto the undo history. UI-only state
 * (selection, zoom, playhead) lives alongside but is not part of undo.
 */
import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import { History } from '../core/history/history';
import {
  COMP_PRESETS,
  cloneLayer,
  deepClone,
  createComposition,
  createMediaLayer,
  createNullLayer,
  createPrecompLayer,
  createProject,
  createShapeLayer,
  createSolidLayer,
  createTextLayer,
  type CompPreset,
} from '../core/model/factory';
import { uid } from '../core/model/ids';
import { getPropDef } from '../core/model/properties';
import type {
  AnimProp,
  AudioAnalysis,
  Composition,
  Id,
  Interpolation,
  Layer,
  Marker,
  Project,
  PropPath,
  PropValue,
} from '../core/model/types';
import {
  addKeyframeAt,
  easyEase,
  moveKeyframes,
  nextKeyframeTime,
  prevKeyframeTime,
  removeKeyframes,
  setInterpolation,
  setValueAt,
  toggleAnimation,
  type EaseSide,
} from '../core/animation/keyframes';
import {
  deleteLayers,
  duplicateLayers,
  extractRange,
  makeEditContext,
  moveLayers,
  reorderLayers,
  rippleDeleteLayers,
  sequenceLayers,
  slipLayer,
  splitLayers,
  trimLayer,
  wouldCycle,
  type Edge,
} from '../core/timeline/ops';
import { isLayerActive } from '../core/render/evaluate';
import { compContains, precompose } from '../core/timeline/precompose';
import { clamp, quantize } from '../core/time';
import { mediaEngine } from '../engine/media/MediaEngine';
import { idb } from '../engine/persist/db';

export interface KeySel {
  layerId: Id;
  path: PropPath;
  keyId: Id;
}
export const keySelId = (k: KeySel) => `${k.layerId}|${k.path}|${k.keyId}`;

export type SelectMode = 'replace' | 'toggle' | 'add';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
}

export type LayerKind = 'solid' | 'rect' | 'ellipse' | 'text' | 'null' | 'flash';

export interface EditorState {
  project: Project;
  activeCompId: Id;
  /** Breadcrumb of comps opened via precomp layers (root first). */
  compStack: Id[];
  playhead: number;
  playing: boolean;
  loop: boolean;
  selectedLayers: Id[];
  selectedKeys: Record<string, KeySel>;
  expanded: Record<Id, boolean>;
  /** When set, only these property paths are revealed in the timeline (AE P/S/R/T/A/U). */
  reveal: PropPath[] | 'animated' | null;
  pxPerSec: number;
  /** Seconds at the left edge of the timeline track area. */
  scrollTime: number;
  snapping: boolean;
  beatSnap: boolean;
  /** Trims and deletes ripple downstream layers by default (Alt inverts). */
  ripple: boolean;
  /** Preview resolution factor; 0 = automatic (matches viewer zoom). */
  previewScale: number;
  safeZones: boolean;
  toasts: Toast[];
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Bumped when runtime media resources change (decoded, analysed). */
  mediaVersion: number;
  dirty: boolean;
}

const history = new History<Project>(300);
let clipboard: { layers: Layer[]; fromComp: Id } | null = null;
let toastSeq = 0;

function initialState(project: Project): Omit<EditorState, keyof Actions> {
  return {
    project,
    activeCompId: project.mainCompId,
    compStack: [project.mainCompId],
    playhead: 0,
    playing: false,
    loop: true,
    selectedLayers: [],
    selectedKeys: {},
    expanded: {},
    reveal: null,
    pxPerSec: 120,
    scrollTime: -0.1,
    snapping: true,
    beatSnap: true,
    ripple: false,
    previewScale: 0,
    safeZones: false,
    toasts: [],
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    mediaVersion: 0,
    dirty: false,
  };
}

export interface Actions {
  // history
  undo(): void;
  redo(): void;
  beginGesture(label: string): void;
  endGesture(): void;
  /** Low-level: apply an immer recipe to the project as one undo step. */
  edit(label: string, recipe: (p: Draft<Project>) => void): void;
  /**
   * Replace the project with `recipe` applied to `base` (a snapshot taken at
   * gesture start). Drags use this so every move is computed from the
   * original state instead of accumulating rounding.
   */
  editFrom(base: Project, label: string, recipe: (p: Draft<Project>) => void): void;
  // project
  newProject(): void;
  loadProject(p: Project): void;
  renameProject(name: string): void;
  toast(message: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  // comps
  createComp(preset?: CompPreset, name?: string): Id;
  updateComp(patch: Partial<Pick<Composition, 'name' | 'width' | 'height' | 'fps' | 'duration' | 'background'>>): void;
  openComp(id: Id, opts?: { fromLayer?: Id }): void;
  breadcrumb(index: number): void;
  deleteComp(id: Id): void;
  // media
  importFiles(files: File[], opts?: { addToComp?: boolean }): Promise<void>;
  setAnalysis(mediaId: Id, analysis: AudioAnalysis): void;
  removeMedia(id: Id): void;
  addMediaToComp(mediaId: Id, at?: number): void;
  addCompToComp(compId: Id, at?: number): void;
  // layers
  addLayer(kind: LayerKind): void;
  selectLayer(id: Id | null, mode?: SelectMode): void;
  selectAllLayers(): void;
  updateLayer(id: Id, patch: Partial<Layer>): void;
  setParent(id: Id, parentId: Id | null): void;
  deleteSelected(ripple?: boolean): void;
  duplicateSelected(): void;
  splitAtPlayhead(): void;
  moveLayers(ids: Id[], dt: number): void;
  trimLayer(id: Id, edge: Edge, t: number, ripple?: boolean): void;
  slipLayer(id: Id, dt: number): void;
  reorderLayers(ids: Id[], toIndex: number): void;
  sequenceSelected(): void;
  trimSelectedToPlayhead(edge: Edge): void;
  alignSelectedToPlayhead(edge: Edge): void;
  precomposeSelected(): void;
  extractWorkArea(): void;
  copy(): void;
  paste(): void;
  // properties & keyframes
  setProp(layerId: Id, path: PropPath, value: PropValue): void;
  toggleStopwatch(layerId: Id, path: PropPath): void;
  addKeyframe(layerId: Id, path: PropPath): void;
  jumpKeyframe(dir: -1 | 1): void;
  selectKeys(keys: KeySel[], mode?: SelectMode): void;
  moveSelectedKeys(dt: number): void;
  deleteSelectedKeys(): void;
  easeSelectedKeys(side?: EaseSide): void;
  setSelectedKeysInterpolation(interp: Interpolation): void;
  // markers & work area
  addMarker(t?: number): void;
  updateMarker(id: Id, patch: Partial<Marker>): void;
  removeMarker(id: Id): void;
  setWorkArea(start: number, end: number): void;
  // transport
  setPlayhead(t: number, opts?: { raw?: boolean }): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  stepFrames(n: number): void;
  jump(to: 'start' | 'end' | 'in' | 'out' | 'prev-edit' | 'next-edit'): void;
  // view
  setZoom(pxPerSec: number, anchorTime?: number, anchorPx?: number): void;
  setScrollTime(t: number): void;
  toggleExpanded(id: Id, value?: boolean): void;
  setReveal(reveal: EditorState['reveal']): void;
  set<K extends keyof EditorState>(key: K, value: EditorState[K]): void;
}

export type Store = EditorState & Actions;

/** Active composition (always defined). */
export function activeComp(s: EditorState): Composition {
  return s.project.compositions[s.activeCompId] ?? s.project.compositions[s.project.mainCompId];
}

export const useEditor = create<Store>()((set, get) => {
  const syncHistory = () =>
    set({
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    });

  const commit = (label: string, next: Project) => {
    const prev = get().project;
    if (next === prev) return;
    history.push(prev, label);
    set({ project: next, dirty: true });
    syncHistory();
  };

  const edit: Actions['edit'] = (label, recipe) => {
    commit(label, produce(get().project, recipe));
  };

  const editComp = (label: string, recipe: (c: Draft<Composition>, p: Draft<Project>) => void) => {
    const id = activeComp(get()).id;
    edit(label, (p) => {
      const c = p.compositions[id];
      if (c) recipe(c, p);
    });
  };

  const ctxFor = () => {
    const s = get();
    return makeEditContext(s.project, activeComp(s));
  };

  const q = (t: number) => quantize(t, activeComp(get()).fps);

  /** Replace props computed outside immer (keeps keyframe helpers pure). */
  const editProps = (label: string, changes: Array<{ layerId: Id; path: PropPath; prop: AnimProp }>) => {
    if (changes.length === 0) return;
    editComp(label, (c) => {
      for (const ch of changes) {
        const l = c.layers.find((x) => x.id === ch.layerId);
        if (l) l.props[ch.path] = ch.prop as Draft<AnimProp>;
      }
    });
  };

  const layerTime = (l: Layer) => get().playhead - l.startTime;

  const selectedKeyGroups = () => {
    const comp = activeComp(get());
    const groups = new Map<string, { layer: Layer; path: PropPath; ids: Set<Id> }>();
    for (const k of Object.values(get().selectedKeys)) {
      const layer = comp.layers.find((l) => l.id === k.layerId);
      if (!layer || !layer.props[k.path]) continue;
      const gk = k.layerId + '|' + k.path;
      if (!groups.has(gk)) groups.set(gk, { layer, path: k.path, ids: new Set() });
      groups.get(gk)!.ids.add(k.keyId);
    }
    return [...groups.values()];
  };

  const selectedOrAll = (): Id[] => {
    const s = get();
    const comp = activeComp(s);
    const sel = s.selectedLayers.filter((id) => comp.layers.some((l) => l.id === id));
    return sel;
  };

  return {
    ...initialState(createProject()),

    // ---------------------------------------------------------------- history
    undo() {
      const prev = history.undo(get().project);
      if (prev) {
        set({ project: prev, dirty: true });
        fixActiveComp();
      }
      syncHistory();
    },
    redo() {
      const next = history.redo(get().project);
      if (next) {
        set({ project: next, dirty: true });
        fixActiveComp();
      }
      syncHistory();
    },
    beginGesture(label) {
      history.begin(get().project, label);
    },
    endGesture() {
      history.end(get().project);
      syncHistory();
    },
    edit,
    editFrom(base, label, recipe) {
      const next = produce(base, recipe);
      if (history.inTransaction) set({ project: next, dirty: true });
      else commit(label, next);
    },

    // ---------------------------------------------------------------- project
    newProject() {
      mediaEngine.releaseAll();
      history.clear();
      set({ ...initialState(createProject()) });
      syncHistory();
    },
    loadProject(p) {
      history.clear();
      set({ ...initialState(p), dirty: false });
      syncHistory();
    },
    renameProject(name) {
      edit('Rename Project', (p) => {
        p.name = name;
      });
    },
    toast(message, kind = 'info') {
      const id = ++toastSeq;
      set({ toasts: [...get().toasts, { id, message, kind }].slice(-4) });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },

    // ---------------------------------------------------------------- comps
    createComp(preset = COMP_PRESETS[0], name) {
      const comp = createComposition({
        name: name ?? `Comp ${Object.keys(get().project.compositions).length + 1}`,
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
      });
      edit('New Composition', (p) => {
        p.compositions[comp.id] = comp;
        p.compOrder.push(comp.id);
      });
      set({ activeCompId: comp.id, compStack: [comp.id], playhead: 0, selectedLayers: [], selectedKeys: {} });
      return comp.id;
    },
    updateComp(patch) {
      editComp('Composition Settings', (c) => {
        if (patch.duration !== undefined && patch.duration !== c.duration) {
          const d = Math.max(1 / c.fps, patch.duration);
          if (c.workArea.end >= c.duration - 1e-6 || c.workArea.end > d) c.workArea.end = d;
          c.workArea.start = Math.min(c.workArea.start, c.workArea.end - 1 / c.fps);
        }
        Object.assign(c, patch);
        c.width = Math.round(clamp(c.width, 16, 8192));
        c.height = Math.round(clamp(c.height, 16, 8192));
        c.fps = clamp(c.fps, 1, 120);
      });
    },
    openComp(id, opts) {
      const s = get();
      if (!s.project.compositions[id]) return;
      let playhead = 0;
      let stack = [id];
      if (opts?.fromLayer) {
        const l = activeComp(s).layers.find((x) => x.id === opts.fromLayer);
        if (l) playhead = Math.max(0, s.playhead - l.startTime);
        stack = [...s.compStack, id];
      }
      set({ activeCompId: id, compStack: stack, playhead, selectedLayers: [], selectedKeys: {}, playing: false });
    },
    breadcrumb(index) {
      const s = get();
      const id = s.compStack[index];
      if (!id) return;
      set({ activeCompId: id, compStack: s.compStack.slice(0, index + 1), selectedLayers: [], selectedKeys: {} });
    },
    deleteComp(id) {
      const p = get().project;
      if (p.compOrder.length <= 1) return get().toast('A project needs at least one composition.', 'error');
      const used = Object.values(p.compositions).some((c) => c.id !== id && c.layers.some((l) => l.type === 'precomp' && l.compId === id));
      if (used) return get().toast('That composition is used as a precomp. Remove those layers first.', 'error');
      edit('Delete Composition', (d) => {
        delete d.compositions[id];
        d.compOrder = d.compOrder.filter((x) => x !== id);
        if (d.mainCompId === id) d.mainCompId = d.compOrder[0];
      });
      fixActiveComp();
    },

    // ---------------------------------------------------------------- media
    async importFiles(files, opts) {
      const added: Id[] = [];
      for (const file of files) {
        try {
          const item = await mediaEngine.probe(file);
          edit(`Import ${item.name}`, (p) => {
            p.media[item.id] = item;
            p.mediaOrder.push(item.id);
          });
          added.push(item.id);
          void idb.put('media', item.id, file).catch(() => undefined);
          void mediaEngine.attach(item, file, (id, a) => get().setAnalysis(id, a));
        } catch (err) {
          get().toast(`${file.name}: ${(err as Error).message}`, 'error');
        }
      }
      if (opts?.addToComp) for (const id of added) get().addMediaToComp(id);
      if (added.length) get().toast(`Imported ${added.length} file${added.length > 1 ? 's' : ''}`, 'success');
    },
    setAnalysis(mediaId, analysis) {
      // Analysis is derived data: patch it in without an undo step.
      const p = produce(get().project, (d) => {
        const m = d.media[mediaId];
        if (m) m.analysis = analysis;
      });
      set({ project: p, dirty: true });
      if (analysis.bpm > 0) get().toast(`Beat grid ready · ${analysis.bpm} BPM`, 'success');
    },
    removeMedia(id) {
      edit('Remove Media', (p) => {
        delete p.media[id];
        p.mediaOrder = p.mediaOrder.filter((x) => x !== id);
        for (const c of Object.values(p.compositions)) {
          const gone = c.layers.filter((l) => 'mediaId' in l && l.mediaId === id).map((l) => l.id);
          deleteLayers(c as Composition, gone);
        }
      });
    },
    addMediaToComp(mediaId, at) {
      const s = get();
      const media = s.project.media[mediaId];
      if (!media) return;
      const comp = activeComp(s);
      const t = q(at ?? s.playhead);
      const layer = createMediaLayer({ comp, media, startTime: t, inPoint: t });
      editComp(`Add ${media.name}`, (c) => {
        c.layers.unshift(layer);
        // Grow the comp to fit the first clip dropped in (short-form workflow).
        if (layer.outPoint > c.duration && c.layers.length === 1) {
          c.duration = Math.ceil(layer.outPoint * c.fps) / c.fps;
          c.workArea = { start: 0, end: c.duration };
        }
      });
      set({ selectedLayers: [layer.id], selectedKeys: {} });
    },
    addCompToComp(compId, at) {
      const s = get();
      const comp = activeComp(s);
      const target = s.project.compositions[compId];
      if (!target) return;
      if (compContains(s.project, compId, comp.id)) return get().toast('Can’t nest a composition inside itself.', 'error');
      const t = q(at ?? s.playhead);
      const layer = createPrecompLayer({ comp, target, inPoint: t });
      layer.startTime = t;
      editComp(`Add ${target.name}`, (c) => {
        c.layers.unshift(layer);
      });
      set({ selectedLayers: [layer.id] });
    },

    // ---------------------------------------------------------------- layers
    addLayer(kind) {
      const s = get();
      const comp = activeComp(s);
      const t = q(s.playhead);
      const opts = { comp, inPoint: kind === 'flash' ? t : 0 };
      let layer: Layer;
      switch (kind) {
        case 'solid':
          layer = createSolidLayer(opts);
          break;
        case 'rect':
          layer = createShapeLayer({ ...opts, shape: 'rect' });
          break;
        case 'ellipse':
          layer = createShapeLayer({ ...opts, shape: 'ellipse', fill: [0.17, 0.77, 1, 1] });
          break;
        case 'text':
          layer = createTextLayer(opts);
          break;
        case 'null':
          layer = createNullLayer(opts);
          break;
        case 'flash': {
          // White flash: solid with a 4-frame opacity spike at the playhead.
          const l = createSolidLayer({ ...opts, name: 'Flash', color: [1, 1, 1, 1], outPoint: t + 6 / comp.fps });
          l.blendMode = 'add';
          const f = 1 / comp.fps;
          l.props['transform.opacity'] = {
            value: 0,
            keyframes: [
              { id: uid('kf_'), time: 0, value: 100, inInterp: 'linear', outInterp: 'bezier', inEase: { speed: 0, influence: 1 / 3 }, outEase: { speed: 0, influence: 0.6 } },
              { id: uid('kf_'), time: 5 * f, value: 0, inInterp: 'bezier', outInterp: 'linear', inEase: { speed: 0, influence: 0.2 }, outEase: { speed: 0, influence: 1 / 3 } },
            ],
          };
          layer = l;
          break;
        }
      }
      editComp(`New ${layer.name}`, (c) => {
        c.layers.unshift(layer);
      });
      set({ selectedLayers: [layer.id], selectedKeys: {} });
    },
    selectLayer(id, mode = 'replace') {
      if (id === null) return set({ selectedLayers: [], selectedKeys: {} });
      const cur = get().selectedLayers;
      if (mode === 'replace') set({ selectedLayers: [id] });
      else if (mode === 'add') set({ selectedLayers: cur.includes(id) ? cur : [...cur, id] });
      else set({ selectedLayers: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    },
    selectAllLayers() {
      set({ selectedLayers: activeComp(get()).layers.map((l) => l.id) });
    },
    updateLayer(id, patch) {
      const name = Object.keys(patch).join(', ');
      editComp(`Change ${name}`, (c) => {
        const l = c.layers.find((x) => x.id === id);
        if (l) Object.assign(l, patch);
      });
    },
    setParent(id, parentId) {
      const comp = activeComp(get());
      if (parentId && wouldCycle(comp, id, parentId)) return get().toast('That would create a parenting loop.', 'error');
      editComp('Set Parent', (c) => {
        const l = c.layers.find((x) => x.id === id);
        if (l) l.parentId = parentId;
      });
    },
    deleteSelected(ripple = false) {
      const s = get();
      if (Object.keys(s.selectedKeys).length > 0) return get().deleteSelectedKeys();
      const ids = selectedOrAll();
      if (ids.length === 0) return;
      editComp(ripple ? 'Ripple Delete' : 'Delete Layers', (c) => {
        if (ripple) rippleDeleteLayers(c as Composition, ids);
        else deleteLayers(c as Composition, ids);
      });
      set({ selectedLayers: [], selectedKeys: {} });
    },
    duplicateSelected() {
      const ids = selectedOrAll();
      let created: Id[] = [];
      editComp('Duplicate Layers', (c) => {
        created = duplicateLayers(c as Composition, ids);
      });
      if (created.length) set({ selectedLayers: created });
    },
    splitAtPlayhead() {
      const s = get();
      const comp = activeComp(s);
      const t = q(s.playhead);
      let ids = selectedOrAll();
      // No selection: cut everything under the playhead (fast "blade all").
      if (ids.length === 0) ids = comp.layers.filter((l) => isLayerActive(l, t)).map((l) => l.id);
      let created: Id[] = [];
      editComp('Split Layers', (c) => {
        created = splitLayers(c as Composition, ids, t);
      });
      if (created.length) set({ selectedLayers: created });
    },
    moveLayers(ids, dt) {
      editComp('Move Layers', (c) => moveLayers(c as Composition, ids, dt));
    },
    trimLayer(id, edge, t, ripple) {
      const ctx = ctxFor();
      editComp(ripple ? 'Ripple Trim' : 'Trim Layer', (c) => trimLayer(c as Composition, id, edge, t, ctx, { ripple }));
    },
    slipLayer(id, dt) {
      const ctx = ctxFor();
      editComp('Slip Layer', (c) => slipLayer(c as Composition, id, dt, ctx));
    },
    reorderLayers(ids, toIndex) {
      editComp('Reorder Layers', (c) => reorderLayers(c as Composition, ids, toIndex));
    },
    sequenceSelected() {
      const comp = activeComp(get());
      const ids = selectedOrAll();
      // Bottom of the stack plays first (AE's Sequence Layers order).
      const ordered = comp.layers.filter((l) => ids.includes(l.id)).reverse().map((l) => l.id);
      editComp('Sequence Layers', (c) => sequenceLayers(c as Composition, ordered));
    },
    trimSelectedToPlayhead(edge) {
      const t = q(get().playhead);
      const ctx = ctxFor();
      const ids = selectedOrAll();
      editComp(edge === 'in' ? 'Trim In' : 'Trim Out', (c) => {
        for (const id of ids) trimLayer(c as Composition, id, edge, t, ctx);
      });
    },
    alignSelectedToPlayhead(edge) {
      const t = q(get().playhead);
      const comp = activeComp(get());
      const ids = selectedOrAll();
      editComp('Move to Playhead', (c) => {
        for (const id of ids) {
          const l = comp.layers.find((x) => x.id === id);
          if (l) moveLayers(c as Composition, [id], t - (edge === 'in' ? l.inPoint : l.outPoint));
        }
      });
    },
    precomposeSelected() {
      const s = get();
      const ids = selectedOrAll();
      if (ids.length === 0) return get().toast('Select layers to pre-compose.', 'info');
      const compId = activeComp(s).id;
      edit('Pre-compose', (p) => {
        precompose(p as Project, compId, ids);
      });
      const comp = activeComp(get());
      const pl = comp.layers.find((l) => l.type === 'precomp' && !s.project.compositions[compId].layers.some((x) => x.id === l.id));
      set({ selectedLayers: pl ? [pl.id] : [] });
    },
    extractWorkArea() {
      const comp = activeComp(get());
      const { start, end } = comp.workArea;
      if (end - start <= 0 || (start <= 0 && end >= comp.duration)) {
        return get().toast('Set a work area (B / N) first, then extract it.', 'info');
      }
      editComp('Extract Work Area', (c) => {
        extractRange(c as Composition, start, end);
        c.workArea = { start: 0, end: c.duration };
      });
    },
    copy() {
      const s = get();
      const comp = activeComp(s);
      const ids = new Set(selectedOrAll());
      const layers = comp.layers.filter((l) => ids.has(l.id));
      if (layers.length) {
        clipboard = { layers: layers.map((l) => deepClone(l)), fromComp: comp.id };
        get().toast(`Copied ${layers.length} layer${layers.length > 1 ? 's' : ''}`);
      }
    },
    paste() {
      if (!clipboard) return;
      const s = get();
      const comp = activeComp(s);
      const t = q(s.playhead);
      const minIn = Math.min(...clipboard.layers.map((l) => l.inPoint));
      const copies = clipboard.layers.map((l) => cloneLayer(l));
      const idMap = new Map(clipboard.layers.map((l, i) => [l.id, copies[i].id]));
      for (const c of copies) {
        const dt = t - minIn;
        c.inPoint += dt;
        c.outPoint += dt;
        c.startTime += dt;
        c.parentId = c.parentId ? (idMap.get(c.parentId) ?? null) : null;
      }
      const bad = copies.find((c) => c.type === 'precomp' && compContains(s.project, c.compId, comp.id));
      if (bad) return get().toast('Can’t paste a composition into itself.', 'error');
      editComp('Paste Layers', (c) => {
        c.layers.unshift(...copies);
      });
      set({ selectedLayers: copies.map((c) => c.id) });
    },

    // ---------------------------------------------------------------- props & keys
    setProp(layerId, path, value) {
      const comp = activeComp(get());
      const l = comp.layers.find((x) => x.id === layerId);
      const prop = l?.props[path];
      if (!l || !prop) return;
      const lt = q(layerTime(l) + l.startTime) - l.startTime;
      const def = getPropDef(path);
      editProps(`Change ${def?.label ?? path}`, [{ layerId, path, prop: setValueAt(prop, lt, value, 0.5 / comp.fps) }]);
    },
    toggleStopwatch(layerId, path) {
      const comp = activeComp(get());
      const l = comp.layers.find((x) => x.id === layerId);
      const prop = l?.props[path];
      if (!l || !prop) return;
      const lt = q(get().playhead) - l.startTime;
      editProps(prop.keyframes.length ? 'Remove Animation' : 'Animate Property', [{ layerId, path, prop: toggleAnimation(prop, lt) }]);
      set({ expanded: { ...get().expanded, [layerId]: true } });
    },
    addKeyframe(layerId, path) {
      const comp = activeComp(get());
      const l = comp.layers.find((x) => x.id === layerId);
      const prop = l?.props[path];
      if (!l || !prop) return;
      const lt = q(get().playhead) - l.startTime;
      editProps('Add Keyframe', [{ layerId, path, prop: addKeyframeAt(prop, lt, 0.5 / comp.fps) }]);
    },
    jumpKeyframe(dir) {
      const s = get();
      const comp = activeComp(s);
      const layers = s.selectedLayers.length ? comp.layers.filter((l) => s.selectedLayers.includes(l.id)) : comp.layers;
      let best: number | null = null;
      for (const l of layers) {
        for (const p of Object.values(l.props)) {
          const lt = s.playhead - l.startTime;
          const k = dir < 0 ? prevKeyframeTime(p, lt) : nextKeyframeTime(p, lt);
          if (k === null) continue;
          const t = k + l.startTime;
          if (best === null || (dir < 0 ? t > best : t < best)) best = t;
        }
      }
      if (best !== null) get().setPlayhead(best);
    },
    selectKeys(keys, mode = 'replace') {
      const cur = mode === 'replace' ? {} : { ...get().selectedKeys };
      for (const k of keys) {
        const id = keySelId(k);
        if (mode === 'toggle' && cur[id]) delete cur[id];
        else cur[id] = k;
      }
      set({ selectedKeys: cur });
    },
    moveSelectedKeys(dt) {
      const fps = activeComp(get()).fps;
      const changes = selectedKeyGroups().map((g) => ({
        layerId: g.layer.id,
        path: g.path,
        prop: moveKeyframes(g.layer.props[g.path], g.ids, dt, (t) => quantize(t + g.layer.startTime, fps) - g.layer.startTime),
      }));
      editProps('Move Keyframes', changes);
    },
    deleteSelectedKeys() {
      const changes = selectedKeyGroups().map((g) => ({
        layerId: g.layer.id,
        path: g.path,
        prop: removeKeyframes(g.layer.props[g.path], g.ids, layerTime(g.layer)),
      }));
      editProps('Delete Keyframes', changes);
      set({ selectedKeys: {} });
    },
    easeSelectedKeys(side = 'both') {
      const changes = selectedKeyGroups().map((g) => ({ layerId: g.layer.id, path: g.path, prop: easyEase(g.layer.props[g.path], g.ids, side) }));
      editProps(side === 'both' ? 'Easy Ease' : side === 'in' ? 'Easy Ease In' : 'Easy Ease Out', changes);
    },
    setSelectedKeysInterpolation(interp) {
      const changes = selectedKeyGroups().map((g) => ({
        layerId: g.layer.id,
        path: g.path,
        prop: setInterpolation(g.layer.props[g.path], g.ids, interp),
      }));
      editProps(`Keyframes → ${interp}`, changes);
    },

    // ---------------------------------------------------------------- markers
    addMarker(t) {
      const time = q(t ?? get().playhead);
      const comp = activeComp(get());
      if (comp.markers.some((m) => Math.abs(m.time - time) < 0.5 / comp.fps)) return;
      editComp('Add Marker', (c) => {
        c.markers.push({ id: uid('mk_'), time, duration: 0, label: '', color: 0 });
        c.markers.sort((a, b) => a.time - b.time);
      });
    },
    updateMarker(id, patch) {
      editComp('Edit Marker', (c) => {
        const m = c.markers.find((x) => x.id === id);
        if (m) Object.assign(m, patch);
        c.markers.sort((a, b) => a.time - b.time);
      });
    },
    removeMarker(id) {
      editComp('Delete Marker', (c) => {
        c.markers = c.markers.filter((m) => m.id !== id);
      });
    },
    setWorkArea(start, end) {
      const comp = activeComp(get());
      const f = 1 / comp.fps;
      const a = clamp(q(Math.min(start, end)), 0, comp.duration - f);
      const b = clamp(q(Math.max(start, end)), a + f, comp.duration);
      editComp('Work Area', (c) => {
        c.workArea = { start: a, end: b };
      });
    },

    // ---------------------------------------------------------------- transport
    setPlayhead(t, opts) {
      const comp = activeComp(get());
      const v = clamp(t, 0, comp.duration);
      set({ playhead: opts?.raw ? v : clamp(quantize(v, comp.fps), 0, comp.duration) });
    },
    play() {
      set({ playing: true });
    },
    pause() {
      set({ playing: false });
      get().setPlayhead(get().playhead);
    },
    togglePlay() {
      if (get().playing) get().pause();
      else get().play();
    },
    stepFrames(n) {
      const comp = activeComp(get());
      if (get().playing) get().pause();
      get().setPlayhead(get().playhead + n / comp.fps);
    },
    jump(to) {
      const s = get();
      const comp = activeComp(s);
      const t = s.playhead;
      switch (to) {
        case 'start':
          return get().setPlayhead(0);
        case 'end':
          return get().setPlayhead(comp.duration - 1 / comp.fps);
        case 'in':
          return get().setPlayhead(comp.workArea.start);
        case 'out':
          return get().setPlayhead(comp.workArea.end - 1 / comp.fps);
        case 'prev-edit':
        case 'next-edit': {
          const edges = comp.layers.flatMap((l) => [l.inPoint, l.outPoint]).concat(comp.markers.map((m) => m.time));
          const eps = 0.5 / comp.fps;
          const cand = to === 'prev-edit' ? edges.filter((e) => e < t - eps).sort((a, b) => b - a)[0] : edges.filter((e) => e > t + eps).sort((a, b) => a - b)[0];
          if (cand !== undefined) get().setPlayhead(cand);
        }
      }
    },

    // ---------------------------------------------------------------- view
    setZoom(pxPerSec, anchorTime, anchorPx) {
      const z = clamp(pxPerSec, 4, 6000);
      if (anchorTime !== undefined && anchorPx !== undefined) {
        set({ pxPerSec: z, scrollTime: Math.max(-12 / z, anchorTime - anchorPx / z) });
      } else set({ pxPerSec: z });
    },
    setScrollTime(t) {
      // A small negative scroll leaves a gutter so keyframes at 0 aren't clipped.
      set({ scrollTime: Math.max(-12 / get().pxPerSec, t) });
    },
    toggleExpanded(id, value) {
      const cur = get().expanded;
      set({ expanded: { ...cur, [id]: value ?? !cur[id] } });
    },
    setReveal(reveal) {
      set({ reveal });
    },
    set(key, value) {
      set({ [key]: value } as Partial<Store>);
    },
  };

  /** Drop selected layers/keys that no longer exist (after undo, deletes...). */
  function pruneSelection() {
    const s = get();
    const comp = s.project.compositions[s.activeCompId];
    if (!comp) return set({ selectedLayers: [], selectedKeys: {} });
    const ids = new Set(comp.layers.map((l) => l.id));
    const layers = s.selectedLayers.filter((id) => ids.has(id));
    const keys: Record<string, KeySel> = {};
    for (const [k, v] of Object.entries(s.selectedKeys)) {
      const l = comp.layers.find((x) => x.id === v.layerId);
      if (l?.props[v.path]?.keyframes.some((kf) => kf.id === v.keyId)) keys[k] = v;
    }
    if (layers.length !== s.selectedLayers.length || Object.keys(keys).length !== Object.keys(s.selectedKeys).length) {
      set({ selectedLayers: layers, selectedKeys: keys });
    }
  }

  function fixActiveComp() {
    pruneSelection();
    const s = get();
    if (!s.project.compositions[s.activeCompId]) {
      set({ activeCompId: s.project.mainCompId, compStack: [s.project.mainCompId] });
    } else {
      const stack = s.compStack.filter((id) => s.project.compositions[id]);
      if (stack.length !== s.compStack.length) set({ compStack: stack.length ? stack : [s.activeCompId] });
    }
  }
});

mediaEngine.subscribe(() => useEditor.setState({ mediaVersion: mediaEngine.version }));

/** Convenience non-hook accessor for engine code. */
export const editor = () => useEditor.getState();
