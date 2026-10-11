/**
 * WebAudio playback. Clips are scheduled sample-accurately against the
 * AudioContext clock, which also serves as the master transport clock so
 * picture follows sound (the right priority for beat-synced edits).
 */
import { collectAudioClips } from '../../core/render/audioClips';
import type { Id, Project } from '../../core/model/types';
import { dbToGain, getAudioContext } from '../media/audioContext';
import type { MediaEngine } from '../media/MediaEngine';

const LOOKAHEAD = 0.05;

export class AudioEngine {
  private sources: AudioScheduledSourceNode[] = [];
  private master: GainNode | null = null;
  private meter: AnalyserNode | null = null;
  /** ctx.currentTime that corresponds to comp time `compAnchor`. */
  private ctxAnchor = 0;
  private compAnchor = 0;
  private rate = 1;
  private running = false;

  constructor(private readonly media: MediaEngine) {}

  private out(): GainNode {
    const ctx = getAudioContext();
    if (!this.master) {
      this.master = ctx.createGain();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      this.master.connect(an);
      an.connect(ctx.destination);
      this.meter = an;
    }
    return this.master;
  }

  /** Post-mix analyser for level meters (null until audio first plays). */
  get analyser(): AnalyserNode | null {
    return this.meter;
  }

  /** Current transport time in comp seconds. */
  now(): number {
    if (!this.running) return this.compAnchor;
    const ctx = getAudioContext();
    return this.compAnchor + Math.max(0, ctx.currentTime - this.ctxAnchor) * this.rate;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start playback of `compId` at comp time t (optionally until `until`). */
  start(project: Project, compId: Id, t: number, until = Infinity): void {
    this.stopSources();
    const ctx = getAudioContext();
    const out = this.out();
    const when0 = ctx.currentTime + LOOKAHEAD;
    this.ctxAnchor = when0;
    this.compAnchor = t;
    this.rate = 1;
    this.running = true;
    for (const clip of collectAudioClips(project, compId, 0, [t, until])) {
      const buf = this.media.audioBuffer(clip.mediaId);
      if (!buf) continue;
      let from = Math.max(clip.from, t);
      let srcOffset = from - clip.start;
      if (srcOffset < 0) {
        from -= srcOffset;
        srcOffset = 0;
      }
      const dur = Math.min(clip.to - from, buf.duration - srcOffset);
      if (dur <= 0) continue;
      const when = when0 + (from - t);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      if (clip.animated) {
        const steps = Math.max(2, Math.ceil(dur * 60));
        const curve = new Float32Array(steps);
        for (let i = 0; i < steps; i++) curve[i] = dbToGain(clip.volumeAt(from + (i / (steps - 1)) * dur));
        gain.gain.setValueCurveAtTime(curve, when, dur);
      } else {
        gain.gain.value = dbToGain(clip.volumeAt(from));
      }
      src.connect(gain).connect(out);
      src.start(when, srcOffset, dur);
      this.sources.push(src);
    }
  }

  stop(): number {
    const t = this.now();
    this.stopSources();
    this.running = false;
    this.compAnchor = t;
    return t;
  }

  /** Short audio blip at t, for scrubbing feedback. */
  scrub(project: Project, compId: Id, t: number, length = 0.08): void {
    if (this.running) return;
    const ctx = getAudioContext();
    if (ctx.state !== 'running') return;
    const out = this.out();
    for (const clip of collectAudioClips(project, compId, 0, [t, t + length])) {
      const buf = this.media.audioBuffer(clip.mediaId);
      if (!buf) continue;
      const srcOffset = t - clip.start;
      if (srcOffset < 0 || srcOffset >= buf.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      const v = dbToGain(clip.volumeAt(t));
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.005);
      g.gain.setValueAtTime(v, ctx.currentTime + length - 0.015);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + length);
      src.connect(g).connect(out);
      src.start(ctx.currentTime, srcOffset, length);
    }
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources = [];
  }
}
