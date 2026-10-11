import { describe, expect, it } from 'vitest';
import { createProject } from './factory';
import { decodeLsp, encodeLsp, lspFileName } from './lsp';
import { serializeProject } from './serialize';
import type { MediaItem } from './types';

const item = (id: string): MediaItem => ({ id, name: id + '.mp4', kind: 'video', mimeType: 'video/mp4', size: 3, width: 1, height: 1, duration: Infinity, fps: 30, hasAudio: false, analysis: null });

describe('.lsp project files', () => {
  it('round-trips a project with embedded media, including Infinity', async () => {
    const p = createProject('Edit One');
    p.media = { a: item('a'), b: item('b') };
    p.mediaOrder = ['a', 'b'];
    const file = encodeLsp(p, [
      { id: 'a', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }) },
      { id: 'b', blob: new Blob([new Uint8Array([9, 8, 7, 6, 5])], { type: 'audio/wav' }) },
    ]);
    const out = await decodeLsp(file);
    expect(out.project.name).toBe('Edit One');
    expect(out.project.id).toBe(p.id);
    expect(out.project.media.a.duration).toBe(Infinity);
    expect([...new Uint8Array(await out.media.get('a')!.arrayBuffer())]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(await out.media.get('b')!.arrayBuffer())]).toEqual([9, 8, 7, 6, 5]);
    expect(out.media.get('b')!.type).toBe('audio/wav');
  });

  it('saves and opens without media', async () => {
    const p = createProject('No Media');
    const out = await decodeLsp(encodeLsp(p));
    expect(out.project.name).toBe('No Media');
    expect(out.media.size).toBe(0);
  });

  it('still opens legacy .luscent.json projects', async () => {
    const p = createProject('Old');
    const out = await decodeLsp(new Blob([serializeProject(p)], { type: 'application/json' }));
    expect(out.project.name).toBe('Old');
    expect(out.media.size).toBe(0);
  });

  it('rejects other files and damaged files', async () => {
    await expect(decodeLsp(new Blob(['hello world, not a project']))).rejects.toThrow(/not a Luscent project/);
    const file = encodeLsp(createProject());
    await expect(decodeLsp(file.slice(0, 20))).rejects.toThrow(/damaged/);
    await expect(decodeLsp(new Blob(['{"format":"something-else"}']))).rejects.toThrow(/Not a Luscent project/);
  });

  it('treats truncated media as missing rather than failing', async () => {
    const p = createProject();
    p.media = { a: item('a') };
    p.mediaOrder = ['a'];
    const file = encodeLsp(p, [{ id: 'a', blob: new Blob([new Uint8Array(100)]) }]);
    const out = await decodeLsp(file.slice(0, file.size - 50));
    expect(out.project.id).toBe(p.id);
    expect(out.media.has('a')).toBe(false);
  });

  it('names files .lsp and strips illegal characters', () => {
    expect(lspFileName('My: Edit/1?')).toBe('My Edit1.lsp');
    expect(lspFileName('   ')).toBe('Untitled Project.lsp');
  });
});
