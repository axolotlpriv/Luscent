/**
 * WebGL2 compositor.
 *
 * Draws a CompFrame (see core/render/evaluate) bottom-to-top. Every layer is a
 * single quad; content comes from an analytic SDF (solids, shapes), an
 * uploaded texture (images, video, rasterised text) or an offscreen render
 * target (precomps). Everything is premultiplied alpha.
 *
 * GPU caching: image textures live as long as their media, text rasters are
 * cached by content key (LRU) and render targets are pooled by size, so a
 * steady-state frame performs no allocations — only video uploads.
 */
import type { CompFrame, RenderItem } from '../../core/render/evaluate';
import { maxScale, multiply, type Mat2D } from '../../core/render/matrix';
import type { BlendMode, Id } from '../../core/model/types';
import { QUAD_VS, SHAPE_FS, TEXTURE_FS } from './shaders';
import { TextRasterizer } from './textRaster';

export interface SourceProvider {
  /** Decoded still for an image media item. */
  image(mediaId: Id): TexImageSource | null;
  /** Current frame for a video instance (already seeked by the media engine). */
  video(key: string, mediaId: Id): TexImageSource | null;
}

export interface RenderOptions {
  /** Preview resolution factor (1 = full, 0.5 = half, ...). */
  scale: number;
  /** Clear with transparent instead of the comp background. */
  transparent?: boolean;
}

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed: ' + log);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, uniforms: string[]): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
  const u: Program['u'] = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u };
}

const COMMON_UNIFORMS = ['uMVP', 'uRect', 'uOpacity'];

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly text = new TextRasterizer();
  private texProg: Program;
  private shapeProg: Program;
  private vao: WebGLVertexArrayObject;
  private imageTex = new Map<Id, { tex: WebGLTexture; src: TexImageSource }>();
  private videoTex = new Map<string, WebGLTexture>();
  private textTex = new Map<string, WebGLTexture>();
  private targetPool: Target[] = [];
  private lost = false;
  /** Stats for the performance HUD. */
  stats = { drawCalls: 0, uploads: 0, ms: 0 };

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.texProg = link(gl, QUAD_VS, TEXTURE_FS, [...COMMON_UNIFORMS, 'uTex']);
    this.shapeProg = link(gl, QUAD_VS, SHAPE_FS, [
      ...COMMON_UNIFORMS,
      'uShape',
      'uSize',
      'uRoundness',
      'uFill',
      'uStroke',
      'uStrokeWidth',
      'uOrigin',
    ]);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    if ('addEventListener' in canvas) {
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
    }
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** Render a frame into the canvas, resizing it to frame size × scale. */
  render(frame: CompFrame, sources: SourceProvider, opts: RenderOptions): void {
    if (this.lost) return;
    const t0 = performance.now();
    this.stats.drawCalls = 0;
    this.stats.uploads = 0;
    const gl = this.gl;
    const w = Math.max(1, Math.round(frame.width * opts.scale));
    const h = Math.max(1, Math.round(frame.height * opts.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const bg = opts.transparent ? [0, 0, 0, 0] : frame.background;
    gl.clearColor(bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawItems(frame, sources, opts.scale, false);
    this.stats.ms = performance.now() - t0;
  }

  /** Composition pixels → clip space. Offscreen targets are not y-flipped. */
  private projection(w: number, h: number, offscreen: boolean): Mat2D {
    return offscreen ? [2 / w, 0, 0, 2 / h, -1, -1] : [2 / w, 0, 0, -2 / h, -1, 1];
  }

  private drawItems(frame: CompFrame, sources: SourceProvider, scale: number, offscreen: boolean): void {
    const proj = this.projection(frame.width, frame.height, offscreen);
    for (const item of frame.items) this.drawItem(item, proj, sources, scale);
  }

  private setBlend(mode: BlendMode): void {
    const gl = this.gl;
    gl.blendEquation(gl.FUNC_ADD);
    switch (mode) {
      case 'add':
        gl.blendFunc(gl.ONE, gl.ONE);
        break;
      case 'screen':
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
        break;
      case 'multiply':
        gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case 'lighten':
        gl.blendEquationSeparate(gl.MAX, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  private setCommon(p: Program, item: RenderItem, proj: Mat2D): void {
    const gl = this.gl;
    const m = multiply(proj, item.matrix);
    // Column-major mat3 from the affine [a b c d e f].
    gl.uniformMatrix3fv(p.u.uMVP, false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
    gl.uniform4f(p.u.uRect, item.rect[0], item.rect[1], item.rect[2], item.rect[3]);
    gl.uniform1f(p.u.uOpacity, item.opacity);
  }

  private drawItem(item: RenderItem, proj: Mat2D, sources: SourceProvider, scale: number): void {
    const gl = this.gl;
    this.setBlend(item.blend);
    if (item.kind === 'shape') {
      const p = this.shapeProg;
      gl.useProgram(p.prog);
      this.setCommon(p, item, proj);
      gl.uniform1i(p.u.uShape, item.shape === 'rect' ? 0 : 1);
      gl.uniform2f(p.u.uSize, item.size[0], item.size[1]);
      gl.uniform1f(p.u.uRoundness, item.roundness);
      gl.uniform4fv(p.u.uFill, item.fill);
      gl.uniform4fv(p.u.uStroke, item.strokeColor);
      gl.uniform1f(p.u.uStrokeWidth, item.strokeWidth);
      // Solids are laid out from the top-left, shapes around their centre.
      const cx = item.rect[0] + item.rect[2] / 2;
      const cy = item.rect[1] + item.rect[3] / 2;
      gl.uniform2f(p.u.uOrigin, cx, cy);
      this.draw();
      return;
    }

    let tex: WebGLTexture | null = null;
    let release: Target | null = null;
    switch (item.kind) {
      case 'image': {
        const src = sources.image(item.mediaId);
        if (!src) return;
        tex = this.imageTexture(item.mediaId, src);
        break;
      }
      case 'video': {
        const src = sources.video(item.key, item.mediaId);
        if (!src) return;
        tex = this.videoTexture(item.key, src);
        break;
      }
      case 'text': {
        const s = maxScale(item.matrix) * scale;
        const r = this.text.raster(item.spec, s);
        tex = this.textTexture(r.key, r.canvas);
        break;
      }
      case 'precomp': {
        release = this.renderToTarget(item.frame, sources, scale);
        tex = release.tex;
        break;
      }
    }
    if (!tex) return;
    const p = this.texProg;
    gl.useProgram(p.prog);
    this.setCommon(p, item, proj);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.uTex, 0);
    this.draw();
    if (release) this.targetPool.push(release);
  }

  private draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.drawCalls++;
  }

  private newTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private upload(tex: WebGLTexture, src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.stats.uploads++;
  }

  private imageTexture(id: Id, src: TexImageSource): WebGLTexture {
    const hit = this.imageTex.get(id);
    if (hit && hit.src === src) return hit.tex;
    const tex = hit?.tex ?? this.newTexture();
    this.upload(tex, src);
    this.imageTex.set(id, { tex, src });
    return tex;
  }

  private videoTexture(key: string, src: TexImageSource): WebGLTexture {
    let tex = this.videoTex.get(key);
    if (!tex) {
      tex = this.newTexture();
      this.videoTex.set(key, tex);
    }
    this.upload(tex, src);
    return tex;
  }

  private textTexture(key: string, canvas: TexImageSource): WebGLTexture {
    const hit = this.textTex.get(key);
    if (hit) {
      this.textTex.delete(key);
      this.textTex.set(key, hit);
      return hit;
    }
    const tex = this.newTexture();
    this.upload(tex, canvas);
    this.textTex.set(key, tex);
    while (this.textTex.size > 96) {
      const [k, t] = this.textTex.entries().next().value!;
      this.gl.deleteTexture(t);
      this.textTex.delete(k);
    }
    return tex;
  }

  private acquireTarget(w: number, h: number): Target {
    const i = this.targetPool.findIndex((t) => t.w === w && t.h === h);
    if (i >= 0) return this.targetPool.splice(i, 1)[0];
    const gl = this.gl;
    const tex = this.newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    // Keep the pool bounded.
    while (this.targetPool.length > 8) {
      const old = this.targetPool.shift()!;
      gl.deleteFramebuffer(old.fb);
      gl.deleteTexture(old.tex);
    }
    return { fb, tex, w, h };
  }

  /** Render a nested frame into a pooled target; caller returns it to the pool. */
  private renderToTarget(frame: CompFrame, sources: SourceProvider, scale: number): Target {
    const gl = this.gl;
    const w = Math.max(1, Math.round(frame.width * scale));
    const h = Math.max(1, Math.round(frame.height * scale));
    const target = this.acquireTarget(w, h);
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevVp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawItems(frame, sources, scale, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
    return target;
  }

  /** Drop GPU resources for media that left the project. */
  releaseMedia(mediaId: Id): void {
    const hit = this.imageTex.get(mediaId);
    if (hit) {
      this.gl.deleteTexture(hit.tex);
      this.imageTex.delete(mediaId);
    }
  }

  /** Drop video textures for instances no longer on screen. */
  retainVideo(keys: ReadonlySet<string>): void {
    for (const [k, t] of this.videoTex) {
      if (keys.has(k)) continue;
      this.gl.deleteTexture(t);
      this.videoTex.delete(k);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const { tex } of this.imageTex.values()) gl.deleteTexture(tex);
    for (const t of this.videoTex.values()) gl.deleteTexture(t);
    for (const t of this.textTex.values()) gl.deleteTexture(t);
    for (const t of this.targetPool) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.imageTex.clear();
    this.videoTex.clear();
    this.textTex.clear();
    this.targetPool = [];
  }
}
