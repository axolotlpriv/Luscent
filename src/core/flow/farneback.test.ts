import { describe, expect, it } from 'vitest';
import { farnebackFlow, interpolateFrames, type GrayImage } from './farneback';

/** Smooth random texture shifted by (dx, dy). */
function texture(w: number, h: number, dx: number, dy: number): GrayImage {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x - dx;
      const v = y - dy;
      data[y * w + x] =
        128 + 50 * Math.sin(u * 0.21) * Math.cos(v * 0.17) + 30 * Math.sin(u * 0.07 + v * 0.11) + 20 * Math.cos(u * 0.33 - v * 0.05);
    }
  }
  return { w, h, data };
}

function meanFlow(f: { w: number; h: number; data: Float32Array }, margin = 12): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = margin; y < f.h - margin; y++) {
    for (let x = margin; x < f.w - margin; x++) {
      sx += f.data[(y * f.w + x) * 2];
      sy += f.data[(y * f.w + x) * 2 + 1];
      n++;
    }
  }
  return [sx / n, sy / n];
}

describe('Farnebäck optical flow', () => {
  it.each([
    [2.5, -1.5],
    [-6, 4],
    [12, 3],
  ])('recovers a global translation of (%d, %d)', (dx, dy) => {
    const w = 96;
    const h = 80;
    const a = texture(w, h, 0, 0);
    const b = texture(w, h, dx, dy);
    const f = farnebackFlow(a, b);
    const [mx, my] = meanFlow(f);
    expect(mx).toBeCloseTo(dx, 0);
    expect(my).toBeCloseTo(dy, 0);
  });

  it('returns zero flow for identical frames', () => {
    const a = texture(64, 64, 0, 0);
    const [mx, my] = meanFlow(farnebackFlow(a, a));
    expect(Math.abs(mx)).toBeLessThan(0.05);
    expect(Math.abs(my)).toBeLessThan(0.05);
  });

  it('interpolates the in-between frame better than a crossfade', () => {
    const w = 96;
    const h = 80;
    const toRGBA = (g: GrayImage) => {
      const o = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) o.set([g.data[i], g.data[i], g.data[i], 255], i * 4);
      return o;
    };
    const a = texture(w, h, 0, 0);
    const b = texture(w, h, 8, 0);
    const mid = texture(w, h, 4, 0);
    const flow = farnebackFlow(a, b);
    const interp = interpolateFrames(toRGBA(a), toRGBA(b), w, h, flow, 0.5);
    let errFlow = 0;
    let errMix = 0;
    for (let y = 12; y < h - 12; y++) {
      for (let x = 12; x < w - 12; x++) {
        const i = y * w + x;
        errFlow += Math.abs(interp[i * 4] - mid.data[i]);
        errMix += Math.abs((a.data[i] + b.data[i]) / 2 - mid.data[i]);
      }
    }
    expect(errFlow).toBeLessThan(errMix * 0.35);
  });
});
