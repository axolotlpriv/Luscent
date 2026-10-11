/**
 * Proxy media: low-resolution, all-intra-friendly transcodes used for
 * smooth preview of heavy footage (4K, high bitrate, long-GOP). Export
 * always reads the original.
 */
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';
import type { MediaItem } from '../../core/model/types';
import { FrameSource } from '../media/FrameSource';
import type { MediaEngine } from '../media/MediaEngine';
import { idb } from '../persist/db';

export const proxyKey = (id: string) => `proxy:${id}`;

export async function buildProxy(item: MediaItem, media: MediaEngine, onProgress: (p: number) => void, shortSide = 540): Promise<Blob> {
  if (item.kind !== 'video') throw new Error('Only video needs a proxy.');
  if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs is not available in this browser.');
  const s = Math.min(1, shortSide / Math.min(item.width, item.height));
  const w = Math.max(2, Math.round((item.width * s) / 2) * 2);
  const h = Math.max(2, Math.round((item.height * s) / 2) * 2);
  const fps = item.fps || 30;
  const total = Math.max(1, Math.floor(item.duration * fps));
  let codec = 'vp09.00.10.08';
  const sup = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 2_500_000, framerate: fps });
  if (!sup.supported) codec = 'vp8';
  const target = new WebmTarget();
  const muxer = new WebmMuxer({ target, video: { codec: codec === 'vp8' ? 'V_VP8' : 'V_VP9', width: w, height: h, frameRate: fps }, firstTimestampBehavior: 'offset' });
  let failure: Error | null = null;
  const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failure = e as Error) });
  // Short GOPs keep scrubbing snappy.
  enc.configure({ codec, width: w, height: h, bitrate: 2_500_000, framerate: fps });
  const frames = new FrameSource(media);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  try {
    for (let i = 0; i < total; i++) {
      if (failure) throw failure;
      const bmp = await frames.frame(item.id, i, fps);
      if (bmp) ctx.drawImage(bmp, 0, 0, w, h);
      const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % 10 === 0 });
      vf.close();
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
      onProgress((i + 1) / total);
    }
    await enc.flush();
    enc.close();
    muxer.finalize();
  } finally {
    frames.dispose();
  }
  const blob = new Blob([target.buffer], { type: 'video/webm' });
  await idb.put('media', proxyKey(item.id), blob).catch(() => undefined);
  return blob;
}

export async function loadStoredProxy(id: string): Promise<Blob | null> {
  return (await idb.get<Blob>('media', proxyKey(id)).catch(() => undefined)) ?? null;
}
