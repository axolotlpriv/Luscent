/// <reference lib="webworker" />
/**
 * Audio analysis worker: waveform peak pyramid + beat/onset detection.
 * Channel data is transferred in, results are transferred back.
 */
import { analyzeAudio } from '../core/audio/beats';
import { computePeaks, mixToMono } from '../core/audio/waveform';

export interface AnalysisRequest {
  id: string;
  sampleRate: number;
  channels: Float32Array[];
}

export interface AnalysisResponse {
  id: string;
  peaks: ReturnType<typeof computePeaks>;
  analysis: ReturnType<typeof analyzeAudio>;
  error?: string;
}

/** Analyse at ~22 kHz: plenty for onsets, and 2x faster. */
function decimate(mono: Float32Array, sr: number): { data: Float32Array; sr: number } {
  const factor = Math.max(1, Math.floor(sr / 22050));
  if (factor === 1) return { data: mono, sr };
  const n = Math.floor(mono.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += mono[i * factor + j];
    out[i] = s / factor;
  }
  return { data: out, sr: sr / factor };
}

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, sampleRate, channels } = e.data;
  try {
    const mono = mixToMono(channels);
    const peaks = computePeaks(mono, sampleRate);
    const d = decimate(mono, sampleRate);
    const analysis = analyzeAudio(d.data, d.sr);
    const transfer = peaks.levels.map((l) => l.data.buffer);
    (self as unknown as Worker).postMessage({ id, peaks, analysis } satisfies AnalysisResponse, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
