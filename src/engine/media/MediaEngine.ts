/**
 * Runtime media resources: blobs, object URLs, decoded stills, decoded audio,
 * waveform peaks. The project model only stores serialisable MediaItems; this
 * engine owns everything heavy and is keyed by media id.
 */
import { uid } from '../../core/model/ids';
import type { AudioAnalysis, Id, MediaItem, MediaKind } from '../../core/model/types';
import type { Peaks } from '../../core/audio/waveform';
import type { AnalysisRequest, AnalysisResponse } from '../../workers/audioAnalysis.worker';
import { getAudioContext } from './audioContext';
import { measureFps } from './FrameSource';
import { loadStoredProxy } from '../export/proxy';

export type MediaStatus = 'loading' | 'ready' | 'error' | 'missing';

const EXT_KIND: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', bmp: 'image', svg: 'image',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio',
};

export function detectKind(name: string, mime: string): MediaKind | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_KIND[ext] ?? null;
}

function waitFor(el: HTMLMediaElement, event: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    const ok = () => cleanup();
    const fail = () => cleanup(new Error(el.error?.message || 'This media format is not supported by the browser.'));
    function cleanup(err?: Error) {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', fail);
      if (err) reject(err);
      else resolve();
    }
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', fail, { once: true });
  });
}

class AnalysisClient {
  private worker: Worker | null = null;
  private pending = new Map<string, (r: AnalysisResponse) => void>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../../workers/audioAnalysis.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
        const cb = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        cb?.(e.data);
      };
    }
    return this.worker;
  }

  run(buffer: AudioBuffer): Promise<AnalysisResponse> {
    const id = uid('an_');
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
    const req: AnalysisRequest = { id, sampleRate: buffer.sampleRate, channels };
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ensure().postMessage(req, channels.map((c) => c.buffer));
    });
  }
}

export class MediaEngine {
  private blobs = new Map<Id, Blob>();
  private urls = new Map<Id, string>();
  private images = new Map<Id, ImageBitmap>();
  private audio = new Map<Id, AudioBuffer>();
  private peaks = new Map<Id, Peaks>();
  private status = new Map<Id, MediaStatus>();
  private errors = new Map<Id, string>();
  private proxies = new Map<Id, string>();
  /** Proxy build progress 0..1 while transcoding. */
  readonly proxyProgress = new Map<Id, number>();
  private listeners = new Set<() => void>();
  private analysis = new AnalysisClient();
  version = 0;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  url(id: Id): string | null {
    return this.urls.get(id) ?? null;
  }
  /** URL for preview playback: the proxy when enabled and available. */
  playbackUrl(id: Id, useProxy: boolean): string | null {
    return (useProxy ? this.proxies.get(id) : undefined) ?? this.urls.get(id) ?? null;
  }
  hasProxy(id: Id): boolean {
    return this.proxies.has(id);
  }
  setProxy(id: Id, blob: Blob): void {
    const old = this.proxies.get(id);
    if (old) URL.revokeObjectURL(old);
    this.proxies.set(id, URL.createObjectURL(blob));
    this.notify();
  }
  setProxyProgress(id: Id, p: number | null): void {
    if (p === null) this.proxyProgress.delete(id);
    else this.proxyProgress.set(id, p);
    this.notify();
  }
  blob(id: Id): Blob | null {
    return this.blobs.get(id) ?? null;
  }
  image(id: Id): ImageBitmap | null {
    return this.images.get(id) ?? null;
  }
  audioBuffer(id: Id): AudioBuffer | null {
    return this.audio.get(id) ?? null;
  }
  peaksOf(id: Id): Peaks | null {
    return this.peaks.get(id) ?? null;
  }
  statusOf(id: Id): MediaStatus {
    return this.status.get(id) ?? 'missing';
  }
  errorOf(id: Id): string | null {
    return this.errors.get(id) ?? null;
  }

  /** Mark an item as about to load (so the UI doesn't flash "missing"). */
  markPending(id: Id): void {
    if (!this.status.has(id)) this.status.set(id, 'loading');
  }

  /** Mark an item whose file isn't available in this browser. */
  markMissing(id: Id): void {
    this.status.set(id, 'missing');
    this.notify();
  }

  private setBlob(id: Id, blob: Blob): string {
    this.blobs.set(id, blob);
    const old = this.urls.get(id);
    if (old) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);
    return url;
  }

  private async decodeAudio(blob: Blob): Promise<AudioBuffer | null> {
    try {
      const bytes = await blob.arrayBuffer();
      return await getAudioContext().decodeAudioData(bytes);
    } catch {
      return null;
    }
  }

  /** Inspect a file and create its MediaItem. Registers the blob. */
  async probe(file: File): Promise<MediaItem> {
    const kind = detectKind(file.name, file.type);
    if (!kind) throw new Error(`Unsupported file type: ${file.name}`);
    const id = uid('med_');
    const item: MediaItem = {
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      kind,
      mimeType: file.type,
      size: file.size,
      width: 0,
      height: 0,
      duration: Infinity,
      fps: 0,
      hasAudio: false,
      analysis: null,
    };
    const url = this.setBlob(id, file);
    this.status.set(id, 'loading');
    try {
      if (kind === 'image') {
        const bmp = await createImageBitmap(file, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' });
        item.width = bmp.width;
        item.height = bmp.height;
        this.images.set(id, bmp);
      } else if (kind === 'video') {
        const el = document.createElement('video');
        el.preload = 'metadata';
        el.muted = true;
        el.src = url;
        await waitFor(el, 'loadedmetadata');
        if (!Number.isFinite(el.duration)) {
          // Some WebM files only learn their duration after a far seek.
          el.currentTime = 1e9;
          await waitFor(el, 'durationchange', 5000).catch(() => undefined);
        }
        item.width = el.videoWidth;
        item.height = el.videoHeight;
        item.duration = Number.isFinite(el.duration) ? el.duration : 10;
        el.preload = 'auto';
        el.currentTime = 0;
        item.fps = await measureFps(el).catch(() => 30);
        el.removeAttribute('src');
        el.load();
        const buf = await this.decodeAudio(file);
        if (buf && buf.duration > 0) {
          item.hasAudio = true;
          this.audio.set(id, buf);
        }
      } else {
        const buf = await this.decodeAudio(file);
        if (!buf) throw new Error(`Could not decode audio: ${file.name}`);
        item.duration = buf.duration;
        item.hasAudio = true;
        this.audio.set(id, buf);
      }
    } catch (err) {
      this.release(id);
      throw err;
    }
    return item;
  }

  /**
   * Load runtime resources for an item (fresh import or project reload).
   * Calls `onAnalysis` when beat detection finishes for items lacking it.
   */
  async attach(item: MediaItem, blob: Blob, onAnalysis?: (id: Id, a: AudioAnalysis) => void): Promise<void> {
    const id = item.id;
    if (!this.blobs.has(id)) this.setBlob(id, blob);
    this.status.set(id, 'loading');
    this.notify();
    try {
      if (item.kind === 'image' && !this.images.has(id)) {
        this.images.set(id, await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' }));
      }
      if (item.hasAudio && !this.audio.has(id)) {
        const buf = await this.decodeAudio(blob);
        if (buf) this.audio.set(id, buf);
      }
      this.status.set(id, 'ready');
      if (item.kind === 'video' && !this.proxies.has(id)) {
        const proxy = await loadStoredProxy(id);
        if (proxy) this.setProxy(id, proxy);
      }
      this.notify();
      const buf = this.audio.get(id);
      if (buf && !this.peaks.has(id)) {
        const res = await this.analysis.run(buf);
        if (!res.error) {
          this.peaks.set(id, res.peaks);
          if (!item.analysis) onAnalysis?.(id, res.analysis);
          this.notify();
        }
      }
    } catch (err) {
      this.status.set(id, 'error');
      this.errors.set(id, String(err));
      this.notify();
    }
  }

  release(id: Id): void {
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.blobs.delete(id);
    this.images.get(id)?.close();
    this.images.delete(id);
    this.audio.delete(id);
    this.peaks.delete(id);
    this.status.delete(id);
    this.errors.delete(id);
    const px = this.proxies.get(id);
    if (px) URL.revokeObjectURL(px);
    this.proxies.delete(id);
    this.notify();
  }

  releaseAll(): void {
    for (const id of [...this.blobs.keys()]) this.release(id);
  }
}

export const mediaEngine = new MediaEngine();
