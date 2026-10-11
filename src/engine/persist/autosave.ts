import type { Project } from '../../core/model/types';
import { editor, useEditor } from '../../state/store';
import { mediaEngine } from '../media/MediaEngine';
import { idb } from './db';
import { collectMediaGarbage, saveProjectRecord } from './projects';
import { renderThumbnail } from './thumbnail';

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
/** The project as it was when opened or created: nothing to save until it changes. */
let baseline: Project | null = null;
let lastThumb = 0;
const THUMB_EVERY_MS = 20_000;

export function setAutosaveBaseline(p: Project | null): void {
  baseline = p;
  clearTimeout(timer);
}

/** Write the open project (and a fresh thumbnail when `thumb`) to the browser's project list. */
export async function flushAutosave(opts: { thumb?: boolean } = {}): Promise<void> {
  clearTimeout(timer);
  const s = editor();
  const p = s.project;
  if (p === baseline) return;
  try {
    let thumb: string | undefined;
    if (opts.thumb || Date.now() - lastThumb > THUMB_EVERY_MS) {
      lastThumb = Date.now();
      thumb = (await renderThumbnail(p, s.playhead)) ?? undefined;
    }
    await saveProjectRecord(p, thumb);
    await collectMediaGarbage(p);
  } catch (err) {
    console.warn('Autosave failed', err);
  }
}

export function installAutosave(): void {
  useEditor.subscribe((s, prev) => {
    if (s.project === prev.project || s.project === baseline) return;
    clearTimeout(timer);
    timer = setTimeout(() => void flushAutosave(), 800);
  });
  // Last chance when the tab is hidden or closed (no thumbnail: it's async).
  window.addEventListener('pagehide', () => {
    const p = editor().project;
    if (p !== baseline) void saveProjectRecord(p);
  });
}
