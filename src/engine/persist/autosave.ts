import type { Project } from '../../core/model/types';
import { editor, useEditor } from '../../state/store';
import { mediaEngine } from '../media/MediaEngine';
import { idb } from './db';

const KEY = 'autosave';

/** Restore the last session (project + media blobs) from IndexedDB. */
export async function restoreSession(): Promise<boolean> {
  try {
    const saved = await idb.get<Project>('projects', KEY);
    if (!saved || !saved.compositions) return false;
    editor().loadProject(saved);
    // Decode in the background; the UI shows per-item loading state.
    void attachAllMedia(saved);
    return true;
  } catch (err) {
    console.warn('Could not restore session', err);
    return false;
  }
}

/** Load runtime resources for every media item that has a stored blob. */
export async function attachAllMedia(project: Project): Promise<void> {
  for (const id of project.mediaOrder) mediaEngine.markPending(id);
  await Promise.all(
    project.mediaOrder.map(async (id) => {
      const item = project.media[id];
      if (!item) return;
      const blob = await idb.get<Blob>('media', id).catch(() => undefined);
      if (blob) await mediaEngine.attach(item, blob, (mid, a) => editor().setAnalysis(mid, a));
      else mediaEngine.markMissing(id);
    }),
  );
}

let timer: ReturnType<typeof setTimeout> | undefined;

export function installAutosave(): void {
  useEditor.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = editor().project;
      idb.put('projects', KEY, p).catch((err) => console.warn('Autosave failed', err));
      // Drop blobs for media no longer in the project.
      idb
        .keys('media')
        .then((keys) => Promise.all(keys.filter((k) => !p.media[String(k)]).map((k) => idb.del('media', String(k)))))
        .catch(() => undefined);
    }, 600);
  });
}
