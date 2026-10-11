# Presets

A Luscent preset is a small JSON file that animates the selected layers, or adds new layers, at the playhead. Luscent ships 63 built-in presets. You can save your own from any layer, share them as files, and import After Effects `.ffx` animation presets.

Open the **Presets** tab at the top of the left panel. Then:

- **Double-click** a preset to apply it at the playhead. A layer preset applies to the selected layers; a comp preset adds its layers.
- **Drag** a preset onto a layer in the timeline. It applies to that layer from the drop time.
- **Save layer…** stores the selected layer's animation as a preset.
- **Import…** reads Luscent `.json` presets and After Effects `.ffx` / `.aep` files.
- **⤓** exports one preset. **Export mine** writes all your presets into one bundle.

Applying a preset is one undo step.

## Built-in presets

| Category | Presets |
| --- | --- |
| Shake (10) | Light, Medium, Heavy, Impact Hit, Earthquake, Handheld Drift, Rotational, Beat Shake (1 bar), Vertical Bounce, Drunk Cam |
| Flash (8) | White Flash, Flash Fade In, Color Flash, Strobe, Beat Flash (1 bar), Exposure Pop, Dip to Black, Light Leak Burst |
| Zoom (10) | Punch In, Punch Out, Punch & Hold, Double Punch, Bounce Zoom, Zoom Blur Punch, Slow Push In, Snap Zoom, Beat Zoom Pulse, Zoom Out Reveal |
| Velocity (10) | Ramp Fast → Slow, Ramp Slow → Fast, Velocity Hit, Slow Motion 25 % / 50 %, Super Slow 10 %, Speed Up 2×, Freeze & Go, Ramp to Freeze, Beat Ramp |
| Transitions (9) | Whip Left / Right / Up, Zoom Through, Spin, Glitch Cut, RGB Split Cut, Flash Cut, Push Left |
| Text (8) | Pop In, Slide Up In, Tracking Collapse, Blur In, Bounce In, Wiggle, Pop Out, Glitch In |
| Stylize (8) | VHS Look, Glitch Burst, Chromatic Punch, Glow Pulse, Film Grain, Lens Warp Hit, Vignette Breathe, Teal & Orange |

- Shakes and flashes add an adjustment or solid layer, so they hit everything below them.
- Velocity presets write Time Remap keyframes and switch on optical-flow frame blending. They need a video or precomp layer.
- "Beat" presets read the tempo from the first analysed music track in the comp. Without one they assume 120 BPM.

## File format

```json
{
  "format": "luscent-preset",
  "version": 1,
  "id": "you.punch-wobble",
  "name": "Punch Wobble",
  "category": "My Presets",
  "description": "Zoom punch that settles with a wobble.",
  "target": "layer",
  "requires": ["visual"],
  "duration": "beat",
  "props": {
    "transform.scale": {
      "mode": "scale",
      "keys": [
        { "t": 0, "v": 100, "ease": "expo-out" },
        { "t": "beat/2", "v": 130, "ease": "elastic-out" },
        { "t": "beat", "v": 100 }
      ]
    },
    "transform.rotation": { "mode": "relative", "wiggle": { "freq": 8, "amp": 3 } }
  },
  "effects": [
    { "pluginId": "luscent.blur.radial", "params": { "amount": { "keys": [{ "t": 0, "v": 40 }, { "t": "frame*6", "v": 0 }] } } }
  ]
}
```

A file can also hold several presets: a JSON array, or `{ "format": "luscent-presets", "version": 1, "presets": [ … ] }`.

### Top-level fields

| Field | Meaning |
| --- | --- |
| `target` | `"layer"` animates the selected layers. `"comp"` adds the layers listed in `layers`. |
| `requires` | `"video"` (video or precomp), `"text"` or `"visual"` (anything but audio). Layers that don't match are skipped and listed in the toast. |
| `duration` | Length in seconds. It sets `dur` and the length of added layers. |
| `props` | Property path → property animation (see below). |
| `effects` | Effects appended to the layer: `pluginId` plus optional `params`, which are animated like props. Any installed plugin works. |
| `speedRamp` | `[{ "at": 0, "speed": 1 }, { "at": 0.3, "speed": 0.2 }]`. Playback speeds over time, integrated into Time Remap keyframes. |
| `frameBlending` | `"none"`, `"blend"` or `"optical-flow"`, used with `speedRamp`. |
| `layers` | Comp presets only. Each entry has `kind` (`solid`, `adjustment`, `text`, `rect`, `ellipse`, `null`), and optionally `name`, `text`, `color`, `blendMode`, `duration`, `props` and `effects`. |

### Property animation

| Field | Meaning |
| --- | --- |
| `mode` | `absolute` (default) sets values. `relative` adds them to the property's current value. `scale` treats them as a percentage of the current value. |
| `value` | A static value. |
| `keys` | Keyframes: `t` (seconds from the playhead), `v`, and optionally `interp` (`linear`, `bezier`, `hold`) and `ease`. |
| `ease` | Shapes the segment leaving the key. It takes an easing id (`expo-out`, `back-inOut`, `elastic-out`, `bounce-out`, `snap-inOut`, `punch-out`, `whip-inOut`…) or a cubic bezier `[x1, y1, x2, y2]`. |
| `ae` | An exact After Effects temporal ease (speed and influence per side). Imports and saved presets write it. |
| `wiggle` | `{ freq, amp, octaves?, ampMult?, seed? }`, the same as AE's `wiggle()`. |

Property paths are the ones in the timeline: `transform.position`, `transform.scale`, `transform.rotation`, `transform.opacity`, `transform.anchor`, `content.*` (fill, size, font size, tracking…) and `audio.volume`. Effect parameters use their parameter ids under `effects[].params`.

### Expressions

Any time or value can be a number or a small arithmetic expression. Expressions support `+ - * / ( )` and `min max abs round floor ceil sin cos sqrt`, plus these variables:

| Variable | Value |
| --- | --- |
| `w`, `h` | Composition size in px |
| `cx`, `cy` | Composition centre |
| `fps`, `frame` | Frame rate, and the length of one frame in seconds |
| `beat`, `bar` | Seconds per beat and per bar (4 beats), from the comp's music |
| `dur` | The preset's duration |
| `cur` | The property's current value, per component |

Examples: `"t": "frame*4"`, `"v": ["cur", "cur - h*0.1"]`, `"duration": "bar"`.

## Saving a layer as a preset

**Save layer…** captures the following from the selected layer:

- every keyframed property, with its exact eases and function curves
- wiggles
- enabled effects and their settings (static or keyframed)
- Time Remap, as a speed ramp

Times start at the layer's first keyframe. Position and anchor moves are saved as relative offsets, so the move replays from wherever the target layer sits.

User presets are kept in the browser (IndexedDB). Export them to keep a copy or to share them.

## After Effects import

Luscent reads the RIFX container that `.ffx` presets and `.aep` projects share. For an `.aep` it imports the most animated layer.

| After Effects | Luscent |
| --- | --- |
| Anchor Point, Position, Scale, Rotation, Opacity | Transform properties. Keyframes keep their exact speed/influence eases, hold and linear keys. |
| Separated Position X/Y | One position track (approximated) |
| Time Remapping | Speed ramp with optical-flow frame blending (approximated) |
| Audio Levels | Volume |
| Gaussian, Box, Motion and Radial Blur, CC Radial Fast Blur | Gaussian, directional and radial blur |
| Glow, Transform, Brightness & Contrast, Hue/Saturation, Exposure, Invert, Tint, Noise, Optics Compensation, Mosaic, Drop Shadow, Wave Warp | The matching built-in effect, with parameter values converted |
| Third-party shake, glow, chromatic aberration, glitch, lens, VHS, grain and blur plugins | The closest built-in at default settings, matched by name (approximated) |
| `wiggle(f, a)`, `time * n`, constant expressions | Wiggle, linear keys and static values |

When an import finishes, Luscent shows a report:

- **Mapped**: brought over exactly.
- **Approximated**: brought over, with the approximation named.
- **Not mapped**: dropped, for example masks, text animators, 3D rotation, unknown effects and other expressions.

The report stays attached to the imported preset.

The format notes follow the MIT-licensed [py_aep](https://github.com/forticheprod/py_aep) reverse-engineering work. The parser is tested against several of its sample projects.
