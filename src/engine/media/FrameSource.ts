/**
 * Frame-exact access to video frames (by frame index), for optical-flow
 * interpolation and export. Each media item gets a dedicated decoder
 * element; requests are serialised and results cached (LRU).
 */
import type { Id } from '../../core/model/types';
import type { MediaEngine } from './MediaEngine';

interface Decoder {
  el: HTMLVideoElement;
  queue: Promise<unknown>;
}

const CACHE_LIMIT = 32;

function waitEvent(el: HTMLMediaElement, ev: string, timeout = 4000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, timeout);
    function done() {
      clearTimeout(t);
      el.removeEventListener(ev, done);
      resolve();
    }
    el.addEventListener(ev, done, { once: true });
  });
}

export class FrameSource {
  private decoders = new Map<Id, Decoder>();
  private cache = new Map<string, ImageBitmap>();
  private inflight = new Map<string, Promise<ImageBitmap | null>>();

  constructor(private readonly media: MediaEngine) {}

  private decoder(mediaId: Id): Decoder | null {
    let d = this.decoders.get(mediaId);
    if (d) return d;
    const url = this.media.url(mediaId);
    if (!url) return null;
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.src = url;
    d = { el, queue: waitEvent(el, 'loadeddata', 15000) };
    this.decoders.set(mediaId, d);
    return d;
  }

  cached(mediaId: Id, index: number): ImageBitmap | null {
    const k = `${mediaId}|${index}`;
    const b = this.cache.get(k);
    if (b) {
      this.cache.delete(k);
      this.cache.set(k, b);
    }
    return b ?? null;
  }

  /** Decode frame `index` (frames are 1/fps long, sampled at their centre). */
  frame(mediaId: Id, index: number, fps: number): Promise<ImageBitmap | null> {
    const k = `${mediaId}|${index}`;
    const hit = this.cached(mediaId, index);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const d = this.decoder(mediaId);
    if (!d) return Promise.resolve(null);
    const job = d.queue.then(async () => {
      const el = d.el;
      const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
      const t = Math.min(Math.max(0, (index + 0.5) / fps), Math.max(0, dur - 0.5 / fps));
      if (Math.abs(el.currentTime - t) > 1e-4) {
        el.currentTime = t;
        await waitEvent(el, 'seeked');
      }
      if ('requestVideoFrameCallback' in el) {
        await Promise.race([new Promise<void>((r) => el.requestVideoFrameCallback(() => r())), new Promise<void>((r) => setTimeout(r, 40))]);
      }
      if (el.readyState < 2) return null;
      const bmp = await createImageBitmap(el).catch(() => null);
      if (bmp) {
        this.cache.set(k, bmp);
        while (this.cache.size > CACHE_LIMIT) {
          const [ok, ob] = this.cache.entries().next().value!;
          ob.close();
          this.cache.delete(ok);
        }
      }
      return bmp;
    });
    d.queue = job.catch(() => null);
    this.inflight.set(k, job);
    void job.finally(() => this.inflight.delete(k));
    return job;
  }

  dispose(): void {
    for (const d of this.decoders.values()) {
      d.el.removeAttribute('src');
      d.el.load();
    }
    this.decoders.clear();
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
  }
}

/** Measure a video's frame rate with requestVideoFrameCallback (fallback 30). */
export async function measureFps(el: HTMLVideoElement): Promise<number> {
  if (!('requestVideoFrameCallback' in el)) return 30;
  const times: number[] = [];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const cb = (_now: number, meta: VideoFrameCallbackMetadata) => {
      times.push(meta.mediaTime);
      if (times.length >= 10) {
        clearTimeout(timer);
        resolve();
      } else el.requestVideoFrameCallback(cb);
    };
    el.requestVideoFrameCallback(cb);
    el.play().catch(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  el.pause();
  const diffs = times
    .slice(1)
    .map((t, i) => t - times[i])
    .filter((d) => d > 0.001 && d < 0.2)
    .sort((a, b) => a - b);
  if (diffs.length < 3) return 30;
  const fps = 1 / diffs[diffs.length >> 1];
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
  const best = common.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
  return Math.abs(best - fps) / best < 0.03 ? best : Math.round(fps * 100) / 100;
}
