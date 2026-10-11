/**
 * Optional RIFE frame interpolation through ONNX Runtime Web (WebGPU EP with
 * WASM fallback). No model ships with Luscent: load a RIFE ONNX export once
 * (it is kept in IndexedDB) and choose "RIFE" as the flow engine.
 *
 * Supported model signatures (the common RIFE v4 exports):
 *  - three inputs  img0 [1,3,H,W], img1 [1,3,H,W], timestep [1,1,H,W] or [1]
 *  - one input [1,7,H,W] = img0 ‖ img1 ‖ timestep plane (or [1,6,H,W] at t=0.5)
 * Output: [1,3,H,W] RGB in 0..1. Frames are padded to a multiple of 64.
 */
import { idb } from '../persist/db';

type Ort = typeof import('onnxruntime-web');
type Session = import('onnxruntime-web').InferenceSession;

const MODEL_KEY = 'rife-model';
let ortPromise: Promise<Ort> | null = null;

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';

/**
 * ONNX Runtime is ~25 MB of WASM, so it is only fetched (from the CDN, pinned
 * to the version whose types we compile against) when RIFE is first used.
 */
async function loadOrt(): Promise<Ort> {
  ortPromise ??= import(/* @vite-ignore */ `${ORT_CDN}ort.webgpu.min.mjs`).then((m) => {
    const ort = m as unknown as Ort;
    ort.env.wasm.wasmPaths = ORT_CDN;
    return ort;
  });
  return ortPromise;
}

export class RifeInterpolator {
  private session: Session | null = null;
  private ort: Ort | null = null;
  name = '';

  static async hasStoredModel(): Promise<boolean> {
    return !!(await idb.get<ArrayBuffer>('library', MODEL_KEY).catch(() => undefined));
  }

  static async storeModel(file: File): Promise<void> {
    await idb.put('library', MODEL_KEY, await file.arrayBuffer());
    await idb.put('library', MODEL_KEY + '-name', file.name);
  }

  async load(): Promise<boolean> {
    if (this.session) return true;
    const bytes = await idb.get<ArrayBuffer>('library', MODEL_KEY).catch(() => undefined);
    if (!bytes) return false;
    this.name = (await idb.get<string>('library', MODEL_KEY + '-name').catch(() => undefined)) ?? 'RIFE';
    this.ort = await loadOrt();
    this.session = await this.ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['webgpu', 'wasm'] });
    return true;
  }

  async interpolate(a: ImageBitmap, b: ImageBitmap, t: number, maxWidth = 960): Promise<ImageBitmap> {
    if (!(await this.load()) || !this.session || !this.ort) throw new Error('No RIFE model loaded.');
    const ort = this.ort;
    const w = Math.min(a.width, maxWidth);
    const h = Math.round((a.height / a.width) * w);
    const pw = Math.ceil(w / 64) * 64;
    const ph = Math.ceil(h / 64) * 64;
    const planes = (bmp: ImageBitmap) => {
      const c = new OffscreenCanvas(pw, ph);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0, w, h);
      const d = g.getImageData(0, 0, pw, ph).data;
      const out = new Float32Array(3 * pw * ph);
      for (let i = 0; i < pw * ph; i++) {
        out[i] = d[i * 4] / 255;
        out[pw * ph + i] = d[i * 4 + 1] / 255;
        out[2 * pw * ph + i] = d[i * 4 + 2] / 255;
      }
      return out;
    };
    const p0 = planes(a);
    const p1 = planes(b);
    const names = this.session.inputNames;
    const feeds: Record<string, import('onnxruntime-web').Tensor> = {};
    if (names.length >= 2) {
      feeds[names[0]] = new ort.Tensor('float32', p0, [1, 3, ph, pw]);
      feeds[names[1]] = new ort.Tensor('float32', p1, [1, 3, ph, pw]);
      if (names[2]) {
        const meta = (this.session as unknown as { inputMetadata?: Array<{ shape?: unknown[] }> }).inputMetadata?.[2];
        const scalar = Array.isArray(meta?.shape) && meta!.shape.length <= 1;
        feeds[names[2]] = scalar ? new ort.Tensor('float32', new Float32Array([t]), [1]) : new ort.Tensor('float32', new Float32Array(pw * ph).fill(t), [1, 1, ph, pw]);
      }
    } else {
      const cat = new Float32Array(7 * pw * ph);
      cat.set(p0, 0);
      cat.set(p1, 3 * pw * ph);
      cat.fill(t, 6 * pw * ph);
      feeds[names[0]] = new ort.Tensor('float32', cat, [1, 7, ph, pw]);
    }
    const res = await this.session.run(feeds);
    const out = res[this.session.outputNames[0]].data as Float32Array;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * pw + x;
        const o = (y * w + x) * 4;
        img.data[o] = out[i] * 255;
        img.data[o + 1] = out[pw * ph + i] * 255;
        img.data[o + 2] = out[2 * pw * ph + i] * 255;
        img.data[o + 3] = 255;
      }
    }
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.transferToImageBitmap();
  }
}
