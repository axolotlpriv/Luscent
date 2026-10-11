import type { Project } from '../../core/model/types';
import { OfflineRenderer } from '../export/OfflineRenderer';
import { mediaEngine } from '../media/MediaEngine';

const LONG_SIDE = 360;

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** Render a small JPEG of the project's main composition at time `t`. */
export async function renderThumbnail(project: Project, t: number): Promise<string | null> {
  const comp = project.compositions[project.mainCompId];
  if (!comp || comp.layers.length === 0) return null;
  let r: OfflineRenderer | null = null;
  try {
    const scale = LONG_SIDE / Math.max(comp.width, comp.height);
    r = await OfflineRenderer.create(project, comp.id, mediaEngine, scale);
    const canvas = await r.render(Math.min(Math.max(0, t), Math.max(0, comp.duration - 1 / comp.fps)));
    // Flatten onto the comp background so transparent areas don't turn black in JPEG.
    const out = new OffscreenCanvas(canvas.width, canvas.height);
    const ctx = out.getContext('2d')!;
    const bg = comp.background;
    ctx.fillStyle = `rgb(${Math.round(bg[0] * 255)},${Math.round(bg[1] * 255)},${Math.round(bg[2] * 255)})`;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return await blobToDataUrl(await out.convertToBlob({ type: 'image/jpeg', quality: 0.72 }));
  } catch (err) {
    console.warn('Thumbnail failed', err);
    return null;
  } finally {
    r?.dispose();
  }
}
