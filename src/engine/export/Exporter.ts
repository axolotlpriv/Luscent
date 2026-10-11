/**
 * Offline export: renders every frame with a dedicated WebGL2 compositor
 * (exact source frames, optical flow awaited), encodes with WebCodecs and
 * muxes MP4 (H.264 + AAC/Opus), WebM (VP9 + Opus) or encodes a GIF.
 */
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { Id, Project } from '../../core/model/types';
import { frameCount, videoCodecCandidates, type ExportSettings } from '../../core/export/settings';
import type { MediaEngine } from '../media/MediaEngine';
import { OfflineRenderer } from './OfflineRenderer';
import { mixdown } from './audioMix';

export interface ExportProgress {
  phase: 'preparing' | 'video' | 'audio' | 'finishing';
  frame: number;
  frames: number;
  /** 0..1 overall. */
  progress: number;
  etaSeconds: number | null;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  videoCodec: string | null;
  audioCodec: string | null;
  seconds: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
  }
}

async function pickVideoConfig(s: ExportSettings): Promise<VideoEncoderConfig> {
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser has no WebCodecs VideoEncoder; try Chrome, Edge or Safari 17+.');
  for (const codec of videoCodecCandidates(s.format, s.width, s.height, s.fps)) {
    const cfg: VideoEncoderConfig = {
      codec,
      width: s.width,
      height: s.height,
      bitrate: s.videoBitrate,
      framerate: s.fps,
      latencyMode: 'quality',
      ...(codec.startsWith('avc1') ? { avc: { format: 'avc' as const } } : {}),
    };
    const sup = await VideoEncoder.isConfigSupported(cfg).catch(() => null);
    if (sup?.supported) return sup.config ?? cfg;
  }
  throw new Error(`No supported ${s.format === 'webm' ? 'VP9/VP8' : 'H.264'} encoder for ${s.width}×${s.height} @ ${s.fps}fps in this browser.`);
}

async function pickAudioConfig(format: 'mp4' | 'webm', sampleRate: number, bitrate: number): Promise<{ cfg: AudioEncoderConfig; muxCodec: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const tries: Array<{ codec: string; muxCodec: 'aac' | 'opus' }> = format === 'mp4' ? [{ codec: 'mp4a.40.2', muxCodec: 'aac' }, { codec: 'opus', muxCodec: 'opus' }] : [{ codec: 'opus', muxCodec: 'opus' }];
  for (const t of tries) {
    const cfg: AudioEncoderConfig = { codec: t.codec, sampleRate, numberOfChannels: 2, bitrate };
    const sup = await AudioEncoder.isConfigSupported(cfg).catch(() => null);
    if (sup?.supported) return { cfg, muxCodec: t.muxCodec };
  }
  return null;
}

export async function exportComposition(
  project: Project,
  compId: Id,
  s: ExportSettings,
  media: MediaEngine,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const comp = project.compositions[compId];
  if (!comp) throw new Error('Composition not found.');
  const t0 = performance.now();
  const total = frameCount(s);
  const scale = s.width / comp.width;
  const off = await OfflineRenderer.create(project, compId, media, scale, s.flowEngine ?? 'farneback');
  const canvas = off.canvas;
  const report = (phase: ExportProgress['phase'], frame: number, progress: number) => {
    const el = (performance.now() - t0) / 1000;
    onProgress({ phase, frame, frames: total, progress, etaSeconds: progress > 0.02 ? (el / progress) * (1 - progress) : null });
  };
  const check = () => {
    if (signal?.aborted) throw new ExportCancelled();
  };
  report('preparing', 0, 0);
  try {
    if (s.format === 'gif') {
      const gif = GIFEncoder();
      const delay = Math.round(1000 / s.fps);
      for (let i = 0; i < total; i++) {
        check();
        const t = s.start + i / s.fps;
        await off.render(t);
        const img = off.readPixels();
        const rgba = img.data;
        const palette = quantize(rgba, s.gifColors, { format: 'rgb565' });
        gif.writeFrame(applyPalette(rgba, palette, 'rgb565'), s.width, s.height, { palette, delay, repeat: 0 });
        report('video', i + 1, (i + 1) / total);
        if (i % 4 === 0) await new Promise((r) => setTimeout(r));
      }
      gif.finish();
      const bytes = gif.bytes();
      return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/gif' }), mimeType: 'image/gif', extension: 'gif', videoCodec: 'gif', audioCodec: null, seconds: (performance.now() - t0) / 1000 };
    }

    const vcfg = await pickVideoConfig(s);
    const audioBuf = s.audio ? await mixdown(project, compId, s.start, s.end, media) : null;
    const acfg = audioBuf ? await pickAudioConfig(s.format, audioBuf.sampleRate, s.audioBitrate) : null;
    const mp4 = s.format === 'mp4';
    const target = mp4 ? new Mp4Target() : new WebmTarget();
    const muxer = mp4
      ? new Mp4Muxer({
          target: target as Mp4Target,
          video: { codec: vcfg.codec.startsWith('avc1') ? 'avc' : 'vp9', width: s.width, height: s.height, frameRate: s.fps },
          audio: acfg ? { codec: acfg.muxCodec, sampleRate: audioBuf!.sampleRate, numberOfChannels: 2 } : undefined,
          fastStart: 'in-memory',
          firstTimestampBehavior: 'offset',
        })
      : new WebmMuxer({
          target: target as WebmTarget,
          video: { codec: vcfg.codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9', width: s.width, height: s.height, frameRate: s.fps },
          audio: acfg ? { codec: 'A_OPUS', sampleRate: audioBuf!.sampleRate, numberOfChannels: 2 } : undefined,
          firstTimestampBehavior: 'offset',
        });
    let encodeError: Error | null = null;
    const venc = new VideoEncoder({
      output: (chunk, meta) => (muxer as Mp4Muxer<Mp4Target>).addVideoChunk(chunk, meta),
      error: (e) => (encodeError = e as Error),
    });
    venc.configure(vcfg);
    const frameDur = 1e6 / s.fps;
    const keyEvery = Math.max(1, Math.round(s.fps * 2));
    for (let i = 0; i < total; i++) {
      check();
      if (encodeError) throw encodeError;
      const t = s.start + i / s.fps;
      await off.render(t);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) });
      venc.encode(vf, { keyFrame: i % keyEvery === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
      report('video', i + 1, ((i + 1) / total) * (acfg ? 0.92 : 0.98));
    }
    await venc.flush();
    venc.close();
    if (encodeError) throw encodeError;

    if (acfg && audioBuf) {
      report('audio', total, 0.93);
      const aenc = new AudioEncoder({
        output: (chunk, meta) => (muxer as Mp4Muxer<Mp4Target>).addAudioChunk(chunk, meta),
        error: (e) => (encodeError = e as Error),
      });
      aenc.configure(acfg.cfg);
      const block = 1024;
      const L = audioBuf.getChannelData(0);
      const R = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : L;
      for (let off = 0; off < audioBuf.length; off += block) {
        check();
        const n = Math.min(block, audioBuf.length - off);
        const planar = new Float32Array(n * 2);
        planar.set(L.subarray(off, off + n), 0);
        planar.set(R.subarray(off, off + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: audioBuf.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / audioBuf.sampleRate) * 1e6), data: planar });
        aenc.encode(ad);
        ad.close();
        if (aenc.encodeQueueSize > 32) await new Promise((r) => setTimeout(r, 1));
      }
      await aenc.flush();
      aenc.close();
      if (encodeError) throw encodeError;
    }
    report('finishing', total, 0.99);
    muxer.finalize();
    const buffer = (target as Mp4Target).buffer;
    const mimeType = mp4 ? 'video/mp4' : 'video/webm';
    report('finishing', total, 1);
    return { blob: new Blob([buffer], { type: mimeType }), mimeType, extension: mp4 ? 'mp4' : 'webm', videoCodec: vcfg.codec, audioCodec: acfg?.cfg.codec ?? null, seconds: (performance.now() - t0) / 1000 };
  } finally {
    off.dispose();
  }
}
