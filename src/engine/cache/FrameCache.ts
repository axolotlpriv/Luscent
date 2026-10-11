/**
 * RAM preview: fully rendered frames of the work area kept as GPU-backed
 * ImageBitmaps, guaranteeing real-time playback of heavy comps (AE's RAM
 * preview). Invalidated whenever the project, composition or preview scale
 * changes.
 */
import type { Id, Project } from '../../core/model/types';

export class FrameCache {
  private frames = new Map<number, ImageBitmap>();
  private key: { project: Project | null; compId: Id | null; scale: number; fps: number } = { project: null, compId: null, scale: 0, fps: 0 };
  private bytes = 0;
  readonly budgetBytes: number;
  private listeners = new Set<() => void>();

  constructor(budgetMB = 1200) {
    this.budgetBytes = budgetMB * 1024 * 1024;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify() {
    for (const l of this.listeners) l();
  }

  /** Drop everything if the context changed; returns true when still valid. */
  validate(project: Project, compId: Id, scale: number, fps: number): boolean {
    const k = this.key;
    if (k.project === project && k.compId === compId && k.scale === scale && k.fps === fps) return true;
    if (this.frames.size) this.clear();
    this.key = { project, compId, scale, fps };
    return false;
  }

  has(frame: number): boolean {
    return this.frames.has(frame);
  }

  get(frame: number): ImageBitmap | null {
    return this.frames.get(frame) ?? null;
  }

  put(frame: number, bmp: ImageBitmap): boolean {
    const size = bmp.width * bmp.height * 4;
    if (this.bytes + size > this.budgetBytes) {
      bmp.close();
      return false;
    }
    this.frames.get(frame)?.close();
    this.frames.set(frame, bmp);
    this.bytes += size;
    this.notify();
    return true;
  }

  /** Cached frame indices as merged [start, end] runs (for the ruler bar). */
  ranges(): Array<[number, number]> {
    const idx = [...this.frames.keys()].sort((a, b) => a - b);
    const out: Array<[number, number]> = [];
    for (const i of idx) {
      const last = out[out.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else out.push([i, i]);
    }
    return out;
  }

  get count(): number {
    return this.frames.size;
  }
  get fps(): number {
    return this.key.fps;
  }

  clear(): void {
    for (const b of this.frames.values()) b.close();
    this.frames.clear();
    this.bytes = 0;
    this.notify();
  }
}

export const frameCache = new FrameCache();
