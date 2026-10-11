import { memo, useEffect, useRef } from 'react';
import { pickLevel } from '../../core/audio/waveform';
import { mediaEngine } from '../../engine/media/MediaEngine';
import { useEditor } from '../../state/store';
import type { Id } from '../../core/model/types';

interface Props {
  mediaId: Id;
  /** Source seconds at the bar's left edge. */
  sourceStart: number;
  /** Bar width in px (the drawn region is clipped to the visible window). */
  width: number;
  height: number;
  pxPerSec: number;
  /** Visible px range inside the bar (to avoid drawing huge canvases). */
  visibleFrom: number;
  visibleTo: number;
  color: string;
}

/** Min/max waveform drawn from the peak pyramid, only for the visible span. */
export const Waveform = memo(function Waveform({ mediaId, sourceStart, width, height, pxPerSec, visibleFrom, visibleTo, color }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mediaVersion = useEditor((s) => s.mediaVersion);
  const from = Math.max(0, Math.floor(visibleFrom));
  const to = Math.min(width, Math.ceil(visibleTo));
  const w = Math.max(0, to - from);

  useEffect(() => {
    const c = ref.current;
    if (!c || w <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(height * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${height}px`;
    c.style.left = `${from}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const peaks = mediaEngine.peaksOf(mediaId);
    if (!peaks) return;
    const spp = peaks.sampleRate / pxPerSec;
    const level = pickLevel(peaks, spp);
    const data = level.data;
    const buckets = data.length / 2;
    const mid = height / 2;
    ctx.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const t0 = sourceStart + (from + x) / pxPerSec;
      const t1 = t0 + 1 / pxPerSec;
      if (t1 < 0) continue;
      let b0 = Math.floor((t0 * peaks.sampleRate) / level.samplesPerBucket);
      let b1 = Math.ceil((t1 * peaks.sampleRate) / level.samplesPerBucket);
      b0 = Math.max(0, b0);
      b1 = Math.min(buckets, Math.max(b0 + 1, b1));
      if (b0 >= buckets) break;
      let mn = 1;
      let mx = -1;
      for (let b = b0; b < b1; b++) {
        if (data[b * 2] < mn) mn = data[b * 2];
        if (data[b * 2 + 1] > mx) mx = data[b * 2 + 1];
      }
      if (mn > mx) continue;
      const y0 = mid - mx * mid * 0.95;
      const y1 = mid - mn * mid * 0.95;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [mediaId, sourceStart, from, w, height, pxPerSec, color, mediaVersion]);

  if (w <= 0) return null;
  return <canvas ref={ref} className="wave" />;
});
