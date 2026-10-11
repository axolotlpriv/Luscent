/**
 * Farnebäck dense optical flow (G. Farnebäck, "Two-Frame Motion Estimation
 * Based on Polynomial Expansion", 2003), following the structure of the
 * widely used OpenCV implementation:
 *
 *   per pyramid level (coarse → fine)
 *     R = polynomial expansion of each frame (b_y, b_x, a_yy, a_xx, a_xy)
 *     M = update matrices from R0, R1 sampled at x + flow
 *     repeat: blur M, solve 2×2 system per pixel → flow, recompute M
 *
 * This is the CPU reference (used for tests, workers and as a fallback).
 * `engine/flow/gpuFarneback.ts` runs the same steps as WebGPU compute.
 *
 * Flow convention: I0(x) ≈ I1(x + F(x)) in pixels.
 */

export interface FlowParams {
  levels: number;
  pyrScale: number;
  /** Polynomial expansion neighbourhood (n = 5 or 7). */
  polyN: number;
  polySigma: number;
  /** Averaging window for the matrices (odd). */
  winSize: number;
  iterations: number;
}

export const DEFAULT_FLOW: FlowParams = { levels: 4, pyrScale: 0.5, polyN: 5, polySigma: 1.1, winSize: 15, iterations: 3 };

export interface GrayImage {
  w: number;
  h: number;
  data: Float32Array;
}

export interface FlowField {
  w: number;
  h: number;
  /** Interleaved dx, dy (pixels). */
  data: Float32Array;
}

/** Gaussian polynomial-expansion kernels and the inverse-G constants. */
export function polyExpCoeffs(n: number, sigma: number) {
  const g = new Float64Array(2 * n + 1);
  const xg = new Float64Array(2 * n + 1);
  const xxg = new Float64Array(2 * n + 1);
  let s = 0;
  for (let x = -n; x <= n; x++) {
    g[x + n] = Math.exp((-x * x) / (2 * sigma * sigma));
    s += g[x + n];
  }
  for (let x = -n; x <= n; x++) {
    g[x + n] /= s;
    xg[x + n] = x * g[x + n];
    xxg[x + n] = x * x * g[x + n];
  }
  // Moments of the applicability over the (2n+1)² window.
  const G = Array.from({ length: 6 }, () => new Float64Array(6));
  for (let y = -n; y <= n; y++) {
    for (let x = -n; x <= n; x++) {
      const v = g[y + n] * g[x + n];
      G[0][0] += v;
      G[1][1] += v * x * x;
      G[3][3] += v * x * x * x * x;
      G[5][5] += v * x * x * y * y;
    }
  }
  G[2][2] = G[0][3] = G[0][4] = G[3][0] = G[4][0] = G[1][1];
  G[4][4] = G[3][3];
  G[3][4] = G[4][3] = G[5][5];
  const inv = invert6(G);
  return { g, xg, xxg, ig11: inv[1][1], ig03: inv[0][3], ig33: inv[3][3], ig55: inv[5][5] };
}

function invert6(m: Float64Array[]): number[][] {
  const n = 6;
  const a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((r) => r.slice(n));
}

/** Polynomial expansion → 5 coefficients per pixel: [b_y, b_x, a_yy, a_xx, a_xy]. */
export function polyExp(img: GrayImage, n: number, sigma: number): Float32Array {
  const { w, h, data } = img;
  const c = polyExpCoeffs(n, sigma);
  const out = new Float32Array(w * h * 5);
  const row = new Float64Array(w * 3);
  const at = (x: number, y: number) => data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    // Vertical pass.
    for (let x = 0; x < w; x++) {
      let t0 = at(x, y) * c.g[n];
      let t1 = 0;
      let t2 = 0;
      for (let k = 1; k <= n; k++) {
        const p = at(x, y + k);
        const m = at(x, y - k);
        t0 += c.g[n + k] * (p + m);
        t1 += c.xg[n + k] * (p - m);
        t2 += c.xxg[n + k] * (p + m);
      }
      row[x * 3] = t0;
      row[x * 3 + 1] = t1;
      row[x * 3 + 2] = t2;
    }
    // Horizontal pass.
    const r = (x: number, i: number) => row[Math.min(w - 1, Math.max(0, x)) * 3 + i];
    for (let x = 0; x < w; x++) {
      let b1 = r(x, 0) * c.g[n];
      let b2 = 0;
      let b3 = r(x, 1) * c.g[n];
      let b4 = 0;
      let b5 = r(x, 2) * c.g[n];
      let b6 = 0;
      for (let k = 1; k <= n; k++) {
        const tg = r(x + k, 0) + r(x - k, 0);
        const tgx = r(x + k, 0) - r(x - k, 0);
        const tgy = r(x + k, 1) + r(x - k, 1);
        const tgxy = r(x + k, 1) - r(x - k, 1);
        const tgyy = r(x + k, 2) + r(x - k, 2);
        b1 += tg * c.g[n + k];
        b2 += tgx * c.xg[n + k];
        b3 += tgy * c.g[n + k];
        b4 += tg * c.xxg[n + k];
        b5 += tgyy * c.g[n + k];
        b6 += tgxy * c.xg[n + k];
      }
      const o = (y * w + x) * 5;
      out[o] = b3 * c.ig11;
      out[o + 1] = b2 * c.ig11;
      out[o + 2] = b1 * c.ig03 + b5 * c.ig33;
      out[o + 3] = b1 * c.ig03 + b4 * c.ig33;
      out[o + 4] = b6 * c.ig55;
    }
  }
  return out;
}

const BORDER = [0.14, 0.14, 0.4472, 0.4472, 0.4472];

/** Per-pixel normal-equation terms [G11, G12, G22, h1, h2]. */
export function updateMatrices(R0: Float32Array, R1: Float32Array, flow: Float32Array, w: number, h: number): Float32Array {
  const M = new Float32Array(w * h * 5);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = flow[i * 2];
      const dy = flow[i * 2 + 1];
      let fx = x + dx;
      let fy = y + dy;
      const x1 = Math.floor(fx);
      const y1 = Math.floor(fy);
      let r2: number, r3: number, r4: number, r5: number, r6: number;
      const o0 = i * 5;
      if (x1 >= 0 && y1 >= 0 && x1 < w - 1 && y1 < h - 1) {
        fx -= x1;
        fy -= y1;
        const a00 = (1 - fx) * (1 - fy);
        const a01 = fx * (1 - fy);
        const a10 = (1 - fx) * fy;
        const a11 = fx * fy;
        const p = (y1 * w + x1) * 5;
        const s = (k: number) => a00 * R1[p + k] + a01 * R1[p + 5 + k] + a10 * R1[p + w * 5 + k] + a11 * R1[p + w * 5 + 5 + k];
        r2 = s(0);
        r3 = s(1);
        r4 = (R0[o0 + 2] + s(2)) * 0.5;
        r5 = (R0[o0 + 3] + s(3)) * 0.5;
        r6 = (R0[o0 + 4] + s(4)) * 0.25;
      } else {
        r2 = r3 = 0;
        r4 = R0[o0 + 2];
        r5 = R0[o0 + 3];
        r6 = R0[o0 + 4] * 0.5;
      }
      r2 = (R0[o0] - r2) * 0.5;
      r3 = (R0[o0 + 1] - r3) * 0.5;
      r2 += r4 * dy + r6 * dx;
      r3 += r6 * dy + r5 * dx;
      if (x < 5 || y < 5 || x >= w - 5 || y >= h - 5) {
        const sc = (x < 5 ? BORDER[x] : x >= w - 5 ? BORDER[w - 1 - x] : 1) * (y < 5 ? BORDER[y] : y >= h - 5 ? BORDER[h - 1 - y] : 1);
        r2 *= sc;
        r3 *= sc;
        r4 *= sc;
        r5 *= sc;
        r6 *= sc;
      }
      M[o0] = r4 * r4 + r6 * r6;
      M[o0 + 1] = (r4 + r5) * r6;
      M[o0 + 2] = r5 * r5 + r6 * r6;
      M[o0 + 3] = r4 * r2 + r6 * r3;
      M[o0 + 4] = r6 * r2 + r5 * r3;
    }
  }
  return M;
}

export function gaussianKernel(winSize: number): Float32Array {
  const r = winSize >> 1;
  const sigma = 0.3 * (r - 1) + 0.8;
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
    s += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** Separable blur of a C-channel image (clamped borders). */
export function blurChannels(src: Float32Array, w: number, h: number, C: number, k: Float32Array): Float32Array {
  const r = k.length >> 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < C; c++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += k[i + r] * src[(y * w + Math.min(w - 1, Math.max(0, x + i))) * C + c];
        tmp[(y * w + x) * C + c] = s;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < C; c++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += k[i + r] * tmp[(Math.min(h - 1, Math.max(0, y + i)) * w + x) * C + c];
        out[(y * w + x) * C + c] = s;
      }
    }
  }
  return out;
}

export function solveFlow(M: Float32Array, w: number, h: number): Float32Array {
  const flow = new Float32Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    const g11 = M[i * 5];
    const g12 = M[i * 5 + 1];
    const g22 = M[i * 5 + 2];
    const h1 = M[i * 5 + 3];
    const h2 = M[i * 5 + 4];
    const idet = 1 / (g11 * g22 - g12 * g12 + 1e-3);
    flow[i * 2] = (g11 * h2 - g12 * h1) * idet;
    flow[i * 2 + 1] = (g22 * h1 - g12 * h2) * idet;
  }
  return flow;
}

/** Gaussian-smoothed downscale by `scale`. */
export function downscale(img: GrayImage, scale: number): GrayImage {
  const w = Math.max(8, Math.round(img.w * scale));
  const h = Math.max(8, Math.round(img.h * scale));
  const sigma = (1 / scale - 1) * 0.5;
  const k = gaussianKernel(Math.max(3, Math.round(sigma * 5) | 1));
  const blurred = sigma > 0.25 ? blurChannels(img.data, img.w, img.h, 1, k) : img.data;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = bilinear(blurred, img.w, img.h, ((x + 0.5) * img.w) / w - 0.5, ((y + 0.5) * img.h) / h - 0.5);
    }
  }
  return { w, h, data: out };
}

export function bilinear(d: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  return (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) + (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy;
}

function upsampleFlow(f: FlowField, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 2);
  const sx = w / f.w;
  const sy = h / f.h;
  const ch = (c: number) => {
    const plane = new Float32Array(f.w * f.h);
    for (let i = 0; i < plane.length; i++) plane[i] = f.data[i * 2 + c];
    return plane;
  };
  const px = ch(0);
  const py = ch(1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / sx - 0.5;
      const fy = (y + 0.5) / sy - 0.5;
      out[(y * w + x) * 2] = bilinear(px, f.w, f.h, fx, fy) * sx;
      out[(y * w + x) * 2 + 1] = bilinear(py, f.w, f.h, fx, fy) * sy;
    }
  }
  return out;
}

/** Dense flow from frame 0 to frame 1. */
export function farnebackFlow(i0: GrayImage, i1: GrayImage, p: FlowParams = DEFAULT_FLOW): FlowField {
  const pyr0: GrayImage[] = [i0];
  const pyr1: GrayImage[] = [i1];
  for (let l = 1; l < p.levels; l++) {
    const prev = pyr0[l - 1];
    if (Math.min(prev.w, prev.h) * p.pyrScale < 16) break;
    pyr0.push(downscale(prev, p.pyrScale));
    pyr1.push(downscale(pyr1[l - 1], p.pyrScale));
  }
  const k = gaussianKernel(p.winSize);
  let flow: FlowField | null = null;
  for (let l = pyr0.length - 1; l >= 0; l--) {
    const a = pyr0[l];
    const b = pyr1[l];
    const f: Float32Array = flow ? upsampleFlow(flow, a.w, a.h) : new Float32Array(a.w * a.h * 2);
    const R0 = polyExp(a, p.polyN, p.polySigma);
    const R1 = polyExp(b, p.polyN, p.polySigma);
    let M = updateMatrices(R0, R1, f, a.w, a.h);
    let cur: Float32Array = f;
    for (let it = 0; it < p.iterations; it++) {
      const Mb = blurChannels(M, a.w, a.h, 5, k);
      cur = solveFlow(Mb, a.w, a.h);
      if (it < p.iterations - 1) M = updateMatrices(R0, R1, cur, a.w, a.h);
    }
    flow = { w: a.w, h: a.h, data: cur };
  }
  return flow!;
}

/** RGBA (straight or premultiplied, 0..255) → luminance 0..255 at a target width. */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): GrayImage {
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return { w, h, data };
}

/**
 * Synthesise the frame at fraction t between two RGBA frames using flow
 * F (0 → 1, possibly at lower resolution than the frames).
 */
export function interpolateFrames(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, flow: FlowField, t: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = flow.w / w;
  const sy = flow.h / h;
  const fxp = new Float32Array(flow.w * flow.h);
  const fyp = new Float32Array(flow.w * flow.h);
  for (let i = 0; i < fxp.length; i++) {
    fxp[i] = flow.data[i * 2] / sx;
    fyp[i] = flow.data[i * 2 + 1] / sy;
  }
  const sample = (img: Uint8ClampedArray, x: number, y: number, c: number) => {
    const cx = Math.min(w - 1, Math.max(0, x));
    const cy = Math.min(h - 1, Math.max(0, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = cx - x0;
    const ty = cy - y0;
    return (img[(y0 * w + x0) * 4 + c] * (1 - tx) + img[(y0 * w + x1) * 4 + c] * tx) * (1 - ty) + (img[(y1 * w + x0) * 4 + c] * (1 - tx) + img[(y1 * w + x1) * 4 + c] * tx) * ty;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = bilinear(fxp, flow.w, flow.h, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      const dy = bilinear(fyp, flow.w, flow.h, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      for (let c = 0; c < 4; c++) {
        const va = sample(a, x - t * dx, y - t * dy, c);
        const vb = sample(b, x + (1 - t) * dx, y + (1 - t) * dy, c);
        out[(y * w + x) * 4 + c] = va * (1 - t) + vb * t;
      }
    }
  }
  return out;
}
