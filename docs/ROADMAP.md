# Roadmap

Luscent is being built in four phases. Each phase ships something usable and leaves seams for the next one.

## Phase 1: timeline, keyframes, preview ✅

- Project/comp/layer model, precomps, parenting, markers, work area
- Timeline edits: move, trim, ripple trim, split, ripple delete, slip, extract, sequence
- Snapping, including to detected beats and transients
- Audio waveforms
- Keyframes: linear / bezier (AE speed + influence) / hold, easy ease, move, marquee select, reveal shortcuts
- WebGL2 preview with automatic resolution and audio-clock playback
- Undo/redo, IndexedDB autosave, project files

## Phase 2: graph editor and easings

- Value graph and speed graph per property, with bezier handles mapped directly onto `TemporalEase` (speed/influence)
- Separate dimensions for vector properties
- Spatial bezier motion paths for Position, with handles in the viewer
- Easing presets: sine, quad, cubic, quart, quint, expo, circ, back, elastic, bounce, each in in/out/in-out
  - Overshooting curves become per-segment preset curves, or are baked into extra keys on request
- Saveable custom curve library: user curves stored as JSON and applied to any selected keyframes
- Keyframe velocity dialog; copy and paste keyframes across properties and layers

## Phase 3: effects pipeline and plugin system

- Per-layer effect stacks; adjustment layers; exact blend modes with shader ping-pong
- WebGPU backend for effects, with a WebGL2 fallback
- Built-in effects:
  - Glow, chromatic aberration, RGB split, shake, whip and zoom transitions, VHS/grain, glitch, lens distortion
  - Blur variants: gaussian, directional, radial, zoom
- Optical-flow time remap and slow-mo:
  - Farneback flow on WebGPU compute
  - Optional RIFE interpolation through ONNX Runtime Web
  - Frame-exact source frames from a WebCodecs `VideoDecoder` + mp4box demuxer
- Plugin format: one WGSL or GLSL shader plus a JSON parameter schema, hot-loaded
  - Bundled permissively licensed packs (gl-transitions, ISF-style shaders)
  - A converter that helps port Shadertoy/ISF/GLSL sources
- Proxy media (WebCodecs transcode in a worker) and a GPU frame cache for RAM preview

## Phase 4: preset import and export

- `.ffx` import: parse After Effects animation presets (keyframes, easings, effect parameters), map them onto Luscent properties and effects, and report anything that could not be mapped
- Luscent JSON presets: save, import and export animation and effect presets
- 50+ edit-ready presets: shakes, flashes, zoom punches, velocity edits
- Export:
  - MP4/H.264 up to 4K60 via WebCodecs `VideoEncoder` + mp4 muxer
  - WebM (VP9/AV1)
  - GIF
  - Platform presets for 9:16
  - Rendered in a worker with an `OffscreenCanvas`
