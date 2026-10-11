/**
 * WebGL2 compositor.
 *
 * Every composition is composited bottom-to-top into an offscreen
 * accumulation target, then blitted to the canvas. Layers without effects
 * and with a simple blend mode draw straight into the accumulation buffer
 * (one quad each). Other layers are isolated: rendered into their own
 * target, run through their effect stack (multi-pass GLSL, ping-ponged
 * through pooled targets), then composited with an exact blend-mode shader.
 * Adjustment layers process the accumulated frame and mix the result back in
 * through their own alpha. Transition effects receive the frame below
 * ("from") and the frame with the layer on top ("to").
 *
 * Sources: solids/shapes are analytic SDFs; images and text rasters are
 * cached textures; video frames are uploaded per frame; precomps recurse.
 * Everything is premultiplied alpha.
 */
import type { CompFrame, EvaluatedEffect, RenderItem } from '../../core/render/evaluate';
import { maxScale, multiply, type Mat2D } from '../../core/render/matrix';
import type { BlendMode, Id } from '../../core/model/types';
import { effectRegistry } from '../../core/effects/registry';
import { pluginParams, type EffectPlugin } from '../../core/effects/types';
import { BLEND_FS, BLEND_MODE_INDEX, COPY_FS, FULLSCREEN_VS, MIX_FS, QUAD_VS, SHAPE_FS, TEXTURE_FS } from './shaders';
import { buildPassShader, passInputs, passOutputName } from './effectShader';
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

/** Runs a WGSL-only plugin pass (WebGPU bridge); installed by the plugin system. */
export interface WgslBridge {
  run(plugin: EffectPlugin, rev: number, input: TexImageSource, params: Record<string, number | number[]>, clocks: EffectClocks, w: number, h: number): TexImageSource | null;
}

export interface EffectClocks {
  time: number;
  layerTime: number;
  progress: number;
  compW: number;
  compH: number;
  renderScale: number;
}

interface Program {
  prog: WebGLProgram;
  u: Map<string, WebGLUniformLocation | null>;
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
    throw new Error(log || 'Shader compile failed');
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const prog = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'Program link failed');
  return { prog, u: new Map() };
}

function loc(gl: WebGL2RenderingContext, p: Program, name: string): WebGLUniformLocation | null {
  let l = p.u.get(name);
  if (l === undefined) {
    l = gl.getUniformLocation(p.prog, name);
    p.u.set(name, l);
  }
  return l;
}

/** Blend modes the fixed-function pipeline handles exactly (premultiplied). */
const FAST_BLENDS = new Set<BlendMode>(['normal', 'add', 'screen']);

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly text = new TextRasterizer();
  private texProg: Program;
  private shapeProg: Program;
  private copyProg: Program;
  private mixProg: Program;
  private blendProg: Program;
  private vao: WebGLVertexArrayObject;
  private imageTex = new Map<Id, { tex: WebGLTexture; src: TexImageSource }>();
  private videoTex = new Map<string, WebGLTexture>();
  private textTex = new Map<string, WebGLTexture>();
  private effectProgs = new Map<string, Program | null>();
  private targetPool: Target[] = [];
  private lost = false;
  private time = 0;
  private bridgeTex: WebGLTexture | null = null;
  wgsl: WgslBridge | null = null;
  /** Stats for the performance HUD. */
  stats = { drawCalls: 0, uploads: 0, ms: 0, passes: 0 };

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
    this.texProg = link(gl, QUAD_VS, TEXTURE_FS);
    this.shapeProg = link(gl, QUAD_VS, SHAPE_FS);
    this.copyProg = link(gl, FULLSCREEN_VS, COPY_FS);
    this.mixProg = link(gl, FULLSCREEN_VS, MIX_FS);
    this.blendProg = link(gl, FULLSCREEN_VS, BLEND_FS);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
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
    this.stats.passes = 0;
    this.time = frame.time;
    const gl = this.gl;
    const w = Math.max(1, Math.round(frame.width * opts.scale));
    const h = Math.max(1, Math.round(frame.height * opts.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const acc = this.composite(frame, sources, opts.scale, !opts.transparent);
    // Blit to the canvas (default framebuffer is y-up: flip).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    this.fullscreen(this.copyProg, { uTex: acc.tex }, { uOpacity: 1, uFlipY: 1 });
    this.release(acc);
    this.stats.ms = performance.now() - t0;
  }

  // ------------------------------------------------------------------ compositing

  /** Composite a frame into a fresh target (caller releases it). */
  private composite(frame: CompFrame, sources: SourceProvider, scale: number, withBackground: boolean): Target {
    const gl = this.gl;
    const W = Math.max(1, Math.round(frame.width * scale));
    const H = Math.max(1, Math.round(frame.height * scale));
    let acc = this.acquire(W, H);
    this.bind(acc);
    const bg = withBackground ? frame.background : [0, 0, 0, 0];
    gl.clearColor(bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const proj: Mat2D = [2 / frame.width, 0, 0, 2 / frame.height, -1, -1];
    const clocks = (item: RenderItem, progress = 0): EffectClocks => ({
      time: frame.time,
      layerTime: item.layerTime,
      progress,
      compW: frame.width,
      compH: frame.height,
      renderScale: scale,
    });

    for (const item of frame.items) {
      const effects = item.effects ?? [];
      if (item.adjustment) {
        if (effects.length === 0) continue;
        const processed = this.runChain(effects.filter((e) => e.kind === 'effect'), acc, clocks(item));
        if (processed === acc) continue;
        const mask = this.isolate(item, proj, sources, scale, W, H, item.opacity);
        const out = this.acquire(W, H);
        this.bind(out);
        gl.disable(gl.BLEND);
        this.fullscreen(this.mixProg, { uA: acc.tex, uB: processed.tex, uMask: mask.tex }, { uFlipY: 0 });
        this.release(acc);
        this.release(processed);
        this.release(mask);
        acc = out;
        continue;
      }
      const transition = this.activeTransition(effects, item);
      const needsIsolation = effects.length > 0 || !FAST_BLENDS.has(item.blend) || !!transition;
      if (!needsIsolation) {
        this.bind(acc);
        this.drawItem(item, proj, sources, scale, item.opacity, item.blend);
        continue;
      }
      // Isolated path: layer → own target → effects → blend over acc.
      let layer = this.isolate(item, proj, sources, scale, W, H, 1);
      const chain = effects.filter((e) => e.kind === 'effect');
      if (chain.length) {
        const processed = this.runChain(chain, layer, clocks(item));
        if (processed !== layer) {
          this.release(layer);
          layer = processed;
        }
      }
      const withLayer = this.acquire(W, H);
      this.bind(withLayer);
      gl.disable(gl.BLEND);
      this.fullscreen(
        this.blendProg,
        { uBackdrop: acc.tex, uSource: layer.tex },
        { uOpacity: item.opacity, uFlipY: 0 },
        { uMode: BLEND_MODE_INDEX[item.blend] ?? 0 },
      );
      this.release(layer);
      if (transition) {
        const { effect, progress, out } = transition;
        const from = out ? withLayer : acc;
        const to = out ? acc : withLayer;
        const result = this.runTransition(effect, from, to, clocks(item, progress));
        this.release(acc);
        this.release(withLayer);
        acc = result;
      } else {
        this.release(acc);
        acc = withLayer;
      }
    }
    return acc;
  }

  /** The transition effect active for this item right now, if any. */
  private activeTransition(effects: EvaluatedEffect[], item: RenderItem): { effect: EvaluatedEffect; progress: number; out: boolean } | null {
    for (const e of effects) {
      if (e.kind !== 'transition') continue;
      const dur = Math.max(1e-3, Number(e.params.duration) || 0.4);
      const out = Math.round(Number(e.params.placement) || 0) === 1;
      const clock = out ? item.untilOut : item.sinceIn;
      if (clock < dur) {
        const p = Math.min(1, Math.max(0, clock / dur));
        return { effect: e, progress: out ? 1 - p : p, out };
      }
    }
    return null;
  }

  /** Render one item alone into a cleared target. */
  private isolate(item: RenderItem, proj: Mat2D, sources: SourceProvider, scale: number, W: number, H: number, opacity: number): Target {
    const gl = this.gl;
    const t = this.acquire(W, H);
    this.bind(t);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawItem(item, proj, sources, scale, opacity, 'normal');
    return t;
  }

  // ------------------------------------------------------------------ effects

  private program(key: string, build: () => string, pluginId: string): Program | null {
    if (this.effectProgs.has(key)) return this.effectProgs.get(key)!;
    let p: Program | null = null;
    try {
      p = link(this.gl, FULLSCREEN_VS, build());
      effectRegistry.setError(pluginId, null);
    } catch (err) {
      effectRegistry.setError(pluginId, (err as Error).message);
      console.warn(`[luscent] effect ${pluginId} failed to compile:`, (err as Error).message);
    }
    this.effectProgs.set(key, p);
    return p;
  }

  /** Apply effects in order. Returns `input` unchanged if nothing ran. */
  private runChain(effects: EvaluatedEffect[], input: Target, clocks: EffectClocks): Target {
    let cur = input;
    for (const e of effects) {
      const reg = effectRegistry.get(e.pluginId);
      if (!reg) continue;
      const out = this.runPlugin(reg.plugin, reg.rev, e.params, { source: cur }, clocks);
      if (!out) continue;
      if (cur !== input) this.release(cur);
      cur = out;
    }
    return cur;
  }

  private runTransition(e: EvaluatedEffect, from: Target, to: Target, clocks: EffectClocks): Target {
    const reg = effectRegistry.get(e.pluginId);
    const out = reg ? this.runPlugin(reg.plugin, reg.rev, e.params, { from, to }, clocks) : null;
    if (out) return out;
    // Unknown / broken transition: hard cut to the destination.
    const copy = this.acquire(to.w, to.h);
    this.bind(copy);
    this.gl.disable(this.gl.BLEND);
    this.fullscreen(this.copyProg, { uTex: to.tex }, { uOpacity: 1, uFlipY: 0 });
    return copy;
  }

  /** Run every pass of a plugin; returns the final output target (or null on failure). */
  private runPlugin(
    plugin: EffectPlugin,
    rev: number,
    params: Record<string, number | number[]>,
    inputs: Record<string, Target>,
    clocks: EffectClocks,
  ): Target | null {
    const gl = this.gl;
    const base = inputs.source ?? inputs.to;
    if (!plugin.passes?.length) return this.runWgsl(plugin, rev, params, base, clocks);
    const outputs: Record<string, Target> = { ...inputs };
    const produced: Target[] = [];
    let last: Target | null = null;
    for (let i = 0; i < plugin.passes.length; i++) {
      const pass = plugin.passes[i];
      const prog = this.program(`${plugin.id}#${rev}#${i}`, () => buildPassShader(plugin, i), plugin.id);
      if (!prog) {
        for (const t of produced) this.release(t);
        return null;
      }
      const s = pass.scale ?? 1;
      const w = Math.max(1, Math.round(base.w * s));
      const h = Math.max(1, Math.round(base.h * s));
      const target = this.acquire(w, h);
      this.bind(target);
      gl.disable(gl.BLEND);
      gl.useProgram(prog.prog);
      const names = new Set(passInputs(plugin, i));
      if (plugin.kind === 'transition') {
        names.add('from');
        names.add('to');
      } else names.add('source');
      let unit = 0;
      for (const name of names) {
        const src = outputs[name] ?? base;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform1i(loc(gl, prog, name), unit);
        unit++;
      }
      gl.uniform1f(loc(gl, prog, 'uFlipY'), 0);
      gl.uniform2f(loc(gl, prog, 'resolution'), w, h);
      gl.uniform2f(loc(gl, prog, 'compSize'), clocks.compW, clocks.compH);
      gl.uniform1f(loc(gl, prog, 'renderScale'), clocks.renderScale * s);
      gl.uniform1f(loc(gl, prog, 'time'), clocks.time);
      gl.uniform1f(loc(gl, prog, 'layerTime'), clocks.layerTime);
      gl.uniform1f(loc(gl, prog, 'progress'), clocks.progress);
      gl.uniform1f(loc(gl, prog, 'seed'), 0);
      for (const spec of pluginParams(plugin)) {
        const l = loc(gl, prog, spec.id);
        if (!l) continue;
        const v = params[spec.id];
        if (Array.isArray(v)) {
          if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
          else if (v.length >= 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
          else if (v.length === 3) gl.uniform4f(l, v[0], v[1], v[2], 1);
        } else gl.uniform1f(l, Number(v) || 0);
      }
      this.drawQuad();
      this.stats.passes++;
      outputs[passOutputName(pass, i)] = target;
      produced.push(target);
      last = target;
    }
    for (const t of produced) if (t !== last) this.release(t);
    return last;
  }

  /** WGSL-only plugins: read back, run on WebGPU, upload the result. */
  private runWgsl(plugin: EffectPlugin, rev: number, params: Record<string, number | number[]>, input: Target, clocks: EffectClocks): Target | null {
    if (!this.wgsl) {
      effectRegistry.setError(plugin.id, 'This plugin needs WebGPU, which is not available here.');
      return null;
    }
    const gl = this.gl;
    // Read the input target into a canvas-able ImageData.
    const pixels = new Uint8ClampedArray(input.w * input.h * 4);
    this.bind(input);
    gl.readPixels(0, 0, input.w, input.h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const img = new ImageData(pixels, input.w, input.h);
    const out = this.wgsl.run(plugin, rev, img as unknown as TexImageSource, params, clocks, input.w, input.h);
    if (!out) return null;
    const target = this.acquire(input.w, input.h);
    this.bridgeTex ??= this.newTexture();
    this.upload(this.bridgeTex, out);
    this.bind(target);
    gl.disable(gl.BLEND);
    this.fullscreen(this.copyProg, { uTex: this.bridgeTex }, { uOpacity: 1, uFlipY: 0 });
    return target;
  }

  // ------------------------------------------------------------------ primitives

  private bind(t: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
  }

  private fullscreen(p: Program, textures: Record<string, WebGLTexture>, floats: Record<string, number>, ints: Record<string, number> = {}): void {
    const gl = this.gl;
    gl.useProgram(p.prog);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc(gl, p, name), unit);
      unit++;
    }
    for (const [name, v] of Object.entries(floats)) gl.uniform1f(loc(gl, p, name), v);
    for (const [name, v] of Object.entries(ints)) gl.uniform1i(loc(gl, p, name), v);
    this.drawQuad();
  }

  private setBlend(mode: BlendMode): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private setCommon(p: Program, item: RenderItem, proj: Mat2D, opacity: number): void {
    const gl = this.gl;
    const m = multiply(proj, item.matrix);
    gl.uniformMatrix3fv(loc(gl, p, 'uMVP'), false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
    gl.uniform4f(loc(gl, p, 'uRect'), item.rect[0], item.rect[1], item.rect[2], item.rect[3]);
    gl.uniform1f(loc(gl, p, 'uOpacity'), opacity);
  }

  /** Draw one item's content into the bound target. */
  private drawItem(item: RenderItem, proj: Mat2D, sources: SourceProvider, scale: number, opacity: number, blend: BlendMode): void {
    const gl = this.gl;
    if (item.kind === 'shape') {
      this.setBlend(blend);
      const p = this.shapeProg;
      gl.useProgram(p.prog);
      this.setCommon(p, item, proj, opacity);
      gl.uniform1i(loc(gl, p, 'uShape'), item.shape === 'rect' ? 0 : 1);
      gl.uniform2f(loc(gl, p, 'uSize'), item.size[0], item.size[1]);
      gl.uniform1f(loc(gl, p, 'uRoundness'), item.roundness);
      gl.uniform4fv(loc(gl, p, 'uFill'), item.fill);
      gl.uniform4fv(loc(gl, p, 'uStroke'), item.strokeColor);
      gl.uniform1f(loc(gl, p, 'uStrokeWidth'), item.strokeWidth);
      gl.uniform2f(loc(gl, p, 'uOrigin'), item.rect[0] + item.rect[2] / 2, item.rect[1] + item.rect[3] / 2);
      this.drawQuad();
      return;
    }
    let tex: WebGLTexture | null = null;
    let nested: Target | null = null;
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
        const r = this.text.raster(item.spec, maxScale(item.matrix) * scale);
        tex = this.textTexture(r.key, r.canvas);
        break;
      }
      case 'precomp': {
        // Save the bound target, composite the nested comp, then restore.
        const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const prevVp = gl.getParameter(gl.VIEWPORT) as Int32Array;
        nested = this.composite(item.frame, sources, scale, false);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
        gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
        tex = nested.tex;
        break;
      }
    }
    if (!tex) return;
    this.setBlend(blend);
    const p = this.texProg;
    gl.useProgram(p.prog);
    this.setCommon(p, item, proj, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc(gl, p, 'uTex'), 0);
    this.drawQuad();
    if (nested) this.release(nested);
  }

  private drawQuad(): void {
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

  private acquire(w: number, h: number): Target {
    const i = this.targetPool.findIndex((t) => t.w === w && t.h === h);
    if (i >= 0) return this.targetPool.splice(i, 1)[0];
    const gl = this.gl;
    const tex = this.newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  private release(t: Target): void {
    this.targetPool.push(t);
    // Keep the pool bounded (oldest first).
    while (this.targetPool.length > 24) {
      const old = this.targetPool.shift()!;
      this.gl.deleteFramebuffer(old.fb);
      this.gl.deleteTexture(old.tex);
    }
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

  /** Forget compiled effect programs (after plugins are hot-reloaded). */
  purgeEffects(): void {
    for (const p of this.effectProgs.values()) if (p) this.gl.deleteProgram(p.prog);
    this.effectProgs.clear();
  }

  /** Read the canvas back as RGBA pixels (top-left origin). */
  readPixels(): ImageData {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const buf = new Uint8ClampedArray(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // Flip rows.
    const row = w * 4;
    const tmp = new Uint8ClampedArray(row);
    for (let y = 0; y < h / 2; y++) {
      const a = y * row;
      const b = (h - 1 - y) * row;
      tmp.set(buf.subarray(a, a + row));
      buf.copyWithin(a, b, b + row);
      buf.set(tmp, b);
    }
    return new ImageData(buf, w, h);
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
    this.purgeEffects();
    this.imageTex.clear();
    this.videoTex.clear();
    this.textTex.clear();
    this.targetPool = [];
  }

  get lastTime(): number {
    return this.time;
  }
}
