/**
 * WebGPU runner for WGSL effect plugins.
 *
 * WGSL contract (docs/PLUGINS.md): the plugin's `wgsl` defines
 *   fn effect(uv: vec2f) -> vec4f
 * and may call `sampleSource(uv)`. Parameters and built-ins (resolution,
 * compSize, renderScale, time, layerTime, progress) are available as
 * module-scope variables with the same names as in GLSL.
 *
 * The WebGL compositor hands us the layer pixels, we render with WebGPU into
 * an OffscreenCanvas and return an ImageBitmap the compositor uploads.
 */
import type { EffectClocks, WgslBridge } from '../gl/Renderer';
import { pluginParams, type EffectPlugin, type ParamSpec } from '../../core/effects/types';
import { effectRegistry } from '../../core/effects/registry';
import { getGpuDevice } from './device';

const BUILTINS = ['resolution', 'compSize', 'renderScale', 'time', 'layerTime', 'progress'];

function wgslType(p: ParamSpec): 'f32' | 'vec2f' | 'vec4f' {
  if (p.type === 'point' || p.type === 'vec2') return 'vec2f';
  if (p.type === 'color') return 'vec4f';
  return 'f32';
}

export function buildWgslModule(plugin: EffectPlugin): { code: string; slots: string[] } {
  const params = pluginParams(plugin);
  // Each value occupies one vec4f slot (simple, alignment-proof layout).
  const slots = [...BUILTINS, ...params.map((p) => p.id)];
  const globals = [
    'var<private> resolution: vec2f;',
    'var<private> compSize: vec2f;',
    'var<private> renderScale: f32;',
    'var<private> time: f32;',
    'var<private> layerTime: f32;',
    'var<private> progress: f32;',
    ...params.map((p) => `var<private> ${p.id}: ${wgslType(p)};`),
  ];
  const load = slots.map((name, i) => {
    const p = params.find((x) => x.id === name);
    const t = p ? wgslType(p) : name === 'resolution' || name === 'compSize' ? 'vec2f' : 'f32';
    const sw = t === 'f32' ? '.x' : t === 'vec2f' ? '.xy' : '';
    return `  ${name} = u.slots[${i}]${sw};`;
  });
  const code = `struct U { slots: array<vec4f, ${slots.length}> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var sourceSamp: sampler;
${globals.join('\n')}
fn sampleSource(uv: vec2f) -> vec4f { return textureSampleLevel(sourceTex, sourceSamp, uv, 0.0); }
${plugin.wgsl}
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
${load.join('\n')}
  return effect(in.uv);
}`;
  return { code, slots };
}

interface Pipe {
  pipeline: GPURenderPipeline;
  slots: string[];
  ubo: GPUBuffer;
}

export class WebGpuWgslBridge implements WgslBridge {
  private device: GPUDevice | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'rgba8unorm';
  private pipes = new Map<string, Pipe | null>();
  private input: GPUTexture | null = null;
  private sampler: GPUSampler | null = null;
  readonly errors = new Map<string, string>();

  static async create(): Promise<WebGpuWgslBridge | null> {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const device = await getGpuDevice();
    if (!device) return null;
    const b = new WebGpuWgslBridge();
    b.device = device;
    b.canvas = new OffscreenCanvas(4, 4);
    b.ctx = b.canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!b.ctx) return null;
    b.format = navigator.gpu.getPreferredCanvasFormat();
    b.ctx.configure({ device, format: b.format, alphaMode: 'premultiplied' });
    b.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    return b;
  }

  private pipeFor(plugin: EffectPlugin, rev: number): Pipe | null {
    const key = `${plugin.id}#${rev}`;
    if (this.pipes.has(key)) return this.pipes.get(key)!;
    const device = this.device!;
    const { code, slots } = buildWgslModule(plugin);
    let pipe: Pipe | null = null;
    try {
      const module = device.createShaderModule({ code });
      pipe = {
        pipeline: device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
          primitive: { topology: 'triangle-list' },
        }),
        slots,
        ubo: device.createBuffer({ size: slots.length * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      };
      void module.getCompilationInfo().then((info) => {
        const errs = info.messages.filter((m) => m.type === 'error');
        if (errs.length) {
          const text = errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n');
          this.errors.set(plugin.id, text);
          effectRegistry.setError(plugin.id, text);
        }
      });
    } catch (err) {
      this.errors.set(plugin.id, (err as Error).message);
      effectRegistry.setError(plugin.id, (err as Error).message);
    }
    this.pipes.set(key, pipe);
    return pipe;
  }

  run(plugin: EffectPlugin, rev: number, input: TexImageSource, params: Record<string, number | number[]>, clocks: EffectClocks, w: number, h: number): TexImageSource | null {
    const device = this.device;
    if (!device || !this.ctx || !this.canvas) return null;
    const pipe = this.pipeFor(plugin, rev);
    if (!pipe) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (!this.input || this.input.width !== w || this.input.height !== h) {
      this.input?.destroy();
      this.input = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    }
    const img = input as ImageData;
    device.queue.writeTexture({ texture: this.input }, img.data, { bytesPerRow: w * 4 }, [w, h]);
    const values = new Float32Array(pipe.slots.length * 4);
    const builtins: Record<string, number | number[]> = {
      resolution: [w, h],
      compSize: [clocks.compW, clocks.compH],
      renderScale: clocks.renderScale,
      time: clocks.time,
      layerTime: clocks.layerTime,
      progress: clocks.progress,
    };
    pipe.slots.forEach((name, i) => {
      const v = name in builtins ? builtins[name] : params[name];
      if (Array.isArray(v)) v.slice(0, 4).forEach((x, j) => (values[i * 4 + j] = x));
      else values[i * 4] = Number(v) || 0;
    });
    device.queue.writeBuffer(pipe.ubo, 0, values);
    const bind = device.createBindGroup({
      layout: pipe.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pipe.ubo } },
        { binding: 1, resource: this.input.createView() },
        { binding: 2, resource: this.sampler! },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipe.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
    return this.canvas.transferToImageBitmap();
  }
}
