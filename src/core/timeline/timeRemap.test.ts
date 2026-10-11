import { describe, expect, it } from 'vitest';
import { createComposition, createMediaLayer } from '../model/factory';
import { sourceTimeOf } from '../render/evaluate';
import { disableTimeRemap, enableTimeRemap, freezeFrame, reverseLayer, setConstantSpeed } from './timeRemap';
import type { MediaItem } from '../model/types';

const media: MediaItem = { id: 'm', name: 'clip', kind: 'video', mimeType: 'video/mp4', size: 1, width: 1080, height: 1920, duration: 4, fps: 30, hasAudio: false, analysis: null };
const make = () => createMediaLayer({ comp: createComposition({ duration: 20 }), media, startTime: 1 });

describe('time remap', () => {
  it('enable keeps timing identical', () => {
    const l = make();
    enableTimeRemap(l);
    for (const t of [1, 2.5, 4.9]) expect(sourceTimeOf(l, t).time).toBeCloseTo(t - 1);
    expect(sourceTimeOf(l, 2).speed).toBeCloseTo(1);
  });

  it('constant speed slows down and extends the layer', () => {
    const l = make();
    setConstantSpeed(l, 0.25, media.duration);
    expect(l.outPoint).toBeCloseTo(1 + 16);
    expect(sourceTimeOf(l, 5).time).toBeCloseTo(1);
    expect(sourceTimeOf(l, 5).speed).toBeCloseTo(0.25);
  });

  it('freeze frame holds the current frame', () => {
    const l = make();
    freezeFrame(l, 2.5);
    expect(sourceTimeOf(l, 2).time).toBeCloseTo(1);
    expect(sourceTimeOf(l, 2.5).time).toBeCloseTo(1.5);
    expect(sourceTimeOf(l, 4).time).toBeCloseTo(1.5);
    expect(sourceTimeOf(l, 4).speed).toBeCloseTo(0);
  });

  it('reverse plays backwards', () => {
    const l = make();
    reverseLayer(l);
    expect(sourceTimeOf(l, 1).time).toBeCloseTo(4);
    expect(sourceTimeOf(l, 3).speed).toBeCloseTo(-1);
  });

  it('disable restores normal timing', () => {
    const l = make();
    reverseLayer(l);
    disableTimeRemap(l);
    expect(sourceTimeOf(l, 2).time).toBeCloseTo(1);
  });
});
