import type { Id, Project } from '../../core/model/types';
import { OfflineRenderer } from '../export/OfflineRenderer';
import type { MediaEngine } from '../media/MediaEngine';
import { frameCache } from './FrameCache';

/** Render the work area into the RAM preview cache. Returns frames cached. */
export async function cacheWorkArea(
  project: Project,
  compId: Id,
  scale: number,
  media: MediaEngine,
  onProgress: (p: number) => void,
  signal: AbortSignal,
  flowEngine: 'farneback' | 'rife' = 'farneback',
): Promise<number> {
  const comp = project.compositions[compId];
  if (!comp) return 0;
  frameCache.validate(project, compId, scale, comp.fps);
  const a = Math.round(comp.workArea.start * comp.fps);
  const b = Math.round(comp.workArea.end * comp.fps);
  const off = await OfflineRenderer.create(project, compId, media, scale, flowEngine);
  let n = 0;
  try {
    for (let f = a; f < b; f++) {
      if (signal.aborted) break;
      if (frameCache.has(f)) continue;
      await off.render(f / comp.fps);
      const bmp = await createImageBitmap(off.canvas);
      if (!frameCache.put(f, bmp)) break;
      n++;
      onProgress((f - a + 1) / (b - a));
    }
  } finally {
    off.dispose();
  }
  return n;
}
