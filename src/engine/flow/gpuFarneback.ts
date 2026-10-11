/**
 * Farnebäck optical flow + flow-based frame synthesis on WebGPU compute.
 * Mirrors core/flow/farneback.ts step by step (polynomial expansion,
 * matrix update, gaussian averaging, 2×2 solve, coarse-to-fine pyramid).
 */
import { DEFAULT_FLOW, gaussianKernel, polyExpCoeffs, type FlowParams } from '../../core/flow/farneback';

const WG = 8;

const COMMON = /* wgsl */ `
struct Dims { w: u32, h: u32, sw: u32, sh: u32, t: f32, scale: f32, pad0: f32, pad1: f32 };
fn clampi(v: i32, lo: i32, hi: i32) -> i32 { return max(lo, min(hi, v)); }
`;

const GRAY = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read_write> outg: array<f32>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(f32(d.w), f32(d.h));
  let c = textureSampleLevel(src, samp, uv, 0.0);
  outg[id.y * d.w + id.x] = dot(c.rgb, vec3f(0.299, 0.587, 0.114)) * 255.0;
}`;

/** Downscale a gray buffer (sw × sh) → (w × h) with a tent filter. */
const DOWN = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var<storage, read> inb: array<f32>;
@group(0) @binding(2) var<storage, read_write> outb: array<f32>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  let fx = (f32(id.x) + 0.5) * f32(d.sw) / f32(d.w) - 0.5;
  let fy = (f32(id.y) + 0.5) * f32(d.sh) / f32(d.h) - 0.5;
  var acc = 0.0; var ws = 0.0;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let px = clampi(i32(round(fx)) + i, 0, i32(d.sw) - 1);
      let py = clampi(i32(round(fy)) + j, 0, i32(d.sh) - 1);
      let wgt = exp(-f32(i * i + j * j) / 2.0);
      acc += inb[u32(py) * d.sw + u32(px)] * wgt; ws += wgt;
    }
  }
  outb[id.y * d.w + id.x] = acc / ws;
}`;

const POLY_U = /* wgsl */ `
struct Poly { g: array<vec4f, 4>, xg: array<vec4f, 4>, xxg: array<vec4f, 4>, ig: vec4f, n: u32, p0: u32, p1: u32, p2: u32 };
fn kg(p: Poly, i: u32) -> f32 { return p.g[i / 4u][i % 4u]; }
fn kxg(p: Poly, i: u32) -> f32 { return p.xg[i / 4u][i % 4u]; }
fn kxxg(p: Poly, i: u32) -> f32 { return p.xxg[i / 4u][i % 4u]; }
`;

const POLY_V = /* wgsl */ `${COMMON}${POLY_U}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var<uniform> P: Poly;
@group(0) @binding(2) var<storage, read> img: array<f32>;
@group(0) @binding(3) var<storage, read_write> rowb: array<f32>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  let n = P.n;
  let x = id.x; let y = i32(id.y);
  var t0 = img[id.y * d.w + x] * kg(P, n);
  var t1 = 0.0; var t2 = 0.0;
  for (var k = 1u; k <= n; k++) {
    let yp = u32(clampi(y + i32(k), 0, i32(d.h) - 1));
    let ym = u32(clampi(y - i32(k), 0, i32(d.h) - 1));
    let p = img[yp * d.w + x]; let m = img[ym * d.w + x];
    t0 += kg(P, n + k) * (p + m);
    t1 += kxg(P, n + k) * (p - m);
    t2 += kxxg(P, n + k) * (p + m);
  }
  let o = (id.y * d.w + x) * 3u;
  rowb[o] = t0; rowb[o + 1u] = t1; rowb[o + 2u] = t2;
}`;

const POLY_H = /* wgsl */ `${COMMON}${POLY_U}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var<uniform> P: Poly;
@group(0) @binding(2) var<storage, read> rowb: array<f32>;
@group(0) @binding(3) var<storage, read_write> R: array<f32>;
fn rr(x: i32, y: u32, c: u32) -> f32 { return rowb[(y * d.w + u32(clampi(x, 0, i32(d.w) - 1))) * 3u + c]; }
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  let n = P.n; let x = i32(id.x); let y = id.y;
  var b1 = rr(x, y, 0u) * kg(P, n); var b2 = 0.0;
  var b3 = rr(x, y, 1u) * kg(P, n); var b4 = 0.0;
  var b5 = rr(x, y, 2u) * kg(P, n); var b6 = 0.0;
  for (var k = 1u; k <= n; k++) {
    let ik = i32(k);
    let tg = rr(x + ik, y, 0u) + rr(x - ik, y, 0u);
    let tgx = rr(x + ik, y, 0u) - rr(x - ik, y, 0u);
    let tgy = rr(x + ik, y, 1u) + rr(x - ik, y, 1u);
    let tgxy = rr(x + ik, y, 1u) - rr(x - ik, y, 1u);
    let tgyy = rr(x + ik, y, 2u) + rr(x - ik, y, 2u);
    b1 += tg * kg(P, n + k); b2 += tgx * kxg(P, n + k); b3 += tgy * kg(P, n + k);
    b4 += tg * kxxg(P, n + k); b5 += tgyy * kg(P, n + k); b6 += tgxy * kxg(P, n + k);
  }
  let o = (y * d.w + id.x) * 5u;
  R[o] = b3 * P.ig.x;
  R[o + 1u] = b2 * P.ig.x;
  R[o + 2u] = b1 * P.ig.y + b5 * P.ig.z;
  R[o + 3u] = b1 * P.ig.y + b4 * P.ig.z;
  R[o + 4u] = b6 * P.ig.w;
}`;

const UPDATE = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var<storage, read> R0: array<f32>;
@group(0) @binding(2) var<storage, read> R1: array<f32>;
@group(0) @binding(3) var<storage, read> flow: array<f32>;
@group(0) @binding(4) var<storage, read_write> M: array<f32>;
fn border(i: i32, n: i32) -> f32 {
  var b = array<f32, 5>(0.14, 0.14, 0.4472, 0.4472, 0.4472);
  if (i < 5) { return b[i]; }
  if (i >= n - 5) { return b[n - 1 - i]; }
  return 1.0;
}
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  let w = i32(d.w); let h = i32(d.h);
  let x = i32(id.x); let y = i32(id.y);
  let i = id.y * d.w + id.x;
  let dx = flow[i * 2u]; let dy = flow[i * 2u + 1u];
  var fx = f32(x) + dx; var fy = f32(y) + dy;
  let x1 = i32(floor(fx)); let y1 = i32(floor(fy));
  let o0 = i * 5u;
  var r2: f32; var r3: f32; var r4: f32; var r5: f32; var r6: f32;
  if (x1 >= 0 && y1 >= 0 && x1 < w - 1 && y1 < h - 1) {
    fx -= f32(x1); fy -= f32(y1);
    let a00 = (1.0 - fx) * (1.0 - fy); let a01 = fx * (1.0 - fy);
    let a10 = (1.0 - fx) * fy; let a11 = fx * fy;
    let p = (u32(y1) * d.w + u32(x1)) * 5u;
    let s = d.w * 5u;
    r2 = a00 * R1[p] + a01 * R1[p + 5u] + a10 * R1[p + s] + a11 * R1[p + s + 5u];
    r3 = a00 * R1[p + 1u] + a01 * R1[p + 6u] + a10 * R1[p + s + 1u] + a11 * R1[p + s + 6u];
    r4 = (R0[o0 + 2u] + a00 * R1[p + 2u] + a01 * R1[p + 7u] + a10 * R1[p + s + 2u] + a11 * R1[p + s + 7u]) * 0.5;
    r5 = (R0[o0 + 3u] + a00 * R1[p + 3u] + a01 * R1[p + 8u] + a10 * R1[p + s + 3u] + a11 * R1[p + s + 8u]) * 0.5;
    r6 = (R0[o0 + 4u] + a00 * R1[p + 4u] + a01 * R1[p + 9u] + a10 * R1[p + s + 4u] + a11 * R1[p + s + 9u]) * 0.25;
  } else {
    r2 = 0.0; r3 = 0.0;
    r4 = R0[o0 + 2u]; r5 = R0[o0 + 3u]; r6 = R0[o0 + 4u] * 0.5;
  }
  r2 = (R0[o0] - r2) * 0.5;
  r3 = (R0[o0 + 1u] - r3) * 0.5;
  r2 += r4 * dy + r6 * dx;
  r3 += r6 * dy + r5 * dx;
  let sc = border(x, w) * border(y, h);
  r2 *= sc; r3 *= sc; r4 *= sc; r5 *= sc; r6 *= sc;
  M[o0] = r4 * r4 + r6 * r6;
  M[o0 + 1u] = (r4 + r5) * r6;
  M[o0 + 2u] = r5 * r5 + r6 * r6;
  M[o0 + 3u] = r4 * r2 + r6 * r3;
  M[o0 + 4u] = r6 * r2 + r5 * r3;
}`;

const BLUR_U = /* wgsl */ `struct Kern { k: array<vec4f, 8>, r: u32, horizontal: u32, p0: u32, p1: u32 };
fn kk(K: Kern, i: u32) -> f32 { return K.k[i / 4u][i % 4u]; }`;

const BLUR5 = /* wgsl */ `${COMMON}${BLUR_U}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var<uniform> K: Kern;
@group(0) @binding(2) var<storage, read> inb: array<f32>;
@group(0) @binding(3) var<storage, read_write> outb: array<f32>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  var acc: array<f32, 5>;
  let r = i32(K.r);
  for (var t = -r; t <= r; t++) {
    var x = i32(id.x); var y = i32(id.y);
    if (K.horizontal == 1u) { x = clampi(x + t, 0, i32(d.w) - 1); } else { y = clampi(y + t, 0, i32(d.h) - 1); }
    let wgt = kk(K, u32(t + r));
    let o = (u32(y) * d.w + u32(x)) * 5u;
    for (var c = 0u; c < 5u; c++) { acc[c] += inb[o + c] * wgt; }
  }
  let o = (id.y * d.w + id.x) * 5u;
  for (var c = 0u; c < 5u; c++) { outb[o + c] = acc[c]; }
}`;

const SOLVE = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var<storage, read> M: array<f32>;
@group(0) @binding(2) var<storage, read_write> flow: array<f32>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  let i = id.y * d.w + id.x;
  let g11 = M[i * 5u]; let g12 = M[i * 5u + 1u]; let g22 = M[i * 5u + 2u];
  let h1 = M[i * 5u + 3u]; let h2 = M[i * 5u + 4u];
  let idet = 1.0 / (g11 * g22 - g12 * g12 + 1e-3);
  flow[i * 2u] = (g11 * h2 - g12 * h1) * idet;
  flow[i * 2u + 1u] = (g22 * h1 - g12 * h2) * idet;
}`;

/** Upsample flow sw×sh → w×h (scaling vectors). */
const UPFLOW = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var<storage, read> inb: array<f32>;
@group(0) @binding(2) var<storage, read_write> outb: array<f32>;
fn at(x: i32, y: i32, c: u32) -> f32 { return inb[(u32(clampi(y, 0, i32(d.sh) - 1)) * d.sw + u32(clampi(x, 0, i32(d.sw) - 1))) * 2u + c]; }
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= d.w || id.y >= d.h) { return; }
  let sx = f32(d.w) / f32(d.sw); let sy = f32(d.h) / f32(d.sh);
  let fx = (f32(id.x) + 0.5) / sx - 0.5; let fy = (f32(id.y) + 0.5) / sy - 0.5;
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let tx = fx - f32(x0); let ty = fy - f32(y0);
  for (var c = 0u; c < 2u; c++) {
    let v = mix(mix(at(x0, y0, c), at(x0 + 1, y0, c), tx), mix(at(x0, y0 + 1, c), at(x0 + 1, y0 + 1, c), tx), ty);
    outb[(id.y * d.w + id.x) * 2u + c] = v * select(sy, sx, c == 0u);
  }
}`;

/** Fullscreen synthesis: sample both frames along the flow. */
const WARP = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var f0: texture_2d<f32>;
@group(0) @binding(2) var f1: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> flow: array<f32>;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut; o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
fn fl(x: i32, y: i32, c: u32) -> f32 { return flow[(u32(clampi(y, 0, i32(d.h) - 1)) * d.w + u32(clampi(x, 0, i32(d.w) - 1))) * 2u + c]; }
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  // flow is at working resolution (d.w × d.h); vectors in working pixels.
  let fx = in.uv.x * f32(d.w) - 0.5; let fy = in.uv.y * f32(d.h) - 0.5;
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let tx = fx - f32(x0); let ty = fy - f32(y0);
  var v: vec2f;
  for (var c = 0u; c < 2u; c++) {
    v[c] = mix(mix(fl(x0, y0, c), fl(x0 + 1, y0, c), tx), mix(fl(x0, y0 + 1, c), fl(x0 + 1, y0 + 1, c), tx), ty);
  }
  let duv = v / vec2f(f32(d.w), f32(d.h));
  let a = textureSampleLevel(f0, samp, in.uv - d.t * duv, 0.0);
  let b = textureSampleLevel(f1, samp, in.uv + (1.0 - d.t) * duv, 0.0);
  return mix(a, b, d.t);
}`;

interface Level {
  w: number;
  h: number;
  g0: GPUBuffer;
  g1: GPUBuffer;
  row: GPUBuffer;
  R0: GPUBuffer;
  R1: GPUBuffer;
  M: GPUBuffer;
  Mt: GPUBuffer;
  flow: GPUBuffer;
  dims: GPUBuffer;
  /** Dims for downscaling from the previous (finer) level. */
  downDims: GPUBuffer | null;
  /** Dims for upsampling flow from the next (coarser) level. */
  upDims: GPUBuffer | null;
}

export class GpuFarneback {
  private pipes = new Map<string, GPUComputePipeline>();
  private warpPipe: GPURenderPipeline | null = null;
  private sampler: GPUSampler;
  private levels: Level[] = [];
  private polyU: GPUBuffer;
  private kernH: GPUBuffer;
  private kernV: GPUBuffer;
  private size = { w: 0, h: 0 };
  private tex: GPUTexture[] = [];
  private warpDims: GPUBuffer;

  constructor(
    private readonly device: GPUDevice,
    private readonly params: FlowParams = DEFAULT_FLOW,
  ) {
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const c = polyExpCoeffs(params.polyN, params.polySigma);
    const pack = (arr: Float64Array) => {
      const out = new Float32Array(16);
      out.set(Array.from(arr).slice(0, 16));
      return out;
    };
    const poly = new Float32Array(16 * 3 + 4 + 4);
    poly.set(pack(c.g), 0);
    poly.set(pack(c.xg), 16);
    poly.set(pack(c.xxg), 32);
    poly.set([c.ig11, c.ig03, c.ig33, c.ig55], 48);
    new Uint32Array(poly.buffer).set([params.polyN, 0, 0, 0], 52);
    this.polyU = this.buffer(poly.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.polyU, 0, poly);
    const k = gaussianKernel(params.winSize);
    const mk = (horizontal: number) => {
      const kb = new Float32Array(32 + 4);
      kb.set(k, 0);
      new Uint32Array(kb.buffer).set([k.length >> 1, horizontal, 0, 0], 32);
      const b = this.buffer(kb.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(b, 0, kb);
      return b;
    };
    this.kernH = mk(1);
    this.kernV = mk(0);
    this.warpDims = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  }

  private buffer(size: number, usage: number): GPUBuffer {
    return this.device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
  }

  private pipe(name: string, code: string): GPUComputePipeline {
    let p = this.pipes.get(name);
    if (!p) {
      p = this.device.createComputePipeline({ layout: 'auto', compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' } });
      this.pipes.set(name, p);
    }
    return p;
  }

  private dimsData(w: number, h: number, sw = 0, sh = 0, t = 0): ArrayBuffer {
    const b = new ArrayBuffer(32);
    new Uint32Array(b, 0, 4).set([w, h, sw, sh]);
    new Float32Array(b, 16, 4).set([t, 1, 0, 0]);
    return b;
  }

  /** (Re)allocate the pyramid for a working size. */
  private ensure(w: number, h: number): void {
    if (this.size.w === w && this.size.h === h) return;
    for (const l of this.levels) for (const b of [l.g0, l.g1, l.row, l.R0, l.R1, l.M, l.Mt, l.flow, l.dims, l.downDims, l.upDims]) b?.destroy();
    this.levels = [];
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    let lw = w;
    let lh = h;
    for (let i = 0; i < this.params.levels; i++) {
      if (i > 0 && Math.min(lw, lh) * this.params.pyrScale < 16) break;
      if (i > 0) {
        lw = Math.max(8, Math.round(lw * this.params.pyrScale));
        lh = Math.max(8, Math.round(lh * this.params.pyrScale));
      }
      const n = lw * lh;
      const dims = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.device.queue.writeBuffer(dims, 0, this.dimsData(lw, lh));
      this.levels.push({
        w: lw,
        h: lh,
        g0: this.buffer(n * 4, S),
        g1: this.buffer(n * 4, S),
        row: this.buffer(n * 12, S),
        R0: this.buffer(n * 20, S),
        R1: this.buffer(n * 20, S),
        M: this.buffer(n * 20, S),
        Mt: this.buffer(n * 20, S),
        flow: this.buffer(n * 8, S),
        dims,
        downDims: null,
        upDims: null,
      });
    }
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    for (let i = 0; i < this.levels.length; i++) {
      const L = this.levels[i];
      if (i > 0) {
        const P = this.levels[i - 1];
        L.downDims = this.buffer(32, U);
        this.device.queue.writeBuffer(L.downDims, 0, this.dimsData(L.w, L.h, P.w, P.h));
      }
      if (i < this.levels.length - 1) {
        const C = this.levels[i + 1];
        L.upDims = this.buffer(32, U);
        this.device.queue.writeBuffer(L.upDims, 0, this.dimsData(L.w, L.h, C.w, C.h));
      }
    }
    this.size = { w, h };
  }

  private run(enc: GPUCommandEncoder, name: string, code: string, entries: GPUBindGroupEntry[], w: number, h: number): void {
    const p = this.pipe(name, code);
    const pass = enc.beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(Math.ceil(w / WG), Math.ceil(h / WG));
    pass.end();
  }

  private uploadTexture(i: number, src: ImageBitmap | VideoFrame | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement): GPUTexture {
    const w = 'displayWidth' in src ? src.displayWidth : 'videoWidth' in src ? src.videoWidth : src.width;
    const h = 'displayHeight' in src ? src.displayHeight : 'videoHeight' in src ? src.videoHeight : src.height;
    let t = this.tex[i];
    if (!t || t.width !== w || t.height !== h) {
      t?.destroy();
      t = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.tex[i] = t;
    }
    this.device.queue.copyExternalImageToTexture({ source: src }, { texture: t }, [w, h]);
    return t;
  }

  /**
   * Synthesise the frame at fraction `t` between two frames into `ctx`'s
   * canvas. `workWidth` sets the flow resolution (quality vs speed).
   */
  interpolate(
    a: ImageBitmap | VideoFrame | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement,
    b: ImageBitmap | VideoFrame | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement,
    t: number,
    ctx: GPUCanvasContext,
    format: GPUTextureFormat,
    workWidth = 480,
  ): void {
    const device = this.device;
    const ta = this.uploadTexture(0, a);
    const tb = this.uploadTexture(1, b);
    const W = Math.min(ta.width, workWidth);
    const H = Math.max(8, Math.round((ta.height / ta.width) * W));
    this.ensure(W, H);
    const enc = device.createCommandEncoder();
    const L0 = this.levels[0];
    // Level 0 gray from the textures.
    this.run(enc, 'gray', GRAY, [{ binding: 0, resource: { buffer: L0.dims } }, { binding: 1, resource: ta.createView() }, { binding: 2, resource: this.sampler }, { binding: 3, resource: { buffer: L0.g0 } }], L0.w, L0.h);
    this.run(enc, 'gray', GRAY, [{ binding: 0, resource: { buffer: L0.dims } }, { binding: 1, resource: tb.createView() }, { binding: 2, resource: this.sampler }, { binding: 3, resource: { buffer: L0.g1 } }], L0.w, L0.h);
    // Pyramid.
    for (let i = 1; i < this.levels.length; i++) {
      const L = this.levels[i];
      const P = this.levels[i - 1];
      const dd = L.downDims!;
      this.run(enc, 'down', DOWN, [{ binding: 0, resource: { buffer: dd } }, { binding: 1, resource: { buffer: P.g0 } }, { binding: 2, resource: { buffer: L.g0 } }], L.w, L.h);
      this.run(enc, 'down', DOWN, [{ binding: 0, resource: { buffer: dd } }, { binding: 1, resource: { buffer: P.g1 } }, { binding: 2, resource: { buffer: L.g1 } }], L.w, L.h);
    }
    // Coarse to fine.
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const L = this.levels[i];
      const dims = { binding: 0, resource: { buffer: L.dims } };
      if (i === this.levels.length - 1) enc.clearBuffer(L.flow);
      else {
        const C = this.levels[i + 1];
        const dd = L.upDims!;
        this.run(enc, 'upflow', UPFLOW, [{ binding: 0, resource: { buffer: dd } }, { binding: 1, resource: { buffer: C.flow } }, { binding: 2, resource: { buffer: L.flow } }], L.w, L.h);
      }
      for (const [g, R] of [
        [L.g0, L.R0],
        [L.g1, L.R1],
      ] as const) {
        this.run(enc, 'polyV', POLY_V, [dims, { binding: 1, resource: { buffer: this.polyU } }, { binding: 2, resource: { buffer: g } }, { binding: 3, resource: { buffer: L.row } }], L.w, L.h);
        this.run(enc, 'polyH', POLY_H, [dims, { binding: 1, resource: { buffer: this.polyU } }, { binding: 2, resource: { buffer: L.row } }, { binding: 3, resource: { buffer: R } }], L.w, L.h);
      }
      for (let it = 0; it < this.params.iterations; it++) {
        this.run(enc, 'update', UPDATE, [dims, { binding: 1, resource: { buffer: L.R0 } }, { binding: 2, resource: { buffer: L.R1 } }, { binding: 3, resource: { buffer: L.flow } }, { binding: 4, resource: { buffer: L.M } }], L.w, L.h);
        this.run(enc, 'blur', BLUR5, [dims, { binding: 1, resource: { buffer: this.kernH } }, { binding: 2, resource: { buffer: L.M } }, { binding: 3, resource: { buffer: L.Mt } }], L.w, L.h);
        this.run(enc, 'blur', BLUR5, [dims, { binding: 1, resource: { buffer: this.kernV } }, { binding: 2, resource: { buffer: L.Mt } }, { binding: 3, resource: { buffer: L.M } }], L.w, L.h);
        this.run(enc, 'solve', SOLVE, [dims, { binding: 1, resource: { buffer: L.M } }, { binding: 2, resource: { buffer: L.flow } }], L.w, L.h);
      }
    }
    // Synthesis at full resolution.
    device.queue.writeBuffer(this.warpDims, 0, this.dimsData(L0.w, L0.h, ta.width, ta.height, t));
    if (!this.warpPipe) {
      const module = device.createShaderModule({ code: WARP });
      this.warpPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
    }
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.warpPipe);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.warpPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.warpDims } },
          { binding: 1, resource: ta.createView() },
          { binding: 2, resource: tb.createView() },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: { buffer: L0.flow } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  /** Read back level-0 flow (for tests / debugging). */
  async readFlow(): Promise<{ w: number; h: number; data: Float32Array }> {
    const L = this.levels[0];
    const rb = this.device.createBuffer({ size: L.w * L.h * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(L.flow, 0, rb, 0, L.w * L.h * 8);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    rb.destroy();
    return { w: L.w, h: L.h, data };
  }
}
