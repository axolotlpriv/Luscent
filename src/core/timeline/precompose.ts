import { createComposition, createPrecompLayer } from '../model/factory';
import type { Composition, Id, Project } from '../model/types';

/**
 * Move layers into a new composition and replace them with a single precomp
 * layer. Timing is preserved (the precomp layer starts at 0 so nested times
 * line up with the parent). Mutates `project`; returns the new comp id.
 */
export function precompose(project: Project, compId: Id, layerIds: Id[], name?: string): Id | null {
  const comp = project.compositions[compId];
  if (!comp) return null;
  const set = new Set(layerIds);
  const moving = comp.layers.filter((l) => set.has(l.id));
  if (moving.length === 0) return null;
  const topIndex = comp.layers.findIndex((l) => set.has(l.id));

  const nested = createComposition({
    name: name ?? `${moving[0].name} Comp`,
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
    duration: comp.duration,
    background: [0, 0, 0, 0],
  });
  nested.layers = moving.map((l) => ({ ...l, parentId: l.parentId && set.has(l.parentId) ? l.parentId : null }));
  project.compositions[nested.id] = nested;
  project.compOrder.push(nested.id);

  const inPoint = Math.min(...moving.map((l) => l.inPoint));
  const outPoint = Math.max(...moving.map((l) => l.outPoint));
  const pl = createPrecompLayer({ comp, target: nested, inPoint, outPoint });
  pl.startTime = 0;
  pl.name = nested.name;

  comp.layers = comp.layers.filter((l) => !set.has(l.id));
  for (const l of comp.layers) if (l.parentId && set.has(l.parentId)) l.parentId = null;
  comp.layers.splice(Math.min(topIndex, comp.layers.length), 0, pl);
  return nested.id;
}

/** True when `childCompId` (transitively) contains `ancestorCompId`. */
export function compContains(project: Project, childCompId: Id, ancestorCompId: Id): boolean {
  if (childCompId === ancestorCompId) return true;
  const seen = new Set<Id>();
  const stack = [childCompId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === ancestorCompId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const c: Composition | undefined = project.compositions[id];
    if (!c) continue;
    for (const l of c.layers) if (l.type === 'precomp') stack.push(l.compId);
  }
  return false;
}
