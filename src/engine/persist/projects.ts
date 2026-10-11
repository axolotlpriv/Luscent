/**
 * Projects stored in this browser (IndexedDB): the home page's "recent" list.
 * One record per project, keyed by project id; media blobs live in the `media`
 * store keyed by media id and are shared by every record that references them.
 */
import type { Project } from '../../core/model/types';
import { idb } from './db';

export interface ProjectRecord {
  id: string;
  name: string;
  /** ms since epoch */
  modified: number;
  /** JPEG data URL, small. */
  thumb?: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  layers: number;
  project: Project;
}

const prefix = 'p:';
const LEGACY_KEY = 'autosave';

function summarize(project: Project, thumb?: string, modified = Date.now()): ProjectRecord {
  const comp = project.compositions[project.mainCompId] ?? Object.values(project.compositions)[0];
  return {
    id: project.id,
    name: project.name,
    modified,
    thumb,
    width: comp?.width ?? 0,
    height: comp?.height ?? 0,
    fps: comp?.fps ?? 30,
    duration: comp?.duration ?? 0,
    layers: Object.values(project.compositions).reduce((n, c) => n + c.layers.length, 0),
    project,
  };
}

/** Move the single-slot autosave from earlier versions into the project list. */
async function migrateLegacy(): Promise<void> {
  const legacy = await idb.get<Project>('projects', LEGACY_KEY).catch(() => undefined);
  if (!legacy) return;
  if (legacy.compositions) {
    if (!legacy.id) legacy.id = `proj_${Math.random().toString(36).slice(2, 10)}`;
    await idb.put('projects', prefix + legacy.id, summarize(legacy));
  }
  await idb.del('projects', LEGACY_KEY);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  try {
    await migrateLegacy();
    const all = await idb.all<ProjectRecord | Project>('projects');
    return all.filter((r): r is ProjectRecord => !!r && 'project' in r && !!r.project?.compositions).sort((a, b) => b.modified - a.modified);
  } catch (err) {
    console.warn('Could not list projects', err);
    return [];
  }
}

export async function getProjectRecord(id: string): Promise<ProjectRecord | undefined> {
  return idb.get<ProjectRecord>('projects', prefix + id).catch(() => undefined);
}

export async function saveProjectRecord(project: Project, thumb?: string): Promise<void> {
  // Keep the previous thumbnail until a new one is ready.
  const prev = thumb === undefined ? await getProjectRecord(project.id) : undefined;
  await idb.put('projects', prefix + project.id, summarize(project, thumb ?? prev?.thumb));
}

export async function deleteProjectRecord(id: string): Promise<void> {
  await idb.del('projects', prefix + id);
}

/** Delete stored media that no saved project (and not the open one) references. */
export async function collectMediaGarbage(open?: Project): Promise<void> {
  const keep = new Set<string>(open?.mediaOrder ?? []);
  for (const r of await listProjects()) for (const id of r.project.mediaOrder) keep.add(id);
  const keys = await idb.keys('media').catch(() => [] as IDBValidKey[]);
  await Promise.all(keys.filter((k) => !keep.has(String(k))).map((k) => idb.del('media', String(k))));
}

/** "2 min ago", "Yesterday", "12 Mar". */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'Yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}
