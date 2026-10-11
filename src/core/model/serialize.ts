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

/** JSON.stringify replacer / JSON.parse reviver that round-trip Infinity and NaN. */
export const jsonReplacer = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? { $num: String(v) } : v);
export const jsonReviver = (_k: string, v: unknown) => (v && typeof v === 'object' && '$num' in v ? Number((v as { $num: string }).$num) : v);

export function serializeProject(project: Project): string {
  const file: ProjectFile = { format: PROJECT_FORMAT, version: PROJECT_VERSION, savedAt: new Date().toISOString(), project };
  return JSON.stringify(file, jsonReplacer, 2);
}

export function deserializeProject(text: string): Project {
  const parsed = JSON.parse(text, jsonReviver) as ProjectFile;
  if (!parsed || parsed.format !== PROJECT_FORMAT) throw new Error('Not a Luscent project file.');
  return checkAndMigrate(parsed);
}

/** Validate a parsed project file and bring it up to the current version. */
export function checkAndMigrate(parsed: { format?: string; version?: number; project?: Project }): Project {
  if (!parsed || parsed.format !== PROJECT_FORMAT || !parsed.project?.compositions) throw new Error('Not a Luscent project file.');
  if ((parsed.version ?? 1) > PROJECT_VERSION) throw new Error('This project was saved by a newer version of Luscent.');
  return migrate(parsed.project, parsed.version ?? 1);
}

function migrate(project: Project, _version: number): Project {
  // v1 is the first format; future migrations hook in here.
  const p = project;
  if (!p.id) p.id = `proj_${Math.random().toString(36).slice(2, 10)}`;
  if (!p.compOrder) p.compOrder = Object.keys(p.compositions);
  if (!p.mediaOrder) p.mediaOrder = Object.keys(p.media);
  if (!p.compositions[p.mainCompId]) p.mainCompId = p.compOrder[0];
  return p;
}
