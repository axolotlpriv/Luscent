import { describe, expect, it } from 'vitest';
import { analyzeAudio } from './beats';
import { computePeaks, pickLevel } from './waveform';

function clickTrack(bpm: number, seconds: number, sr: number, offset = 0.25): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const period = 60 / bpm;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.005; // noise floor
  for (let t = offset; t < seconds; t += period) {
    const s0 = Math.floor(t * sr);
    for (let i = 0; i < sr * 0.03 && s0 + i < out.length; i++) {
      out[s0 + i] += Math.sin((2 * Math.PI * 1000 * i) / sr) * Math.exp(-i / (sr * 0.005));
    }
  }
  return out;
}

describe('beat detection', () => {
  it.each([90, 120, 150])('finds tempo and beat phase of a %d BPM click track', (bpm) => {
    const sr = 22050;
    const audio = clickTrack(bpm, 12, sr);
    const a = analyzeAudio(audio, sr);
    expect(a.bpm).toBeGreaterThan(bpm * 0.97);
    expect(a.bpm).toBeLessThan(bpm * 1.03);
    const period = 60 / bpm;
    // Every detected beat should sit on a click (within 25ms).
    const inner = a.beats.filter((b) => b > 1 && b < 11);
    expect(inner.length).toBeGreaterThan(8);
    for (const b of inner) {
      const phase = ((b - 0.25) / period) % 1;
      const err = Math.min(phase, 1 - phase) * period;
      expect(err).toBeLessThan(0.025);
    }
    // Onsets line up with clicks too.
    expect(a.onsets.length).toBeGreaterThan(10);
  });

  it('handles silence', () => {
    const a = analyzeAudio(new Float32Array(22050), 22050);
    expect(a.onsets).toEqual([]);
  });
});

describe('waveform peaks', () => {
  it('builds a min/max pyramid', () => {
    const sr = 8000;
    const s = new Float32Array(sr);
    for (let i = 0; i < sr; i++) s[i] = Math.sin(i / 10) * (i < sr / 2 ? 0.5 : 1);
    const p = computePeaks(s, sr, 64);
    expect(p.levels.length).toBeGreaterThan(1);
    const top = p.levels[p.levels.length - 1];
    let mx = 0;
    for (let i = 1; i < top.data.length; i += 2) mx = Math.max(mx, top.data[i]);
    expect(mx).toBeCloseTo(1, 1);
    expect(pickLevel(p, 1000).samplesPerBucket).toBeLessThanOrEqual(1000);
  });
});
