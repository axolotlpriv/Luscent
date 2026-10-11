/**
 * Project lifecycle: create, open (recent list or .lsp file), save to a file,
 * and returning to the home page. Glue between the store, persistence and the
 * media engine.
 */
import { COMP_PRESETS, type CompPreset } from '../core/model/factory';
import { decodeLsp, encodeLsp, lspFileName } from '../core/model/lsp';
import type { Project } from '../core/model/types';
import { attachAllMedia, flushAutosave, setAutosaveBaseline } from '../engine/persist/autosave';
import { idb } from '../engine/persist/db';
import { deleteProjectRecord, collectMediaGarbage, getProjectRecord, saveProjectRecord } from '../engine/persist/projects';
import { saveFile } from '../engine/platform/files';
import { useApp } from './app';
import { editor } from './store';

const preset = (id: string): CompPreset => COMP_PRESETS.find((p) => p.id === id) ?? COMP_PRESETS[0];

function show(): void {
  useApp.getState().setScreen('editor');
}

/** A new, empty project. */
export function createNewProject(presetId = COMP_PRESETS[0].id, name = 'Untitled Project'): void {
  const s = editor();
  s.newProject();
  s.renameProject(name);
  const pr = preset(presetId);
  s.updateComp({ width: pr.width, height: pr.height, fps: pr.fps });
  // Setup edits shouldn't be undoable or count as unsaved work.
  s.loadProject(editor().project);
  setAutosaveBaseline(editor().project);
  show();
}

/** New project from dropped/picked media, with a composition shaped like the first video or image. */
export async function createProjectFromMedia(files: File[]): Promise<void> {
  const first = files.find((f) => /^(video|image)\//.test(f.type));
  let presetId = COMP_PRESETS[0].id;
  if (first && first.type.startsWith('video/')) {
    presetId = await new Promise<string>((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        const r = v.videoWidth / Math.max(1, v.videoHeight);
        URL.revokeObjectURL(v.src);
        resolve(r > 1.2 ? 'landscape-1080-30' : r < 0.9 ? 'vertical-1080-30' : 'square-1080-30');
      };
      v.onerror = () => resolve(COMP_PRESETS[0].id);
      v.src = URL.createObjectURL(first);
    });
  }
  createNewProject(presetId, first ? first.name.replace(/\.[^.]+$/, '') : 'Untitled Project');
  await editor().importFiles(files, { addToComp: true });
}

async function openProject(project: Project, media?: Map<string, Blob>): Promise<void> {
  const s = editor();
  s.newProject(); // releases the previous project's media
  if (media) await Promise.all([...media].map(([id, blob]) => idb.put('media', id, blob)));
  s.loadProject(project);
  setAutosaveBaseline(editor().project);
  show();
  void attachAllMedia(project);
}

/** Open a project from the browser's recent list. */
export async function openRecentProject(id: string): Promise<void> {
  const rec = await getProjectRecord(id);
  if (!rec) {
    editor().toast('That project is no longer stored in this browser.', 'error');
    return;
  }
  await openProject(rec.project);
}

/** Open a `.lsp` file (or legacy `.luscent.json`). */
export async function openProjectFile(file: Blob & { name?: string }): Promise<void> {
  try {
    const { project, media } = await decodeLsp(file);
    await openProject(project, media);
    // Opening a file adds it to the recent list straight away.
    await saveProjectRecord(editor().project);
    const missing = project.mediaOrder.filter((id) => !media.has(id) && editor().project.media[id]);
    editor().toast(
      media.size || !missing.length ? `Opened ${project.name}` : `Opened ${project.name}. Its media wasn't saved in the file; relink it from the Project panel.`,
      'success',
    );
  } catch (err) {
    editor().toast((err as Error).message, 'error');
  }
}

/** Save the open project as a `.lsp` file, with its media embedded unless told otherwise. */
export async function saveProjectToFile(opts: { embedMedia?: boolean } = {}): Promise<void> {
  const { embedMedia = true } = opts;
  const s = editor();
  const p = s.project;
  const media: Array<{ id: string; blob: Blob }> = [];
  if (embedMedia) {
    for (const id of p.mediaOrder) {
      const blob = await idb.get<Blob>('media', id).catch(() => undefined);
      if (blob) media.push({ id, blob });
    }
  }
  const file = encodeLsp(p, media);
  const where = await saveFile(lspFileName(p.name), file);
  s.set('dirty', false);
  const mb = (file.size / 1e6).toFixed(file.size > 1e7 ? 0 : 1);
  s.toast(`Saved ${lspFileName(p.name)} (${mb} MB${embedMedia ? ', media included' : ', without media'}) → ${where}`, 'success');
}

/** Export a stored project from the home page. */
export async function downloadRecentProject(id: string): Promise<void> {
  const rec = await getProjectRecord(id);
  if (!rec) return;
  const media: Array<{ id: string; blob: Blob }> = [];
  for (const mid of rec.project.mediaOrder) {
    const blob = await idb.get<Blob>('media', mid).catch(() => undefined);
    if (blob) media.push({ id: mid, blob });
  }
  await saveFile(lspFileName(rec.project.name), encodeLsp(rec.project, media));
}

export async function deleteRecentProject(id: string): Promise<void> {
  await deleteProjectRecord(id);
  await collectMediaGarbage();
}

/** Save and return to the home page. */
export async function goHome(): Promise<void> {
  editor().pause();
  await flushAutosave({ thumb: true });
  useApp.getState().setScreen('home');
}
