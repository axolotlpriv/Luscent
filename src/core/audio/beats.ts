/**
 * Beat & onset detection for beat-snapping.
 *
 *  1. Onset strength envelope: log-magnitude spectral flux at ~100 Hz.
 *  2. Onsets: adaptive-threshold peak picking on the envelope.
 *  3. Tempo: autocorrelation of the envelope weighted by a log-normal prior
 *     around 120 BPM (avoids most octave errors for pop / edit music).
 *  4. Beats: dynamic-programming beat tracker (Ellis, 2007) that trades off
 *     onset strength against deviation from the estimated period.
 *
 * Pure and synchronous; run it in a worker for long files.
 */
import { FFT } from './fft';
import type { AudioAnalysis } from '../model/types';

export interface OnsetEnvelope {
  /** Envelope frames per second. */
  rate: number;
  /** Seconds offset of frame 0. */
  offset: number;
  env: Float32Array;
  /** Std-dev of the raw (detrended) flux: how much rhythmic energy exists at all. */
  strength: number;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function onsetEnvelope(mono: Float32Array, sampleRate: number): OnsetEnvelope {
  const hop = Math.max(1, Math.round(sampleRate / 100));
  const size = nextPow2(Math.round(sampleRate * 0.023));
  const fft = new FFT(size);
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  const bins = size / 2;
  const frames = Math.max(0, Math.floor((mono.length - size) / hop) + 1);
  const env = new Float32Array(frames);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < size; i++) {
      re[i] = mono[off + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0 && f > 0) flux += d;
    }
    env[f] = flux;
    const t = prev;
    prev = cur;
    cur = t;
  }
  // Remove slow trend (local mean over ~0.5 s) and half-wave rectify.
  const out = new Float32Array(frames);
  const w = 25;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.min(frames, w); i++) {
    sum += env[i];
    count++;
  }
  for (let i = 0; i < frames; i++) {
    const add = i + w;
    const rem = i - w - 1;
    if (add < frames) {
      sum += env[add];
      count++;
    }
    if (rem >= 0) {
      sum -= env[rem];
      count--;
    }
    out[i] = Math.max(0, env[i] - sum / count);
  }
  // Normalise to unit standard deviation.
  let mean = 0;
  for (const v of out) mean += v;
  mean /= Math.max(1, frames);
  let varr = 0;
  for (const v of out) varr += (v - mean) * (v - mean);
  const std = Math.sqrt(varr / Math.max(1, frames));
  for (let i = 0; i < frames; i++) out[i] /= std || 1;
  return { rate: sampleRate / hop, offset: size / 2 / sampleRate, env: out, strength: std };
}

export function pickOnsets(o: OnsetEnvelope, threshold = 1.5, minGap = 0.06): number[] {
  const { env, rate, offset } = o;
  const r = Math.max(1, Math.round(0.05 * rate));
  const res: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i];
    if (v < threshold) continue;
    let isMax = true;
    let localSum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 3 * r); j <= Math.min(env.length - 1, i + 3 * r); j++) {
      if (Math.abs(j - i) <= r && env[j] > v) {
        isMax = false;
        break;
      }
      localSum += env[j];
      n++;
    }
    if (!isMax || v < localSum / n + threshold * 0.5) continue;
    const t = i / rate + offset;
    if (t - last < minGap) continue;
    res.push(t);
    last = t;
  }
  return res;
}

/** Estimate the beat period (in envelope frames). */
export function estimatePeriod(o: OnsetEnvelope, minBpm = 60, maxBpm = 200): number {
  const { env, rate } = o;
  const minLag = Math.floor((60 / maxBpm) * rate);
  const maxLag = Math.ceil((60 / minBpm) * rate);
  const n = env.length;
  const acf = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    acf[lag] = s / Math.max(1, n - lag);
  }
  const centerLag = (60 / 120) * rate;
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const oct = Math.log2(lag / centerLag);
    const weight = Math.exp(-0.5 * (oct / 0.9) ** 2);
    const score = acf[lag] * weight;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement on the raw ACF.
  const a = acf[best - 1];
  const b = acf[best];
  const c = acf[best + 1];
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return best + Math.max(-0.5, Math.min(0.5, delta));
}

/** Ellis dynamic-programming beat tracker. Returns beat times in seconds. */
export function trackBeats(o: OnsetEnvelope, period: number, tightness = 100): number[] {
  const { env, rate, offset } = o;
  const n = env.length;
  if (n === 0) return [];
  // Smooth onsets with a gaussian ~ period/32 wide.
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(3 * sigma);
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -radius; j <= radius; j++) {
      const k = i + j;
      if (k >= 0 && k < n) s += env[k] * Math.exp(-0.5 * (j / sigma) ** 2);
    }
    local[i] = s;
  }
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let arg = -1;
    for (let p = i - hi; p <= i - lo; p++) {
      if (p < 0) continue;
      const pen = -tightness * Math.log((i - p) / period) ** 2;
      const v = score[p] + pen;
      if (arg < 0 || v > best) {
        best = v;
        arg = p;
      }
    }
    score[i] = local[i] + (arg >= 0 ? best : 0);
    back[i] = arg;
  }
  // Start the backtrace from the best-scoring frame in the final period.
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) {
    if (score[i] > bestEnd) {
      bestEnd = score[i];
      end = i;
    }
  }
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) {
    beats.push(i / rate + offset);
    if (back[i] < 0) break;
  }
  beats.reverse();
  return beats;
}

/** Below this raw flux strength there are no real transients (silence, pads, tones). */
const MIN_STRENGTH = 1.5;

/** How strongly the envelope repeats at the chosen period (0..1). */
export function periodicity(o: OnsetEnvelope, period: number): number {
  const e = o.env;
  const n = e.length;
  const lag = Math.round(period);
  if (n <= lag + 1) return 0;
  let a0 = 0;
  for (let i = 0; i < n; i++) a0 += e[i] * e[i];
  a0 /= n;
  let a = 0;
  for (let i = lag; i < n; i++) a += e[i] * e[i - lag];
  a /= n - lag;
  return a0 > 0 ? Math.min(1, Math.max(0, (a / a0 - 0.2) / 0.6)) : 0;
}

export function analyzeAudio(mono: Float32Array, sampleRate: number): AudioAnalysis {
  const empty: AudioAnalysis = { bpm: 0, beats: [], onsets: [], confidence: 0 };
  const o = onsetEnvelope(mono, sampleRate);
  if (o.env.length < 8 || o.strength < MIN_STRENGTH) return empty;
  const period = estimatePeriod(o);
  const bpm = (60 * o.rate) / period;
  const beats = trackBeats(o, period);
  const onsets = pickOnsets(o);
  return { bpm: Math.round(bpm * 10) / 10, beats, onsets, confidence: Math.round(periodicity(o, period) * 100) / 100 };
}
