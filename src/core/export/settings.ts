/** Export settings, platform presets and codec selection (pure; tested). */
import type { Composition } from '../model/types';

export type ExportFormat = 'mp4' | 'webm' | 'gif';

export interface ExportSettings {
  format: ExportFormat;
  /** Output size; must keep the comp aspect (renderer scales uniformly). */
  width: number;
  height: number;
  fps: number;
  /** Comp-time range. */
  start: number;
  end: number;
  /** Video bitrate in bits/s (mp4/webm). */
  videoBitrate: number;
  audio: boolean;
  audioBitrate: number;
  /** GIF only: colours per frame (2..256). */
  gifColors: number;
  /** Optical-flow engine for frame-blended layers. */
  flowEngine?: 'farneback' | 'rife';
}

export interface ExportPreset {
  id: string;
  label: string;
  hint: string;
  format: ExportFormat;
  /** Target short side in pixels (null = composition size). */
  shortSide: number | null;
  fps: number | null;
  mbps: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'social-1080-30', label: 'TikTok · Reels · Shorts — 1080p 30fps', hint: 'H.264 MP4, 9:16 friendly, ~12 Mbps', format: 'mp4', shortSide: 1080, fps: 30, mbps: 12 },
  { id: 'social-1080-60', label: 'TikTok · Reels · Shorts — 1080p 60fps', hint: 'H.264 MP4, smooth motion, ~20 Mbps', format: 'mp4', shortSide: 1080, fps: 60, mbps: 20 },
  { id: 'social-4k-60', label: '4K 60fps master', hint: 'H.264 MP4 2160p60, ~60 Mbps', format: 'mp4', shortSide: 2160, fps: 60, mbps: 60 },
  { id: 'source', label: 'Composition settings', hint: 'Comp size and frame rate, H.264 MP4', format: 'mp4', shortSide: null, fps: null, mbps: 16 },
  { id: 'webm-1080', label: 'WebM VP9 — 1080p', hint: 'VP9 + Opus, great for the web', format: 'webm', shortSide: 1080, fps: null, mbps: 10 },
  { id: 'gif-480', label: 'GIF — 480px 15fps', hint: 'Looping GIF for previews / stickers', format: 'gif', shortSide: 480, fps: 15, mbps: 0 },
];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output dimensions for a target short side, preserving the comp aspect. */
export function outputSize(comp: Pick<Composition, 'width' | 'height'>, shortSide: number | null): { width: number; height: number } {
  if (!shortSide) return { width: even(comp.width), height: even(comp.height) };
  const s = shortSide / Math.min(comp.width, comp.height);
  return { width: even(comp.width * s), height: even(comp.height * s) };
}

export function settingsFromPreset(p: ExportPreset, comp: Composition, range: 'work' | 'comp' = 'work'): ExportSettings {
  const { width, height } = outputSize(comp, p.shortSide);
  const start = range === 'work' ? comp.workArea.start : 0;
  const end = range === 'work' ? comp.workArea.end : comp.duration;
  return {
    format: p.format,
    width,
    height,
    fps: p.fps ?? comp.fps,
    start,
    end,
    videoBitrate: p.mbps * 1e6,
    audio: p.format !== 'gif',
    audioBitrate: 192_000,
    gifColors: 256,
  };
}

export function frameCount(s: Pick<ExportSettings, 'start' | 'end' | 'fps'>): number {
  return Math.max(1, Math.round((s.end - s.start) * s.fps));
}

/** H.264 level from macroblocks/sec (and frame size). */
export function avcLevel(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * fps;
  const table: Array<[number, number, number]> = [
    // level, max frame MBs, max MB/s
    [31, 3600, 108000],
    [40, 8192, 245760],
    [42, 8704, 522240],
    [50, 22080, 589824],
    [51, 36864, 983040],
    [52, 36864, 2073600],
  ];
  for (const [lvl, fs, mbps] of table) if (mbs <= fs && rate <= mbps) return lvl;
  return 52;
}

/** Codec strings to try, best first. */
export function videoCodecCandidates(format: ExportFormat, width: number, height: number, fps: number): string[] {
  if (format === 'webm') {
    const big = width * height > 2_100_000;
    return [big ? 'vp09.00.51.08' : 'vp09.00.40.08', 'vp09.00.10.08', 'vp8'];
  }
  const lvl = avcLevel(width, height, fps).toString(16).padStart(2, '0').toUpperCase();
  // High, Main, Constrained Baseline; VP9-in-MP4 when no H.264 encoder exists
  // (e.g. open-source Chromium builds).
  const vp9 = width * height > 2_100_000 ? 'vp09.00.51.08' : 'vp09.00.40.08';
  return [`avc1.6400${lvl}`, `avc1.4D00${lvl}`, `avc1.4200${lvl}`, `avc1.42E0${lvl}`, vp9];
}

export function estimateBytes(s: ExportSettings): number {
  const dur = s.end - s.start;
  if (s.format === 'gif') return s.width * s.height * frameCount(s) * 0.35;
  return ((s.videoBitrate + (s.audio ? s.audioBitrate : 0)) * dur) / 8;
}
