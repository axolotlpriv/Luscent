/** One shared WebGPU device for WGSL plugins and optical flow. */
let devicePromise: Promise<GPUDevice | null> | null = null;

export function getGpuDevice(): Promise<GPUDevice | null> {
  devicePromise ??= (async () => {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    if (!adapter) return null;
    const device = await adapter.requestDevice().catch(() => null);
    device?.lost.then(() => {
      devicePromise = null;
    });
    return device;
  })();
  return devicePromise;
}
