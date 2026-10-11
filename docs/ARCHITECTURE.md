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
- **Properties** live in `layer.props` keyed by path (`transform.position`, `content.fill`, `audio.volume`…). The same generic `AnimProp` shape serves every property. The metadata in `properties.ts` (label, unit, scrub step, range, reveal key) drives the UI. The graph editor (phase 2) and the `.ffx` mapper (phase 4) will use the same metadata.
- **Stack order**: `comp.layers[0]` is the top layer, as in AE's layer panel.

## Animation (`src/core/animation`)

Keyframes use the After Effects temporal-ease model:

- The outgoing side of a keyframe has a `speed` and an `influence`. So does the incoming side of the next keyframe.
- The speed is in value units per second, measured along the straight path between the two values.
- `segmentCurve` turns the two eases into a normalised cubic bezier. `evaluateProp` lerps every dimension by the same progress.

The AE model was chosen over storing CSS-style handles for two reasons:

- `.ffx` presets store keyframes this way, so they can map in without loss.
- The speed graph falls straight out of the data.

Holds and linear segments are special cases. Overshooting easings (back, elastic, bounce) are planned as per-segment preset curves in phase 2.

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

Blending is fixed-function on premultiplied alpha. Exact non-separable blend modes and adjustment layers need shader ping-pong, which arrives with the effects pipeline (phase 3).

**Preview resolution** is automatic by default: it is the viewer zoom × devicePixelRatio, rounded to quarter steps. A 1080×1920 comp shown at 35% therefore renders about a quarter of the pixels. This is the main lever for real-time 1080p preview on mid-range hardware. Full, Half and Quarter can also be forced.

### Media (`src/engine/media`)

`MediaEngine` owns blobs, object URLs, decoded stills, decoded `AudioBuffer`s and waveform peaks, all keyed by media id.

`VideoPool` keeps one muted `HTMLVideoElement` per on-screen video instance. The instance key is the precomp path plus the layer id, so the same video shown twice decodes independently.

- **While playing**, elements free-run on hardware decode. They are steered back towards the transport clock with small playback-rate nudges, and hard-seek only when the drift exceeds 200 ms.
- **While scrubbing**, seeks are coalesced. A redraw is requested when each seek lands.

Frame-exact random access is needed for export and optical-flow retiming. It will come from a WebCodecs `VideoDecoder` behind the same `frame()` interface (phases 3 and 4).

### Playback (`src/engine/playback`)

The **AudioContext clock is the master clock**, so picture follows sound. That matters most when cuts are placed on beats.

- `AudioEngine` flattens audible clips through precomps (`core/render/audioClips.ts`) and schedules `AudioBufferSourceNode`s sample-accurately.
- Keyframed volume becomes a `setValueCurveAtTime` automation curve.
- The transport loops the work area, follows the playhead in the timeline, and reschedules audio when the project changes mid-playback.

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

- **Autosave**: shortly after each change (debounced), the project JSON and the imported media blobs are written to IndexedDB. Reloading restores the session.
- **Project file**: `serializeProject` writes `{ format, version, project }`. Non-finite numbers are tagged, since stills have infinite duration. `deserializeProject` is where future migrations hook in.
- **Missing media** can be relinked from the media list.
