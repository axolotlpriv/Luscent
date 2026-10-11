/** Offline stereo mixdown of a composition's audio (sample-accurate). */
import { collectAudioClips } from '../../core/render/audioClips';
import type { Id, Project } from '../../core/model/types';
import { dbToGain } from '../media/audioContext';
import type { MediaEngine } from '../media/MediaEngine';

export async function mixdown(project: Project, compId: Id, start: number, end: number, media: MediaEngine, sampleRate = 48000): Promise<AudioBuffer | null> {
  const dur = Math.max(0, end - start);
  if (dur <= 0) return null;
  const clips = collectAudioClips(project, compId, 0, [start, end]);
  if (clips.length === 0) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
  let any = false;
  for (const clip of clips) {
    const buf = media.audioBuffer(clip.mediaId);
    if (!buf) continue;
    let from = Math.max(clip.from, start);
    let srcOffset = from - clip.start;
    if (srcOffset < 0) {
      from -= srcOffset;
      srcOffset = 0;
    }
    const len = Math.min(clip.to - from, buf.duration - srcOffset);
    if (len <= 0) continue;
    const when = from - start;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    if (clip.animated) {
      const steps = Math.max(2, Math.ceil(len * 120));
      const curve = new Float32Array(steps);
      for (let i = 0; i < steps; i++) curve[i] = dbToGain(clip.volumeAt(from + (i / (steps - 1)) * len));
      g.gain.setValueCurveAtTime(curve, when, len);
    } else g.gain.value = dbToGain(clip.volumeAt(from));
    src.connect(g).connect(ctx.destination);
    src.start(when, srcOffset, len);
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}
