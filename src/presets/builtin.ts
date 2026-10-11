/**
 * Built-in edit presets: shakes, flashes, zoom punches, velocity edits,
 * transitions, text animations and looks. Written in the public preset
 * format (core/presets/types.ts), so they double as examples.
 */
import type { LuscentPreset, PresetEffect, PresetKey, PresetLayerSpec, PresetProp, SpeedPoint } from '../core/presets/types';

type P = Omit<LuscentPreset, 'format' | 'version' | 'builtin'>;
const preset = (p: P): LuscentPreset => ({ format: 'luscent-preset', version: 1, builtin: true, ...p });

const k = (t: number | string, v: PresetKey['v'], ease?: string, interp?: PresetKey['interp']): PresetKey => ({ t, v, ease, interp });

// ------------------------------------------------------------------ shakes

const shakeFx = (amp: number | string, freq: number, rot: number, blur: number, decay: boolean, dur = 'dur'): PresetEffect => ({
  pluginId: 'luscent.shake',
  params: {
    frequency: { value: freq },
    rotation: { value: rot },
    blur: { value: blur },
    zoom: { value: 108 },
    shakeSeed: { value: Math.floor(Math.random() * 100) + 1 },
    amplitude: decay ? { keys: [k(0, amp, 'expo-out'), k(dur, 0)] } : { value: amp },
  },
});

const shakeAdj = (name: string, fx: PresetEffect, dur: number | string = 0.6): PresetLayerSpec[] => [{ kind: 'adjustment', name, duration: dur, effects: [fx] }];

const SHAKES: LuscentPreset[] = [
  preset({ id: 'shake.light', name: 'Shake — Light', category: 'Shake', target: 'comp', duration: 0.5, description: 'Subtle camera bump on an adjustment layer.', layers: shakeAdj('Shake Light', shakeFx(10, 9, 0.6, 30, true), 0.5) }),
  preset({ id: 'shake.medium', name: 'Shake — Medium', category: 'Shake', target: 'comp', duration: 0.6, layers: shakeAdj('Shake Medium', shakeFx(28, 11, 1.5, 50, true)) }),
  preset({ id: 'shake.heavy', name: 'Shake — Heavy', category: 'Shake', target: 'comp', duration: 0.8, layers: shakeAdj('Shake Heavy', shakeFx(60, 13, 3.5, 70, true), 0.8) }),
  preset({ id: 'shake.impact', name: 'Impact Hit', category: 'Shake', target: 'comp', duration: 0.4, description: 'One violent hit that dies fast — land it on a kick.', layers: shakeAdj('Impact', shakeFx(90, 18, 4, 80, true), 0.4) }),
  preset({ id: 'shake.earthquake', name: 'Earthquake', category: 'Shake', target: 'comp', duration: 2, layers: shakeAdj('Earthquake', shakeFx(45, 5, 2, 40, false), 2) }),
  preset({
    id: 'shake.handheld',
    name: 'Handheld Drift',
    category: 'Shake',
    target: 'layer',
    requires: ['visual'],
    description: 'Gentle continuous wiggle on position and rotation.',
    props: { 'transform.position': { wiggle: { freq: 1.2, amp: 10, octaves: 2 } }, 'transform.rotation': { wiggle: { freq: 0.8, amp: 0.6 } }, 'transform.scale': { mode: 'scale', value: 104 } },
  }),
  preset({ id: 'shake.rotational', name: 'Rotational Shake', category: 'Shake', target: 'comp', duration: 0.6, layers: shakeAdj('Rotational Shake', shakeFx(8, 10, 7, 60, true)) }),
  preset({
    id: 'shake.beat',
    name: 'Beat Shake (1 bar)',
    category: 'Shake',
    target: 'comp',
    duration: 'bar',
    description: 'A hit on every beat for one bar, timed to the detected tempo.',
    layers: shakeAdj(
      'Beat Shake',
      {
        pluginId: 'luscent.shake',
        params: {
          frequency: { value: 14 },
          rotation: { value: 1.5 },
          blur: { value: 60 },
          amplitude: {
            keys: [k(0, 40, 'expo-out'), k('beat*0.6', 0, undefined, 'hold'), k('beat', 40, 'expo-out'), k('beat*1.6', 0, undefined, 'hold'), k('beat*2', 40, 'expo-out'), k('beat*2.6', 0, undefined, 'hold'), k('beat*3', 40, 'expo-out'), k('beat*3.6', 0)],
          },
        },
      },
      'bar',
    ),
  }),
  preset({
    id: 'shake.bounce',
    name: 'Vertical Bounce',
    category: 'Shake',
    target: 'layer',
    requires: ['visual'],
    duration: 0.5,
    props: { 'transform.position': { mode: 'relative', keys: [k(0, [0, 0]), k('frame*2', [0, -40], 'quad-out'), k('frame*6', [0, 12], 'quad-inOut'), k('frame*10', [0, -6], 'quad-inOut'), k('frame*14', [0, 0])] } },
  }),
  preset({
    id: 'shake.drunk',
    name: 'Drunk Cam',
    category: 'Shake',
    target: 'comp',
    duration: 3,
    layers: [
      {
        kind: 'adjustment',
        name: 'Drunk Cam',
        effects: [
          { pluginId: 'luscent.transform', params: { rotation: { wiggle: { freq: 0.6, amp: 4 } }, scale: { value: 112 }, position: { wiggle: { freq: 0.4, amp: 30 } } } },
          { pluginId: 'luscent.blur.directional', params: { blurLength: { wiggle: { freq: 1, amp: 25 }, value: 10 } } },
        ],
      },
    ],
  }),
];

// ------------------------------------------------------------------ flashes

const flashLayer = (name: string, color: [number, number, number, number], keys: PresetKey[], dur: number | string, blend: 'add' | 'normal' = 'add'): PresetLayerSpec => ({
  kind: 'solid',
  name,
  color,
  blendMode: blend,
  duration: dur,
  props: { 'transform.opacity': { keys } },
});

const FLASHES: LuscentPreset[] = [
  preset({ id: 'flash.white', name: 'White Flash', category: 'Flash', target: 'comp', duration: 'frame*6', layers: [flashLayer('White Flash', [1, 1, 1, 1], [k(0, 100, 'expo-out'), k('frame*6', 0)], 'frame*6')] }),
  preset({ id: 'flash.fade-in', name: 'Flash Fade In', category: 'Flash', target: 'comp', duration: 0.5, layers: [flashLayer('Flash In', [1, 1, 1, 1], [k(0, 100, 'cubic-out'), k(0.5, 0)], 0.5, 'normal')] }),
  preset({ id: 'flash.pink', name: 'Color Flash — Pink', category: 'Flash', target: 'comp', duration: 'frame*8', layers: [flashLayer('Pink Flash', [1, 0.24, 0.5, 1], [k(0, 85, 'expo-out'), k('frame*8', 0)], 'frame*8')] }),
  preset({
    id: 'flash.strobe',
    name: 'Strobe',
    category: 'Flash',
    target: 'comp',
    duration: 'frame*16',
    layers: [flashLayer('Strobe', [1, 1, 1, 1], Array.from({ length: 8 }, (_, i) => [k(`frame*${i * 2}`, 100, undefined, 'hold'), k(`frame*${i * 2 + 1}`, 0, undefined, 'hold')]).flat(), 'frame*16')],
  }),
  preset({
    id: 'flash.beat',
    name: 'Beat Flash (1 bar)',
    category: 'Flash',
    target: 'comp',
    duration: 'bar',
    layers: [flashLayer('Beat Flash', [1, 1, 1, 1], [0, 1, 2, 3].flatMap((b) => [k(`beat*${b}`, 70, 'expo-out'), k(`beat*${b}+frame*5`, 0, undefined, 'hold')]), 'bar')],
  }),
  preset({
    id: 'flash.exposure-pop',
    name: 'Exposure Pop',
    category: 'Flash',
    target: 'layer',
    requires: ['visual'],
    duration: 0.35,
    effects: [{ pluginId: 'luscent.flash', params: { amount: { keys: [k(0, 100, 'expo-out'), k(0.35, 0)] } } }],
  }),
  preset({ id: 'flash.black-dip', name: 'Dip to Black', category: 'Flash', target: 'comp', duration: 0.4, layers: [flashLayer('Black Dip', [0, 0, 0, 1], [k(0, 0, 'sine-in'), k(0.2, 100, 'sine-out'), k(0.4, 0)], 0.4, 'normal')] }),
  preset({
    id: 'flash.light-leak',
    name: 'Light Leak Burst',
    category: 'Flash',
    target: 'comp',
    duration: 1,
    layers: [{ kind: 'adjustment', name: 'Light Leak', duration: 1, effects: [{ pluginId: 'shadertoy.film-burn', params: { intensity: { keys: [k(0, 0, 'cubic-out'), k(0.25, 1.6, 'cubic-inOut'), k(1, 0)] } } }] }],
  }),
];

// ------------------------------------------------------------------ zooms

const scaleKeys = (keys: PresetKey[]): Record<string, PresetProp> => ({ 'transform.scale': { mode: 'scale', keys } });
const ZOOMS: LuscentPreset[] = [
  preset({ id: 'zoom.punch-in', name: 'Zoom Punch In', category: 'Zoom', target: 'layer', requires: ['visual'], duration: 0.35, props: scaleKeys([k(0, 100, 'back-out'), k(0.35, 125)]) }),
  preset({ id: 'zoom.punch-out', name: 'Zoom Punch Out', category: 'Zoom', target: 'layer', requires: ['visual'], duration: 0.4, props: scaleKeys([k(0, 135, 'expo-out'), k(0.4, 100)]) }),
  preset({ id: 'zoom.punch-hold', name: 'Punch & Hold', category: 'Zoom', target: 'layer', requires: ['visual'], duration: 1, props: scaleKeys([k(0, 100, 'snap-inOut'), k('frame*3', 120, undefined, 'hold'), k(1, 120)]) }),
  preset({
    id: 'zoom.double-punch',
    name: 'Double Punch',
    category: 'Zoom',
    target: 'layer',
    requires: ['visual'],
    duration: 'beat*2',
    props: scaleKeys([k(0, 100, 'expo-out'), k('frame*4', 115, 'cubic-inOut'), k('beat', 108, 'expo-out'), k('beat+frame*4', 130, 'cubic-inOut'), k('beat*2', 100)]),
  }),
  preset({ id: 'zoom.bounce', name: 'Bounce Zoom', category: 'Zoom', target: 'layer', requires: ['visual'], duration: 0.8, props: scaleKeys([k(0, 70, 'elastic-out'), k(0.8, 100)]) }),
  preset({
    id: 'zoom.blur-punch',
    name: 'Zoom Blur Punch',
    category: 'Zoom',
    target: 'layer',
    requires: ['visual'],
    duration: 0.4,
    props: scaleKeys([k(0, 100, 'expo-out'), k(0.4, 118)]),
    effects: [{ pluginId: 'luscent.blur.radial', params: { mode: { value: 1 }, amount: { keys: [k(0, 35, 'expo-out'), k(0.4, 0)] } } }],
  }),
  preset({ id: 'zoom.slow-push', name: 'Slow Push In', category: 'Zoom', target: 'layer', requires: ['visual'], duration: 3, props: scaleKeys([k(0, 100, 'sine-inOut'), k(3, 112)]) }),
  preset({ id: 'zoom.snap', name: 'Snap Zoom', category: 'Zoom', target: 'layer', requires: ['visual'], duration: 0.25, props: scaleKeys([k(0, 100, 'whip-inOut'), k(0.25, 150)]) }),
  preset({
    id: 'zoom.beat-pulse',
    name: 'Beat Zoom Pulse (1 bar)',
    category: 'Zoom',
    target: 'layer',
    requires: ['visual'],
    duration: 'bar',
    props: scaleKeys([0, 1, 2, 3].flatMap((b) => [k(`beat*${b}`, 110, 'expo-out'), k(`beat*${b}+beat*0.8`, 100, undefined, 'linear')])),
  }),
  preset({ id: 'zoom.reveal', name: 'Zoom Out Reveal', category: 'Zoom', target: 'layer', requires: ['visual'], duration: 1.2, props: scaleKeys([k(0, 220, 'expo-out'), k(1.2, 100)]) }),
];

// ------------------------------------------------------------------ velocity (time remap)

const vel = (id: string, name: string, ramp: SpeedPoint[], description: string, flow = true): LuscentPreset =>
  preset({ id, name, category: 'Velocity', target: 'layer', requires: ['video'], speedRamp: ramp, frameBlending: flow ? 'optical-flow' : undefined, description });

const VELOCITY: LuscentPreset[] = [
  vel('vel.fast-slow', 'Ramp Fast → Slow', [{ at: 0, speed: 2.5 }, { at: 0.5, speed: 2.5 }, { at: 0.8, speed: 0.25 }], 'Rush in, then drop into slow motion.'),
  vel('vel.slow-fast', 'Ramp Slow → Fast', [{ at: 0, speed: 0.25 }, { at: 0.8, speed: 0.25 }, { at: 1.2, speed: 2.5 }], 'Hold the moment, then whip forward.'),
  vel('vel.hit', 'Velocity Hit', [{ at: 0, speed: 3 }, { at: 0.35, speed: 3 }, { at: 0.55, speed: 0.2 }, { at: 1.2, speed: 0.2 }, { at: 1.45, speed: 3 }], 'The classic edit: fast → slow-mo on the hit → fast.'),
  vel('vel.slowmo-25', 'Slow Motion 25%', [{ at: 0, speed: 0.25 }], '4× slow motion with optical-flow frames.'),
  vel('vel.slowmo-50', 'Slow Motion 50%', [{ at: 0, speed: 0.5 }], '2× slow motion with optical-flow frames.'),
  vel('vel.slowmo-10', 'Super Slow 10%', [{ at: 0, speed: 0.1 }], '10× slow motion — Twixtor territory.'),
  vel('vel.speed-2x', 'Speed Up 2×', [{ at: 0, speed: 2 }], 'Double speed.', false),
  vel('vel.freeze-go', 'Freeze & Go', [{ at: 0, speed: 1 }, { at: 0.05, speed: 0 }, { at: 0.8, speed: 0 }, { at: 0.95, speed: 1.5 }], 'Freeze on the moment, then launch.', false),
  vel('vel.ramp-freeze', 'Ramp to Freeze', [{ at: 0, speed: 1 }, { at: 0.6, speed: 0.05 }, { at: 0.7, speed: 0 }], 'Decelerate into a freeze frame.'),
  vel('vel.beat-ramp', 'Beat Ramp (1 bar)', [{ at: 0, speed: 2 }, { at: 'beat*0.5', speed: 0.3 }, { at: 'beat', speed: 2 }, { at: 'beat*1.5', speed: 0.3 }, { at: 'beat*2', speed: 2 }, { at: 'beat*2.5', speed: 0.3 }, { at: 'beat*3', speed: 2 }, { at: 'beat*3.5', speed: 0.3 }], 'Speed pulses locked to the tempo.'),
];

// ------------------------------------------------------------------ transitions

const tr = (id: string, name: string, pluginId: string, params: Record<string, PresetProp> = {}, duration = 0.4): LuscentPreset =>
  preset({
    id,
    name,
    category: 'Transitions',
    target: 'layer',
    requires: ['visual'],
    description: 'Apply to the incoming clip (the layer above), with the playhead at its first frame.',
    effects: [{ pluginId, params: { duration: { value: duration }, placement: { value: 0 }, ...params } }],
  });

const TRANSITIONS: LuscentPreset[] = [
  tr('tr.whip-left', 'Whip Left', 'luscent.transition.whip', { direction: { value: 0 } }),
  tr('tr.whip-right', 'Whip Right', 'luscent.transition.whip', { direction: { value: 1 } }),
  tr('tr.whip-up', 'Whip Up', 'luscent.transition.whip', { direction: { value: 2 } }),
  tr('tr.zoom-in', 'Zoom Through', 'luscent.transition.zoom', {}, 0.5),
  tr('tr.spin', 'Spin', 'luscent.transition.spin', {}, 0.5),
  tr('tr.glitch', 'Glitch Cut', 'luscent.transition.glitch', {}, 0.3),
  tr('tr.rgb', 'RGB Split Cut', 'luscent.transition.rgb-split', {}, 0.3),
  tr('tr.flash', 'Flash Cut', 'luscent.transition.flash', {}, 0.25),
  tr('tr.push', 'Push Left', 'luscent.transition.slide', { direction: { value: 0 } }, 0.35),
];

// ------------------------------------------------------------------ text

const TEXT: LuscentPreset[] = [
  preset({
    id: 'text.pop-in',
    name: 'Pop In',
    category: 'Text',
    target: 'layer',
    requires: ['visual'],
    duration: 0.35,
    props: { 'transform.scale': { mode: 'scale', keys: [k(0, 0, 'back-out'), k(0.35, 100)] }, 'transform.opacity': { keys: [k(0, 0), k('frame*3', 100)] } },
  }),
  preset({
    id: 'text.slide-up',
    name: 'Slide Up In',
    category: 'Text',
    target: 'layer',
    requires: ['visual'],
    duration: 0.5,
    props: { 'transform.position': { mode: 'relative', keys: [k(0, [0, 120], 'expo-out'), k(0.5, [0, 0])] }, 'transform.opacity': { keys: [k(0, 0, 'cubic-out'), k(0.3, 100)] } },
  }),
  preset({
    id: 'text.track-in',
    name: 'Tracking Collapse',
    category: 'Text',
    target: 'layer',
    requires: ['text'],
    duration: 0.8,
    props: { 'content.tracking': { keys: [k(0, 600, 'expo-out'), k(0.8, 'cur')] }, 'transform.opacity': { keys: [k(0, 0, 'cubic-out'), k(0.4, 100)] } },
  }),
  preset({
    id: 'text.blur-in',
    name: 'Blur In',
    category: 'Text',
    target: 'layer',
    requires: ['visual'],
    duration: 0.5,
    props: { 'transform.opacity': { keys: [k(0, 0, 'cubic-out'), k(0.35, 100)] } },
    effects: [{ pluginId: 'luscent.blur.gaussian', params: { radius: { keys: [k(0, 40, 'expo-out'), k(0.5, 0)] } } }],
  }),
  preset({
    id: 'text.bounce-in',
    name: 'Bounce In',
    category: 'Text',
    target: 'layer',
    requires: ['visual'],
    duration: 0.9,
    props: { 'transform.position': { mode: 'relative', keys: [k(0, [0, -400], 'bounce-out'), k(0.9, [0, 0])] } },
  }),
  preset({ id: 'text.wiggle', name: 'Wiggle', category: 'Text', target: 'layer', requires: ['visual'], props: { 'transform.rotation': { wiggle: { freq: 3, amp: 4 } } } }),
  preset({
    id: 'text.pop-out',
    name: 'Pop Out',
    category: 'Text',
    target: 'layer',
    requires: ['visual'],
    duration: 0.3,
    props: { 'transform.scale': { mode: 'scale', keys: [k(0, 100, 'back-in'), k(0.3, 0)] } },
  }),
  preset({
    id: 'text.glitch-in',
    name: 'Glitch In',
    category: 'Text',
    target: 'layer',
    requires: ['visual'],
    duration: 0.5,
    props: { 'transform.opacity': { keys: [k(0, 0, undefined, 'hold'), k('frame', 100, undefined, 'hold'), k('frame*2', 0, undefined, 'hold'), k('frame*4', 100)] } },
    effects: [{ pluginId: 'luscent.rgb-split', params: { offset: { keys: [k(0, 60, 'expo-out'), k(0.5, 0)] }, jitter: { value: 60 } } }],
  }),
];

// ------------------------------------------------------------------ looks

const adj = (name: string, effects: PresetEffect[], duration: number | string = 'dur'): PresetLayerSpec[] => [{ kind: 'adjustment', name, effects, duration }];

const LOOKS: LuscentPreset[] = [
  preset({
    id: 'look.vhs',
    name: 'VHS Look',
    category: 'Stylize',
    target: 'comp',
    duration: 5,
    layers: adj('VHS', [{ pluginId: 'luscent.vhs' }, { pluginId: 'luscent.chromatic-aberration', params: { amount: { value: 6 } } }, { pluginId: 'luscent.grain', params: { amount: { value: 15 } } }]),
  }),
  preset({
    id: 'look.glitch-burst',
    name: 'Glitch Burst',
    category: 'Stylize',
    target: 'comp',
    duration: 0.5,
    layers: adj('Glitch Burst', [{ pluginId: 'luscent.glitch', params: { amount: { keys: [k(0, 0, 'expo-out'), k(0.1, 100, 'cubic-inOut'), k(0.5, 0)] } } }]),
  }),
  preset({
    id: 'look.chroma-punch',
    name: 'Chromatic Punch',
    category: 'Stylize',
    target: 'comp',
    duration: 0.4,
    layers: adj('Chroma Punch', [{ pluginId: 'luscent.chromatic-aberration', params: { amount: { keys: [k(0, 60, 'expo-out'), k(0.4, 0)] } } }]),
  }),
  preset({
    id: 'look.glow-pulse',
    name: 'Glow Pulse (1 bar)',
    category: 'Stylize',
    target: 'layer',
    requires: ['visual'],
    duration: 'bar',
    effects: [{ pluginId: 'luscent.glow', params: { intensity: { keys: [0, 1, 2, 3].flatMap((b) => [k(`beat*${b}`, 3, 'expo-out'), k(`beat*${b}+beat*0.7`, 0.6)]) } } }],
  }),
  preset({ id: 'look.grain', name: 'Film Grain', category: 'Stylize', target: 'comp', duration: 5, layers: adj('Film Grain', [{ pluginId: 'luscent.grain', params: { amount: { value: 18 } } }]) }),
  preset({
    id: 'look.lens-hit',
    name: 'Lens Warp Hit',
    category: 'Stylize',
    target: 'comp',
    duration: 0.45,
    layers: adj('Lens Warp', [{ pluginId: 'luscent.lens-distortion', params: { amount: { keys: [k(0, 80, 'expo-out'), k(0.45, 0)] }, fringe: { keys: [k(0, 14, 'expo-out'), k(0.45, 0)] } } }]),
  }),
  preset({
    id: 'look.vignette-breathe',
    name: 'Vignette Breathe',
    category: 'Stylize',
    target: 'comp',
    duration: 'bar',
    layers: adj('Vignette', [{ pluginId: 'luscent.vignette', params: { amount: { keys: [0, 1, 2, 3].flatMap((b) => [k(`beat*${b}`, 75, 'sine-out'), k(`beat*${b}+beat*0.9`, 40)]) } } }]),
  }),
  preset({
    id: 'look.cinematic',
    name: 'Teal & Orange',
    category: 'Stylize',
    target: 'comp',
    duration: 5,
    layers: adj('Teal & Orange', [{ pluginId: 'luscent.tint', params: { black: { value: [0.02, 0.12, 0.16, 1] }, white: { value: [1, 0.86, 0.7, 1] }, amount: { value: 35 } } }, { pluginId: 'luscent.vignette', params: { amount: { value: 35 } } }]),
  }),
];

export const BUILTIN_PRESETS: LuscentPreset[] = [...SHAKES, ...FLASHES, ...ZOOMS, ...VELOCITY, ...TRANSITIONS, ...TEXT, ...LOOKS];
