/**
 * Twixtor-style frame interpolation for time-remapped / slowed video.
 *
 *  - "blend": crossfade the two neighbouring source frames
 *  - "optical-flow": estimate motion between them (Farnebäck) and warp both
 *    toward the in-between time; WebGPU compute when available, CPU fallback
 *
 * `get()` is synchronous for the preview: it returns a cached result (or a
 * best-effort fallback) and schedules the work, calling `onReady` when a new
 * frame lands. `render()` awaits the exact result (export).
 */
import type { Id } from '../../core/model/types';
import type { FrameBlending } from '../../core/model/types';
import { farnebackFlow, interpolateFrames, toGray } from '../../core/flow/farneback';
import { getGpuDevice } from '../gpu/device';
import type { FrameSource } from '../media/FrameSource';
import { GpuFarneback } from './gpuFarneback';
import { RifeInterpolator } from './rife';

const STEPS = 32;
const CACHE = 24;

export type FlowBackend = 'webgpu' | 'cpu';

export class FrameInterpolator {
  private cache = new Map<string, ImageBitmap>();
  private jobs = new Map<string, Promise<ImageBitmap | null>>();
  private gpu: { flow: GpuFarneback; canvas: OffscreenCanvas; ctx: GPUCanvasContext; format: GPUTextureFormat } | null = null;
  private gpuInit: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Working width for flow estimation (quality ↔ speed). */
  workWidth = 480;
  backend: FlowBackend | null = null;
  /** Interpolation model for optical-flow mode. */
  engine: 'farneback' | 'rife' = 'farneback';
  private rife: RifeInterpolator | null = null;
  onError: (msg: string) => void = () => {};

  constructor(
    private readonly frames: FrameSource,
    private readonly onReady: () => void = () => {},
  ) {}

  private initGpu(): Promise<void> {
    this.gpuInit ??= (async () => {
      const device = await getGpuDevice();
      if (!device || typeof OffscreenCanvas === 'undefined') {
        this.backend = 'cpu';
        return;
      }
      try {
        const canvas = new OffscreenCanvas(16, 16);
        const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!ctx) throw new Error('no webgpu canvas');
        const format = navigator.gpu.getPreferredCanvasFormat();
        ctx.configure({ device, format, alphaMode: 'premultiplied' });
        this.gpu = { flow: new GpuFarneback(device), canvas, ctx, format };
        this.backend = 'webgpu';
      } catch {
        this.backend = 'cpu';
      }
    })();
    return this.gpuInit;
  }

  private key(mediaId: Id, f0: number, step: number, mode: FrameBlending) {
    return `${mediaId}|${f0}|${step}|${mode}|${this.workWidth}|${this.engine}`;
  }

  /** Split a source time into frame index and quantised fraction. */
  static locate(sourceTime: number, fps: number): { f0: number; step: number } {
    const pos = Math.max(0, sourceTime * fps - 0.5);
    let f0 = Math.floor(pos);
    let step = Math.round((pos - f0) * STEPS);
    if (step === STEPS) {
      f0 += 1;
      step = 0;
    }
    return { f0, step };
  }

  /** Synchronous preview access: result if ready, else a fallback (and schedule). */
  get(mediaId: Id, sourceTime: number, fps: number, mode: FrameBlending): TexImageSource | null {
    const { f0, step } = FrameInterpolator.locate(sourceTime, fps);
    if (step === 0) {
      const exact = this.frames.cached(mediaId, f0);
      if (exact) return exact;
      void this.frames.frame(mediaId, f0, fps).then((b) => b && this.onReady());
      return null;
    }
    const k = this.key(mediaId, f0, step, mode);
    const hit = this.cache.get(k);
    if (hit) return hit;
    if (!this.jobs.has(k)) void this.schedule(mediaId, f0, step, fps, mode, k).then((b) => b && this.onReady());
    // Fallback while computing: nearest decoded neighbour.
    return this.frames.cached(mediaId, step < STEPS / 2 ? f0 : f0 + 1) ?? this.frames.cached(mediaId, f0);
  }

  /** Await the interpolated frame (export). */
  async render(mediaId: Id, sourceTime: number, fps: number, mode: FrameBlending): Promise<TexImageSource | null> {
    const { f0, step } = FrameInterpolator.locate(sourceTime, fps);
    if (step === 0 || mode === 'none') return this.frames.frame(mediaId, step < STEPS / 2 ? f0 : f0 + 1, fps);
    const k = this.key(mediaId, f0, step, mode);
    return this.cache.get(k) ?? this.schedule(mediaId, f0, step, fps, mode, k);
  }

  private schedule(mediaId: Id, f0: number, step: number, fps: number, mode: FrameBlending, k: string): Promise<ImageBitmap | null> {
    const job = (this.chain = this.chain.then(async () => {
      const [a, b] = await Promise.all([this.frames.frame(mediaId, f0, fps), this.frames.frame(mediaId, f0 + 1, fps)]);
      if (!a) return null;
      if (!b) return a;
      const t = step / STEPS;
      const out = mode === 'optical-flow' ? await this.flowFrame(a, b, t) : await blendFrames(a, b, t);
      if (out) {
        this.cache.set(k, out);
        while (this.cache.size > CACHE) {
          const [ok, ob] = this.cache.entries().next().value!;
          ob.close();
          this.cache.delete(ok);
        }
      }
      return out;
    })) as Promise<ImageBitmap | null>;
    this.jobs.set(k, job);
    void job.finally(() => this.jobs.delete(k));
    return job;
  }

  private async flowFrame(a: ImageBitmap, b: ImageBitmap, t: number): Promise<ImageBitmap | null> {
    if (this.engine === 'rife') {
      try {
        this.rife ??= new RifeInterpolator();
        return await this.rife.interpolate(a, b, t);
      } catch (err) {
        this.onError(`RIFE unavailable (${(err as Error).message}); using Farnebäck.`);
        this.engine = 'farneback';
      }
    }
    await this.initGpu();
    if (this.gpu) {
      const { flow, canvas, ctx, format } = this.gpu;
      if (canvas.width !== a.width || canvas.height !== a.height) {
        canvas.width = a.width;
        canvas.height = a.height;
      }
      flow.interpolate(a, b, t, ctx, format, this.workWidth);
      return canvas.transferToImageBitmap();
    }
    return cpuFlowFrame(a, b, t, Math.min(this.workWidth, 240));
  }

  dispose(): void {
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
  }
}

function pixels(bmp: ImageBitmap, w: number, h: number): Uint8ClampedArray {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

async function blendFrames(a: ImageBitmap, b: ImageBitmap, t: number): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(a.width, a.height);
  const g = c.getContext('2d')!;
  g.drawImage(a, 0, 0);
  g.globalAlpha = t;
  g.drawImage(b, 0, 0, a.width, a.height);
  return c.transferToImageBitmap();
}

/** CPU fallback: flow at low resolution, synthesis at up to 720px. */
async function cpuFlowFrame(a: ImageBitmap, b: ImageBitmap, t: number, workW: number): Promise<ImageBitmap> {
  const fw = workW;
  const fh = Math.max(8, Math.round((a.height / a.width) * fw));
  const ga = toGray(pixels(a, fw, fh), fw, fh);
  const gb = toGray(pixels(b, fw, fh), fw, fh);
  const flow = farnebackFlow(ga, gb);
  const ow = Math.min(a.width, 720);
  const oh = Math.round((a.height / a.width) * ow);
  const out = interpolateFrames(pixels(a, ow, oh), pixels(b, ow, oh), ow, oh, flow, t);
  const c = new OffscreenCanvas(ow, oh);
  c.getContext('2d')!.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, ow, oh), 0, 0);
  return c.transferToImageBitmap();
}
