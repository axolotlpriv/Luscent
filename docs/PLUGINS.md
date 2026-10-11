# Luscent effect plugins

A Luscent effect is plain JSON: metadata, a parameter schema, and shader code. Plugins can be:

- installed from a file, a URL or pasted text
- shared by exporting them as `.luscent-effect.json`
- edited in the **Shader Lab**, which reloads changes live on the selected layer

Open the manager with **✦ Plugins** in the top bar.

## File format

```json
{
  "format": "luscent-effect",
  "version": 1,
  "plugin": {
    "id": "you.neon-wobble",
    "name": "Neon Wobble",
    "version": "1.0.0",
    "kind": "effect",
    "category": "Stylize",
    "description": "Wobbly RGB offset.",
    "author": "You",
    "license": "MIT",
    "params": [
      { "id": "amount", "label": "Offset", "type": "pixels", "default": 12, "min": 0, "max": 100 },
      { "id": "speed", "label": "Speed", "type": "float", "default": 2, "min": 0, "max": 10 },
      { "id": "tint", "label": "Tint", "type": "color", "default": [1, 0.2, 0.6, 1] }
    ],
    "passes": [
      { "glsl": "vec4 effect(vec2 uv) { float w = sin(uv.y * 40.0 + time * speed * 6.28) * amount * compPx().x; vec4 c = texture(source, uv + vec2(w, 0.0)); return vec4(c.rgb * tint.rgb, c.a); }" }
    ]
  }
}
```

### Metadata

| field | |
|---|---|
| `id` | Unique. Use the form `author.effect-name`. Built-in ids can't be reused. |
| `kind` | `"effect"` processes a layer, or everything below it on an adjustment layer. `"transition"` blends two frames (see below). |
| `category`, `description`, `author`, `license`, `tags` | Shown in the library. Bundled third-party shaders keep their original author and license. |
| `params` | The parameter schema. |
| `passes` | GLSL passes, run in order. The last pass's output is the result. |
| `wgsl` | Optional WGSL shader, run on WebGPU. It is used when `passes` is empty. |

### Parameters

Every parameter becomes:

- an animatable property, with keyframes, the graph editor and presets
- a shader uniform with the same name as its `id`

| `type` | uniform | default | notes |
|---|---|---|---|
| `float`, `int`, `angle`, `percent`, `pixels` | `float` | number | `pixels` is in composition pixels. Multiply by `compPx()` to get uv units. |
| `bool` | `float` | 0 or 1 | Shown as a checkbox. |
| `choice` | `float` | option index | Needs `options: ["A", "B"]`. |
| `vec2` | `vec2` | `[x, y]` | Raw values. |
| `point` | `vec2` | `[x, y]` in 0..1 of the comp | Edited in comp pixels. The shader receives normalised uv. |
| `color` | `vec4` | `[r, g, b, a]` | Straight (not premultiplied) 0..1. |

Optional fields: `label`, `min`, `max`, `step` (scrub speed) and `hint`.

Ids must be valid GLSL identifiers. They can't be built-in names such as `length`, `distance` or `progress`.

## GLSL contract (WebGL2, GLSL ES 3.00)

Each pass provides:

```glsl
vec4 effect(vec2 uv);   // uv (0,0) is the TOP-LEFT of the frame
```

**Inputs** are `sampler2D` uniforms holding **premultiplied** RGBA:

- `source`: the layer being processed. On an adjustment layer, it is everything below it.
- `from`, `to`: for transitions.
- Earlier passes, by `id`, when listed in `inputs`.

**Built-in uniforms**: `resolution` (output size in device px), `compSize` (comp size in comp px), `renderScale`, `time` (comp seconds), `layerTime`, `progress` (transitions, 0 → 1), `seed`.

**Helpers** (the default `"prelude": "full"`):

- constants: `PI`, `TAU`
- coordinates: `compPx()`, `rot2(a)`, `inside(uv)`, `mirrorUV(uv)`
- noise: `hash11`, `hash12`, `hash22`, `noise1`, `noise2`
- colour: `luma`, `premultiply`, `unpremultiply`
- sampling: `sampleEdge(s, uv, mode)` (mode 0 transparent, 1 clamp, 2 mirror, 3 tile), `blur1D(s, uv, dir, radiusPx, edgeMode)`

With `"prelude": "minimal"`, only `lsc_premultiply` and `lsc_unpremultiply` are included. Ported shaders use this so their own helper names don't collide with Luscent's.

**Multiple passes**: give a pass an `id` and later passes can sample it. `scale` (0–1] renders that pass at a fraction of the frame size, which keeps big blurs cheap. Built-in Glow is four passes: threshold, horizontal blur, vertical blur, composite.

```json
"passes": [
  { "id": "bright", "scale": 0.5, "glsl": "vec4 effect(vec2 uv) { … texture(source, uv) … }" },
  { "id": "blur", "scale": 0.5, "inputs": ["bright"], "glsl": "…" },
  { "inputs": ["source", "blur"], "glsl": "…" }
]
```

## Transitions

A transition is added to a layer like any effect. It gets two extra parameters:

- `duration` (seconds)
- `placement`: **In** runs over the start of the layer. **Out** runs over its end.

During that window the renderer passes two frames:

- `from`: the composite without this layer.
- `to`: the composite with it.

`progress` runs from 0 to 1 across the window. To transition between two clips, add the transition to the upper clip with placement **In**, starting where the clips meet.

## WGSL contract (WebGPU)

```wgsl
fn effect(uv: vec2f) -> vec4f {
  return sampleSource(uv + vec2f(0.01 * sin(time), 0.0));
}
```

- Parameters and the built-ins (`resolution`, `compSize`, `renderScale`, `time`, `layerTime`, `progress`) are module-scope variables, named as in GLSL.
- `sampleSource(uv)` samples the input.
- WGSL plugins run on WebGPU through a bridge. The layer is read back from WebGL, processed with WebGPU, and uploaded again. That costs one GPU↔CPU round trip per frame, so prefer GLSL passes for heavy effects.
- If WebGPU is unavailable, the effect is skipped and the library flags it.

## Converter: porting existing shaders

**Install** and **Shader Lab** detect the format and convert it automatically:

| format | detected by | notes |
|---|---|---|
| **gl-transitions** | `vec4 transition(vec2)` and `getFromColor`/`getToColor` | `uniform` defaults come from `// = value` comments or the gl-transitions metadata. `int`, `bool`, `ivec2`, `vec3` and `vec4` uniforms are adapted. Transitions that need extra textures (`luma`, `displacement`) are reported as unsupported. |
| **ISF** (`.fs`) | `/*{ "INPUTS": … }*/` header | Supports float/bool/event/long/point2D/color inputs, `IMG_*` macros, `RENDERSIZE`, `TIME` and `PASSINDEX`, plus multi-pass `PASSES` with `TARGET`. Transitions are recognised by `startImage`/`endImage` or the category. Extra image inputs, audio and persistent buffers are reported. |
| **Shadertoy** | `void mainImage(out vec4, in vec2)` | `iResolution`, `iTime`, `iFrame` and `iDate` are provided. `iChannel0` is the layer, and texture coordinates are flipped to match. `iMouse` and `iChannel1-3` are reported. Output is opaque. |
| **Luscent GLSL** | `vec4 effect(vec2)` | The native contract. Annotated uniforms become parameters. |

Every format accepts annotated uniforms as parameters:

```glsl
uniform float amount; // = 0.5 [0, 1] Amount
uniform vec3 color;   // = vec3(1.0, 0.4, 0.2) Color
```

The format is `// = default [min, max] Label`. The range and label are optional.

Each conversion produces a report listing anything that was dropped or approximated. The original source is kept in `plugin.source.original`, so a plugin can be re-converted or edited later.

## Bundled shaders

- **Built-in effects and transitions** (29). Glow, chromatic aberration, RGB split, shake, transform, blurs, VHS, grain, glitch, lens distortion and more, written in this format by Luscent.
- **gl-transitions** (123 of 125). Converted at load time from the MIT-licensed [gl-transitions](https://github.com/gl-transitions/gl-transitions) package. Each keeps its author and license (MIT; one BSD-2, one BSD-3).
- **ISF samples** (5). Kaleidoscope, Halftone, Posterize, Edge Neon, and Soft Bloom (multi-pass). Authored in ISF and loaded through the converter.
- **Shadertoy samples** (2). Film Burn and CRT Screen.
- **WGSL sample** (1). Ripple, which runs on WebGPU.
