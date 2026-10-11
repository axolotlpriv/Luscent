import type { Rect, TextSpec } from '../../core/render/evaluate';

/**
 * Rasterises text blocks with Canvas2D. Layout follows After Effects point
 * text: layer-space origin is the alignment point on the first baseline.
 * Tracking is in 1/1000 em.
 */
type Canvas2D = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface RasterText {
  key: string;
  canvas: Canvas2D;
  /** Layer-space rect the canvas covers. */
  rect: Rect;
  scale: number;
}

function makeCanvas(w: number, h: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function fontString(spec: TextSpec, size = spec.fontSize): string {
  return `${spec.italic ? 'italic ' : ''}${spec.fontWeight} ${size}px ${spec.fontFamily}`;
}

export function textKey(spec: TextSpec): string {
  return JSON.stringify([
    spec.text,
    spec.fontFamily,
    spec.fontWeight,
    spec.italic,
    spec.align,
    Math.round(spec.fontSize * 100) / 100,
    Math.round(spec.tracking * 10) / 10,
    spec.fill.map((v) => Math.round(v * 255)),
    Math.round(spec.strokeWidth * 100) / 100,
    spec.strokeColor.map((v) => Math.round(v * 255)),
  ]);
}

function rgba(c: readonly number[]): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
}

export class TextRasterizer {
  private measureCtx: Ctx2D;
  private measureCache = new Map<string, Rect>();
  private rasterCache = new Map<string, RasterText>();

  constructor(private readonly maxEntries = 96) {
    this.measureCtx = makeCanvas(4, 4).getContext('2d') as Ctx2D;
  }

  private layout(spec: TextSpec, ctx: Ctx2D, size: number) {
    ctx.font = fontString(spec, size);
    const ls = (spec.tracking / 1000) * size;
    if ('letterSpacing' in ctx) (ctx as { letterSpacing: string }).letterSpacing = `${ls}px`;
    const lines = spec.text.split('\n');
    const widths = lines.map((l) => ctx.measureText(l).width);
    const m = ctx.measureText('Hgjy');
    const ascent = m.fontBoundingBoxAscent || size * 0.95;
    const descent = m.fontBoundingBoxDescent || size * 0.25;
    const lineHeight = size * 1.2;
    return { lines, widths, ascent, descent, lineHeight };
  }

  measure(spec: TextSpec): Rect {
    const key = textKey(spec);
    const hit = this.measureCache.get(key);
    if (hit) return hit;
    const { widths, ascent, descent, lineHeight, lines } = this.layout(spec, this.measureCtx, spec.fontSize);
    const pad = spec.strokeWidth + 2;
    const w = Math.max(1, ...widths) + pad * 2;
    const h = ascent + descent + (lines.length - 1) * lineHeight + pad * 2;
    const maxW = Math.max(1, ...widths);
    const x0 = spec.align === 'left' ? 0 : spec.align === 'right' ? -maxW : -maxW / 2;
    const rect: Rect = [x0 - pad, -ascent - pad, w, h];
    this.measureCache.set(key, rect);
    if (this.measureCache.size > this.maxEntries * 4) this.measureCache.delete(this.measureCache.keys().next().value!);
    return rect;
  }

  /** Rasterise at `scale` device pixels per layer pixel (cached, LRU). */
  raster(spec: TextSpec, scale: number): RasterText {
    const s = Math.min(4, Math.max(0.25, Math.ceil(scale * 4) / 4));
    const key = textKey(spec) + '@' + s;
    const hit = this.rasterCache.get(key);
    if (hit) {
      this.rasterCache.delete(key);
      this.rasterCache.set(key, hit);
      return hit;
    }
    const rect = this.measure(spec);
    const cw = Math.max(1, Math.min(8192, Math.ceil(rect[2] * s)));
    const ch = Math.max(1, Math.min(8192, Math.ceil(rect[3] * s)));
    const canvas = makeCanvas(cw, ch);
    const ctx = canvas.getContext('2d') as Ctx2D;
    ctx.scale(s, s);
    ctx.translate(-rect[0], -rect[1]);
    const { lines, widths, lineHeight } = this.layout(spec, ctx, spec.fontSize);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    lines.forEach((line, i) => {
      const lw = widths[i];
      let x: number;
      if (spec.align === 'left') x = 0;
      else if (spec.align === 'right') x = -lw;
      else x = -lw / 2;
      const y = i * lineHeight;
      if (spec.strokeWidth > 0) {
        ctx.strokeStyle = rgba(spec.strokeColor);
        ctx.lineWidth = spec.strokeWidth * 2; // stroke drawn behind fill, so double it
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = rgba(spec.fill);
      ctx.fillText(line, x, y);
    });
    const r: RasterText = { key, canvas, rect, scale: s };
    this.rasterCache.set(key, r);
    while (this.rasterCache.size > this.maxEntries) this.rasterCache.delete(this.rasterCache.keys().next().value!);
    return r;
  }

  /** Invalidate metrics (e.g. after a web font finishes loading). */
  clear(): void {
    this.measureCache.clear();
    this.rasterCache.clear();
  }
}
