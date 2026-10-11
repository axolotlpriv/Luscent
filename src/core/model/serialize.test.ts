import { describe, expect, it } from 'vitest';
import { createProject } from './factory';
import { deserializeProject, serializeProject } from './serialize';

describe('project serialization', () => {
  it('round-trips including non-finite numbers', () => {
    const p = createProject('Test');
    p.media.img = {
      id: 'img', name: 'pic', kind: 'image', mimeType: 'image/png', size: 10, width: 10, height: 10,
      duration: Infinity, fps: 0, hasAudio: false, analysis: null,
    };
    p.mediaOrder.push('img');
    const back = deserializeProject(serializeProject(p));
    expect(back.media.img.duration).toBe(Infinity);
    expect(back.name).toBe('Test');
    expect(back.compositions[back.mainCompId]).toBeTruthy();
  });
  it('rejects foreign JSON', () => {
    expect(() => deserializeProject('{"hello":1}')).toThrow();
  });
});
