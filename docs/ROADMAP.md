# Roadmap

Luscent was built in four phases. Each phase shipped something usable and left seams for the next one. All four are done; the open items are at the end.

## Phase 1: timeline, keyframes, preview ✅

- Project/comp/layer model, precomps, parenting, markers, work area
- Timeline edits: move, trim, ripple trim, split, ripple delete, slip, extract, sequence
- Snapping, including to detected beats and transients
- Audio waveforms
- Keyframes: linear / bezier (AE speed + influence) / hold, easy ease, move, marquee select, reveal shortcuts
- WebGL2 preview with automatic resolution and audio-clock playback
- Undo/redo, IndexedDB autosave, project files

## Phase 2: graph editor and easings ✅

- Value and speed graphs that share the timeline's time axis, with bezier handles mapped onto `TemporalEase`
- Easing presets: sine, quad, cubic, quart, quint, expo, circ, back, elastic, bounce (in, out, in-out), plus snap, punch and whip
  - Elastic and bounce are function curves on the segment (`Keyframe.outCurve`) and can be baked into keys
- Custom curve library in IndexedDB, with JSON import/export
- Keyframe velocity, copy/paste keyframes, wiggle modifier, motion paths in the viewer

## Phase 3: effects pipeline and plugin system ✅

- Per-layer effect stacks, adjustment layers, exact blend modes via an isolated-layer compositor
- 21 built-in effects and 8 transitions
- Optical-flow time remap and slow motion:
  - Farnebäck on WebGPU compute, matching the CPU reference
  - Optional RIFE through ONNX Runtime Web
  - Frame-exact source frames
- Plugin format (JSON params + GLSL passes, or WGSL on WebGPU), hot-reloaded registry, install/share/uninstall, Shader Lab
- Bundled gl-transitions, ISF and Shadertoy samples; a converter for porting shaders
- Proxy media and RAM preview (these landed with export)

## Phase 4: presets and export ✅

- Luscent preset format: layer and comp presets, expressions over comp/beat variables, speed ramps, effects
- 63 built-in presets across shake, flash, zoom, velocity, transitions, text and stylize
- Presets panel: search, categories, double-click or drag onto a layer, save from a layer, import/export
- After Effects `.ffx` / `.aep` import with a mapped / approximated / unmapped report
- Export: MP4/H.264 up to 4K60 (VP9-in-MP4 fallback), WebM/VP9, GIF, 9:16 presets, offline audio mixdown

## Next

- **Export in a worker.** Export renders to an `OffscreenCanvas` on the main thread today; moving the renderer into a worker would keep the UI fully responsive during long exports.
- **AV1 WebM** when encoders are common.
- **More `.ffx` coverage**: masks, text animators, 3D transforms, shape layers, and more first-party effects and expressions.
- **WebGPU compositor backend.** Effects run on WebGL2 today; WebGPU is used for flow and WGSL plugins.
- **Testing on real hardware**: H.264 and AAC encoding and the RIFE path have only been exercised in a headless Chromium without those codecs or a model. They need checks on Chrome and Edge with a real GPU.
