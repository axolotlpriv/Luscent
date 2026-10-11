/**
 * Renders composition frames offline with exact source frames (and awaited
 * optical flow). Shared by export, RAM preview and thumbnails.
 */
import { collectVideoItems, evaluateComposition } from '../../core/render/evaluate';
import type { Id, Project } from '../../core/model/types';
import { GLRenderer } from '../gl/Renderer';
import { FrameSource } from '../media/FrameSource';
import type { MediaEngine } from '../media/MediaEngine';
import { FrameInterpolator } from '../flow/FrameInterpolator';
import { getWgslBridge } from '../plugins/pluginStore';

export class OfflineRenderer {
  readonly canvas: OffscreenCanvas;
  readonly renderer: GLRenderer;
  private frames: FrameSource;
  private interp: FrameInterpolator;

  private constructor(
    private readonly project: Project,
    private readonly compId: Id,
    private readonly media: MediaEngine,
    readonly scale: number,
  ) {
    const comp = project.compositions[compId];
    this.canvas = new OffscreenCanvas(Math.max(2, Math.round(comp.width * scale)), Math.max(2, Math.round(comp.height * scale)));
    this.renderer = new GLRenderer(this.canvas);
    this.frames = new FrameSource(media);
    this.interp = new FrameInterpolator(this.frames);
  }

  static async create(project: Project, compId: Id, media: MediaEngine, scale: number, flowEngine: 'farneback' | 'rife' = 'farneback'): Promise<OfflineRenderer> {
    const r = new OfflineRenderer(project, compId, media, scale);
    r.interp.engine = flowEngine;
    const bridge = await getWgslBridge();
    if (bridge) r.renderer.wgsl = bridge;
    return r;
  }

  /** Render comp time t into the canvas. */
  async render(t: number): Promise<OffscreenCanvas> {
    const frame = evaluateComposition(this.project, this.compId, t, { measureText: (spec) => this.renderer.text.measure(spec) });
    if (!frame) return this.canvas;
    const videos = new Map<string, TexImageSource>();
    await Promise.all(
      collectVideoItems(frame).map(async (v) => {
        const fps = this.project.media[v.mediaId]?.fps || 30;
        const src =
          v.frameBlending !== 'none'
            ? await this.interp.render(v.mediaId, v.sourceTime, fps, v.frameBlending)
            : await this.frames.frame(v.mediaId, Math.max(0, Math.round(v.sourceTime * fps - 0.5)), fps);
        if (src) videos.set(v.key, src);
      }),
    );
    this.renderer.render(frame, { image: (id) => this.media.image(id), video: (key) => videos.get(key) ?? null }, { scale: this.scale });
    return this.canvas;
  }

  readPixels(): ImageData {
    return this.renderer.readPixels();
  }

  dispose(): void {
    this.renderer.dispose();
    this.interp.dispose();
    this.frames.dispose();
  }
}
