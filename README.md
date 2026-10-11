# Luscent

A browser-based motion editor in the spirit of After Effects, tuned for fast, punchy short-form edits (TikTok / Reels / Shorts). Everything runs client-side: TypeScript, React, WebGL2, WebGPU, WebCodecs, WebAudio, Web Workers and (optionally) ONNX Runtime Web.

> **Status: all four phases are in.** Timeline and preview, graph editor and easings, effects and plugins, presets and export. See [docs/ROADMAP.md](docs/ROADMAP.md) for what's done and what's next.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run build      # typecheck + production build
```

On first launch Luscent opens a small demo comp (no media needed). Drop video, audio or images anywhere on the window to import them. The session (project and media files) is autosaved to IndexedDB, so a reload brings everything back. **Save** writes a `.luscent.json` project file.

> Codec support is whatever your browser decodes and encodes. Chrome and Edge handle H.264/AAC MP4. Open-source Chromium builds only handle WebM/VP9/Opus; there, MP4 export falls back to VP9 in MP4.

## Deploying to Cloudflare Pages

Luscent is a static site: `npm run build` writes everything to `dist/`. `.github/workflows/deploy-pages.yml` tests, builds and deploys every push to `main` to `luscent.pages.dev`. On its first run it also creates the Pages project.

To turn it on, add two repository secrets under GitHub → Settings → Secrets and variables → Actions:

- `CLOUDFLARE_ACCOUNT_ID`: shown in the Cloudflare dashboard sidebar.
- `CLOUDFLARE_API_TOKEN`: a token with the **Cloudflare Pages: Edit** permission.

Until both secrets are set, the workflow still builds and tests, then skips the deploy with a warning. You can also deploy by hand with `npx wrangler pages deploy dist --project-name=luscent`.

## Features

### Timeline (phase 1)

- 9:16-first comp presets: 1080×1920 at 30/60, 4K vertical, 1:1, 4:5, 16:9
- Layer types: video, image, audio, text, rectangle/ellipse shapes, solid, null, adjustment and precomp
- Parenting, solo/lock/visibility/audio switches, label colours
- Precomps: pre-compose (⌘⇧C), nest by dragging, double-click to open, breadcrumbs
- Edits: move, trim, split (⌘⇧D / ⌘K), ripple trim, ripple delete, slip, sequence, extract work area, copy/paste, reorder
- Markers and work area
- Snapping to the playhead, edges, markers, keyframes, **detected beats and transients**
- Audio waveforms and a beat grid
- Keyframes: linear, bezier (AE speed/influence) and hold; easy ease (F9); AE-style reveal shortcuts (P S R T A U L)
- WebGL2 preview with automatic resolution, audio-clock playback, on-canvas dragging and safe-zone overlay
- Undo/redo for every edit

### Graph editor and easings (phase 2)

- Value and speed graphs (⇧F3), with bezier handles mapped onto AE speed/influence
- Easing presets: sine, quad, cubic, quart, quint, expo, circ, back, elastic, bounce, plus snap, punch and whip
  - Elastic and bounce are exact function curves and can be baked to keys
- A saveable custom curve library, with JSON import/export
- Keyframe velocity, copy/paste keyframes, a `wiggle()` modifier, motion paths in the viewer

### Effects and plugins (phase 3)

- Effect stacks on any layer, adjustment layers and 19 exact blend modes
- 21 built-in effects:
  - glow, chromatic aberration, RGB split, shake, VHS, grain, glitch, lens distortion
  - gaussian / directional / radial blur
  - transform, wave, mosaic, mirror, colour adjust, tint, invert, vignette, flash, drop shadow
- 8 transitions: whip, zoom, spin, flash, glitch, RGB split, push, dissolve
- **Optical-flow slow motion** (Twixtor-style):
  - Time Remap with speed ramps, freeze and reverse
  - Farnebäck flow on WebGPU compute, with a CPU fallback
  - Optional RIFE through ONNX Runtime Web
- **Plugin system**: a documented JSON + GLSL/WGSL format with install, share, hot reload and a live Shader Lab
  - Bundled packs: 123 gl-transitions, ISF and Shadertoy samples
  - A converter for gl-transitions, ISF, Shadertoy and GLSL
  - See [docs/PLUGINS.md](docs/PLUGINS.md)

### Presets and export (phase 4)

- **63 built-in presets**: shakes, flashes, zoom punches, velocity edits, transitions, text animations, looks
  - Beat presets lock to the music's tempo
- Presets panel with search and categories. Double-click to apply, or drag onto a timeline layer.
- **Save any layer's animation as a preset.** It keeps keyframes with their exact eases, wiggles, effects and speed ramps.
- Import and export Luscent JSON presets
- **After Effects `.ffx` / `.aep` import**: keyframes with exact eases, transform, time remap, common effects and expressions. A report lists everything that was approximated or not mapped. See [docs/PRESETS.md](docs/PRESETS.md).
- **Export** with WebCodecs:
  - MP4/H.264 up to 4K60 (level picked automatically), with AAC or Opus audio from a sample-accurate offline mixdown
  - WebM/VP9
  - GIF
  - 9:16 platform presets
- **Performance**:
  - automatic preview resolution
  - 540p proxy media
  - RAM preview of the work area, cached as GPU bitmaps

Press <kbd>?</kbd> in the app for all keyboard shortcuts.

## Project layout

```
src/
  core/        pure TypeScript, no DOM: model, animation, timeline ops, audio analysis,
               render evaluation, effects registry + shader converter, optical flow,
               presets, After Effects (RIFX) parser
  engine/      browser runtime: WebGL2 renderer, WebGPU bridge + flow, media decoding,
               playback, export, caches, persistence, plugin store
  effects/     built-in effects, transitions and bundled shader packs
  presets/     built-in presets
  workers/     audio analysis worker (waveform peaks + beat tracking)
  state/       zustand stores: editor actions + undo, curve and preset libraries
  ui/          React components (viewer, timeline, graph editor, panels, dialogs)
docs/          architecture, roadmap, plugin and preset formats
```

`core/` holds the logic and most of the unit tests. It never touches the DOM. More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Third-party material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Copyright (C) 2026 the Luscent contributors.

Luscent is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. See [LICENSE](LICENSE).

The AGPL also covers network use. If you run a modified version of Luscent where other people can use it, you must offer them the source code of that version.

Bundled third-party material keeps its own licenses (MIT and BSD). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
