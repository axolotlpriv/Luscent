import { describe, expect, it } from 'vitest';
import { createComposition } from '../model/factory';
import { avcLevel, EXPORT_PRESETS, frameCount, outputSize, settingsFromPreset, videoCodecCandidates } from './settings';

describe('export settings', () => {
  const vertical = createComposition({ width: 1080, height: 1920, fps: 30, duration: 15 });
  it('keeps aspect and even sizes', () => {
    expect(outputSize(vertical, 1080)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(vertical, 2160)).toEqual({ width: 2160, height: 3840 });
    expect(outputSize(createComposition({ width: 1001, height: 563 }), 720)).toEqual({ width: 1280, height: 720 });
  });
  it('builds settings from presets', () => {
    const s = settingsFromPreset(EXPORT_PRESETS.find((p) => p.id === 'social-4k-60')!, vertical, 'comp');
    expect([s.width, s.height, s.fps, s.end]).toEqual([2160, 3840, 60, 15]);
    expect(frameCount(s)).toBe(900);
  });
  it('picks H.264 levels that fit', () => {
    expect(avcLevel(1080, 1920, 30)).toBe(40);
    expect(avcLevel(1080, 1920, 60)).toBe(42);
    expect(avcLevel(2160, 3840, 30)).toBe(51);
    expect(avcLevel(2160, 3840, 60)).toBe(52);
    expect(videoCodecCandidates('mp4', 2160, 3840, 60)[0]).toBe('avc1.640034');
    expect(videoCodecCandidates('webm', 1080, 1920, 30)[0]).toBe('vp09.00.40.08');
  });
});
