import { evaluateProp } from '../animation/interpolate';
import type { Id, Layer, Project } from '../model/types';

/** An audible span of media, flattened through precomps into top-level comp time. */
export interface AudioClip {
  key: string;
  mediaId: Id;
  /** Top-level comp time at which source time 0 plays. */
  start: number;
  /** Audible window in top-level comp time. */
  from: number;
  to: number;
  /** Volume in dB at a top-level comp time. */
  volumeAt: (t: number) => number;
  /** True if volume is keyframed (anywhere in the chain). */
  animated: boolean;
}

export function collectAudioClips(
  project: Project,
  compId: Id,
  offset = 0,
  window: [number, number] = [-Infinity, Infinity],
  prefix = '',
  depth = 0,
): AudioClip[] {
  const comp = project.compositions[compId];
  if (!comp || depth > 16) return [];
  const anySolo = comp.layers.some((l) => l.solo);
  const out: AudioClip[] = [];
  const audibleLayer = (l: Layer) => l.audible && (!anySolo || l.solo);
  for (const l of comp.layers) {
    if (!audibleLayer(l)) continue;
    const from = Math.max(window[0], offset + l.inPoint);
    const to = Math.min(window[1], offset + l.outPoint);
    if (to <= from) continue;
    if (l.type === 'audio' || l.type === 'video') {
      const m = project.media[l.mediaId];
      if (!m?.hasAudio) continue;
      const vol = l.props['audio.volume'];
      const start = offset + l.startTime;
      out.push({
        key: prefix + l.id,
        mediaId: l.mediaId,
        start,
        from,
        to,
        animated: !!vol && vol.keyframes.length > 0,
        volumeAt: (t) => (vol ? (evaluateProp(vol, t - start) as number) : 0),
      });
    } else if (l.type === 'precomp') {
      out.push(...collectAudioClips(project, l.compId, offset + l.startTime, [from, to], `${prefix}${l.id}/`, depth + 1));
    }
  }
  return out;
}
