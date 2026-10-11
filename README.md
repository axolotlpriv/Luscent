# Luscent

A browser-based motion editor in the spirit of After Effects, tuned for fast, punchy short-form edits (TikTok / Reels / Shorts). Everything runs client-side: TypeScript, React, WebGL2 (WebGPU arrives with the effects pipeline), WebAudio, Web Workers.

> **Status: phase 1 of 4 — timeline, keyframes and real-time preview.** See [docs/ROADMAP.md](docs/ROADMAP.md) for what is next.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run build      # typecheck + production build
```

On first launch Luscent opens a small demo comp (no media needed). Drop video, audio or images anywhere on the window to import them. The session (project + media files) is autosaved to IndexedDB, so a reload brings everything back. **Save** writes a `.luscent.json` project file.

> Codec support is whatever your browser decodes. Chrome/Edge handle H.264/AAC MP4; open-source Chromium builds only handle WebM/VP9/Opus.

## What works in phase 1

**Compositions & layers**
- 9:16-first comp presets (1080×1920 at 30/60, 4K vertical, 1:1, 4:5, 16:9)
- Layer types: video, image, audio, text, rectangle/ellipse shapes (SDF-rendered, rounded corners, stroke), solid, null, precomp
- Parenting, blend modes (normal, add, screen, multiply, lighten), solo/lock/visibility/audio switches, label colours
- Precomps: pre-compose a selection (⌘⇧C), nest comps by dragging them onto the timeline, double-click to open, breadcrumb navigation

**Timeline**
- Move, trim, split (⌘⇧D / ⌘K, or blade everything under the playhead), ripple trim (Alt or the Ripple toggle), ripple delete (⇧⌫), slip (Alt-drag a clip), sequence layers, extract the work area, duplicate, copy/paste, drag to reorder
- Markers (M, drag, rename), work area (B / N, drag)
- Snapping to the playhead, layer edges, markers, work area, keyframes, **detected beats and transients** (⌘/Ctrl inverts while dragging)
- Audio waveforms drawn from a peak pyramid, beat grid on the ruler and across tracks, "markers every bar/beat"
- Zoom with Ctrl/⌘ + wheel, `=` / `-`, `\` to fit

**Keyframes**
- Stopwatch per property, ◀ ◆ ▶ keyframe navigation, value scrubbing (Shift ×10, Alt ×0.1, type maths like `1920/2`)
- Linear, bezier (After Effects speed/influence model) and hold interpolation, Easy Ease / In / Out (F9)
- Drag and marquee-select keyframes, reveal properties AE-style (P S R T A, U for animated, L for volume)

**Preview**
- WebGL2 compositor with automatic preview resolution, render-target pooling, cached text and image textures
- On-canvas selection and drag-to-move (parent-aware), TikTok/Reels/Shorts safe-zone overlay
- Audio-clock-driven playback with work-area looping, sample-accurate WebAudio scheduling and keyframed volume
- Undo/redo for every edit; a drag is a single undo step

Press <kbd>?</kbd> in the app for all keyboard shortcuts.

## Project layout

```
src/
  core/        pure TypeScript, no DOM: model, animation, timeline ops, audio analysis, render evaluation
  engine/      browser runtime: WebGL2 renderer, media decoding, playback, persistence
  workers/     audio analysis worker (waveform peaks + beat tracking)
  state/       zustand store and every user action
  ui/          React components (viewer, timeline, panels)
docs/          architecture notes and roadmap
```

`core/` holds the logic and the unit tests. It never touches the DOM, so the same code can later drive headless export in a worker. More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
