# Architecture

Luscent has four layers. Each one depends only on the layers listed above it:

```
core      →  pure data + algorithms (no DOM, fully unit-tested)
engine    →  browser runtime: GPU, media decode, audio, storage
state     →  zustand store: project + UI state + actions + undo
ui        →  React views that read state and call actions
```

## Data model (`src/core/model`)

A `Project` is plain, serialisable JSON: compositions, media items and ids. It holds no class instances or handles, so a project can be frozen by immer, snapshotted for undo, saved to a file, stored in IndexedDB and posted to a worker unchanged.

- **Time** is in seconds. Edits quantise to the comp frame rate.
- **Layer timing** follows After Effects:
  - `inPoint` / `outPoint` mark where the layer is visible in comp time.
  - `startTime` is the comp time at which layer time 0 (source frame 0) plays.
  - Keyframes are stored in **layer time**, so moving a layer carries its animation. Slip edits move `startTime` and shift the keyframes back, so the animation stays fixed in comp time.
- **Properties** live in `layer.props` keyed by path (`transform.position`, `content.fill`, `audio.volume`…). The same generic `AnimProp` shape serves every property. The metadata in `properties.ts` (label, unit, scrub step, range, reveal key) drives the UI. The graph editor and the preset engine use the same metadata.
- **Stack order**: `comp.layers[0]` is the top layer, as in AE's layer panel.

## Animation (`src/core/animation`)

Keyframes use the After Effects temporal-ease model:

- The outgoing side of a keyframe has a `speed` and an `influence`. So does the incoming side of the next keyframe.
- The speed is in value units per second, measured along the straight path between the two values.
- `segmentCurve` turns the two eases into a normalised cubic bezier. `evaluateProp` lerps every dimension by the same progress.

The AE model was chosen over storing CSS-style handles for two reasons:

- `.ffx` presets store keyframes this way, so they can map in without loss.
- The speed graph falls straight out of the data.

Holds and linear segments are special cases. Back easings fit in a cubic bezier with overshoot. Elastic and bounce can't, so they are stored as a function curve on the segment (`Keyframe.outCurve`); the graph editor can bake them into keys. `AnimProp.wiggle` adds a deterministic, AE-compatible `wiggle()` on top of the keyed value.

All keyframe operations are pure functions: `AnimProp → AnimProp`.

## Timeline editing (`src/core/timeline`)

`ops.ts` implements trim, ripple trim, split, ripple delete, extract range, slip, sequence, reorder and duplicate. They **mutate** the composition they receive and are written to run inside an immer recipe. They also work on plain objects in tests.

`snap.ts` collects snap targets (playhead, layer edges, markers, keyframes, beats, onsets, work area) and resolves ties by priority. Beats win ties, because beat-sync is the point of the tool.

## Audio analysis (`src/core/audio`, `src/workers`)

The worker receives the decoded channels as transferables and does two jobs.

**Waveform peaks**
- Builds a min/max pyramid; each level halves the resolution.
- The timeline draws from the level that matches its current zoom, so drawing costs O(visible pixels).

**Beat and onset detection**
1. Builds a log-magnitude spectral-flux onset envelope at about 100 Hz.
2. Picks onsets with an adaptive threshold.
3. Estimates the tempo by autocorrelation, weighted by a log-normal prior around 120 BPM.
4. Tracks beats with the Ellis (2007) dynamic-programming tracker.

Material without real transients (silence, pads, a steady tone) returns no grid. A `confidence` score reports how periodic the rhythm is.

## Rendering

### Evaluation (`src/core/render/evaluate.ts`)

`evaluateComposition(project, compId, t)` produces a `CompFrame`: a flat, bottom-to-top list of draw items. Each item carries:

- a world matrix (with the parent chain applied)
- a content rect in layer space
- opacity and blend mode
- content: shape parameters, a text spec, a media id with source time, or a nested `CompFrame` for a precomp

The evaluator is renderer-agnostic and runs anywhere.

### WebGL2 compositor (`src/engine/gl`)

Each layer is drawn as one quad:

- **Solids and shapes** use analytic signed-distance fields in the fragment shader. They stay crisp at any scale and need no textures.
- **Images** are uploaded once as premultiplied `ImageBitmap`s.
- **Video** frames are uploaded each frame from the playing element.
- **Text** is rasterised with Canvas2D at a resolution that matches its on-screen scale. It is cached by content key (LRU) and uploaded once.
- **Precomps** render into pooled offscreen targets and are then drawn as textures.

Layers render into an offscreen accumulation target. A plain layer with normal blending is drawn straight in. A layer with effects or another blend mode is isolated: it is drawn into its own target, run through its effect chain (pooled ping-pong targets) and composited with an exact W3C blend-mode shader (19 modes). Adjustment layers run their effects over the accumulated image below them, masked by their own alpha. Transition plugins receive from/to frames and are placed at a layer's in or out point.

**Preview resolution** is automatic by default: it is the viewer zoom × devicePixelRatio, rounded to quarter steps. A 1080×1920 comp shown at 35% therefore renders about a quarter of the pixels. This is the main lever for real-time 1080p preview on mid-range hardware. Full, Half and Quarter can also be forced.

### Media (`src/engine/media`)

`MediaEngine` owns blobs, object URLs, decoded stills, decoded `AudioBuffer`s and waveform peaks, all keyed by media id.

`VideoPool` keeps one muted `HTMLVideoElement` per on-screen video instance. The instance key is the precomp path plus the layer id, so the same video shown twice decodes independently.

- **While playing**, elements free-run on hardware decode. They are steered back towards the transport clock with small playback-rate nudges, and hard-seek only when the drift exceeds 200 ms.
- **While scrubbing**, seeks are coalesced. A redraw is requested when each seek lands.

Frame-exact random access, needed for export and optical-flow retiming, comes from `FrameSource`: a dedicated decoder element per media that seeks and waits for `requestVideoFrameCallback`, with the frame rate detected from the callback timestamps.

### Playback (`src/engine/playback`)

The **AudioContext clock is the master clock**, so picture follows sound. That matters most when cuts are placed on beats.

- `AudioEngine` flattens audible clips through precomps (`core/render/audioClips.ts`) and schedules `AudioBufferSourceNode`s sample-accurately.
- Keyframed volume becomes a `setValueCurveAtTime` automation curve.
- The transport loops the work area, follows the playhead in the timeline, and reschedules audio when the project changes mid-playback.

## Effects and plugins (`src/core/effects`, `src/effects`, `src/engine/plugins`)

An effect is data: an `EffectPlugin` with metadata, a parameter schema and one or more GLSL passes (or a WGSL shader). `effectRegistry` holds built-ins, bundled packs and installed plugins, and bumps a revision counter when a plugin changes, so the renderer recompiles and the UI refreshes (hot reload).

- **Parameters are properties.** An effect instance stores its parameters as `fx.<instanceId>.<paramId>` entries in `layer.props`, so they get keyframes, the graph editor and presets for free.
- **Shader contract**: a pass defines `vec4 effect(vec2 uv)` over a premultiplied input. Parameters become uniforms. A prelude supplies time, sizes and helpers.
- **Converter** (`convert.ts`): rewrites gl-transitions, ISF (including multi-pass) and Shadertoy sources into that contract and reports anything unsupported. The bundled packs are converted at load time.
- **WGSL** plugins run on WebGPU through a bridge: the WebGL texture is read back, processed by WebGPU and returned as an `ImageBitmap`.

The full format is in [PLUGINS.md](PLUGINS.md).

## Time remap and optical flow (`src/core/timeline/timeRemap.ts`, `src/core/flow`, `src/engine/flow`)

`time.remap` maps layer time to source time. Speed ramps are ordinary keyframes on it, so the speed graph is the playback speed. When a remapped time falls between two source frames, frame blending chooses nearest, a cross-fade, or optical flow.

- **Farnebäck flow** has a CPU reference (`core/flow/farneback.ts`, unit tested on synthetic motion) and a WebGPU compute port (`engine/flow/gpuFarneback.ts`) that matches it.
- **`FrameInterpolator`** synthesises in-between frames by warping the neighbouring source frames along the flow, and caches the results. Preview uses it asynchronously; export awaits it.
- **RIFE** is optional. ONNX Runtime Web is loaded from a CDN on demand, with a user-supplied model.

## Export and caches (`src/engine/export`, `src/engine/cache`)

- **`OfflineRenderer`** renders any comp time to an `OffscreenCanvas` with exact source frames and awaited flow. Export, RAM preview and proxies share it.
- **Encoding**: WebCodecs `VideoEncoder` / `AudioEncoder`, muxed with mp4-muxer or webm-muxer, or quantised with gifenc for GIF.
  - The H.264 profile and level are chosen from the frame size and rate.
  - If no H.264 encoder exists, MP4 falls back to VP9.
  - Audio is a sample-accurate `OfflineAudioContext` mixdown of the same clips playback uses.
- **Proxies**: 540p VP9 transcodes stored in IndexedDB, used by preview when the Proxy toggle is on.
- **RAM preview**: renders the work area into a `FrameCache` of `ImageBitmap`s. The cache is invalidated by any project change.

## Presets (`src/core/presets`, `src/presets`, `src/core/ffx`)

A `LuscentPreset` is JSON. The format is in [PRESETS.md](PRESETS.md).

- **`apply.ts`**: evaluates a preset's expressions against the comp (size, fps, beat length from the music analysis, current values) and writes keyframes, wiggles and effects into a layer. A speed ramp is integrated into Time Remap keys. Comp presets build new layers. Like the timeline ops, these functions mutate the object they receive. The store runs them on plain copies and swaps the results into the draft, so one application is one undo step.
- **`capture.ts`**: the inverse. It turns a layer's animation into a preset with times relative to its first key and native eases (`ae.native`).
- **After Effects import**:
  - `rifx.ts` parses the big-endian RIFF container shared by `.ffx` and `.aep`.
  - `properties.ts` decodes property groups and keyframe streams (`tdgp` / `tdbs` / `tdb4` / `ldat`) into values with AE speed/influence eases.
  - `import.ts` maps match names onto Luscent properties and effects, and records a mapped / approximated / unmapped report.
  - AE stores a speed per dimension; `apply.ts` projects it onto Luscent's single path speed.

## State and undo (`src/state/store.ts`)

There is a single zustand store. Every document change goes through one of two paths:

- `edit(label, recipe)` runs an immer recipe and pushes the previous project onto the history.
- `editFrom(base, label, recipe)` is for drags. It recomputes from the snapshot taken at pointer-down, so drags never accumulate rounding error. It runs inside a `beginGesture` / `endGesture` transaction, which collapses the whole drag into one undo step.

Snapshots share every subtree that didn't change, so the history costs little memory.

UI-only state is part of the store but not of undo:

- selection
- playhead
- zoom and scroll
- reveal filters
- snapping toggles

## Persistence (`src/engine/persist`)

IndexedDB holds five stores: `projects`, `media`, `library` (curves), `plugins` and `presets`.

- **Autosave**: shortly after each change (debounced), the project JSON and the imported media blobs are written to IndexedDB. Reloading restores the session.
- **Project file**: `serializeProject` writes `{ format, version, project }`. Non-finite numbers are tagged, since stills have infinite duration. `deserializeProject` is where future migrations hook in.
- **Missing media** can be relinked from the media list.
