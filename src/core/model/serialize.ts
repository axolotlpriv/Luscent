import type { Project } from './types';

/**
 * Project file format: `{ format: "luscent-project", version, project }`.
 * JSON can't encode Infinity (used for still-image durations), so non-finite
 * numbers are tagged and restored on load.
 */
export const PROJECT_FORMAT = 'luscent-project';
export const PROJECT_VERSION = 1;

interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  project: Project;
}

export function serializeProject(project: Project): string {
  const file: ProjectFile = { format: PROJECT_FORMAT, version: PROJECT_VERSION, savedAt: new Date().toISOString(), project };
  return JSON.stringify(file, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? { $num: String(v) } : v), 2);
}

export function deserializeProject(text: string): Project {
  const parsed = JSON.parse(text, (_k, v) => (v && typeof v === 'object' && '$num' in v ? Number(v.$num) : v)) as ProjectFile;
  if (!parsed || parsed.format !== PROJECT_FORMAT) throw new Error('Not a Luscent project file.');
  if (parsed.version > PROJECT_VERSION) throw new Error('This project was saved by a newer version of Luscent.');
  return migrate(parsed.project, parsed.version);
}

function migrate(project: Project, _version: number): Project {
  // v1 is the first format; future migrations hook in here.
  const p = project;
  if (!p.compOrder) p.compOrder = Object.keys(p.compositions);
  if (!p.mediaOrder) p.mediaOrder = Object.keys(p.media);
  if (!p.compositions[p.mainCompId]) p.mainCompId = p.compOrder[0];
  return p;
}
