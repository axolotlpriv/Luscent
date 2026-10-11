/**
 * Easing preset library.
 *
 * Curves that a single cubic bezier can express (sine…expo, circ, back) are
 * stored as bezier control points and applied to keyframes as After Effects
 * speed/influence, so they stay editable in the graph editor. Curves that
 * bounce or oscillate (elastic, bounce) cannot be one cubic; they are stored
 * on the keyframe as `outCurve` and evaluated as functions (and can be baked
 * into regular keyframes).
 *
 * Bezier approximations follow the widely used easings.net set.
 */
export type Bezier = [number, number, number, number];

export type EaseDirection = 'in' | 'out' | 'inOut';

interface Base {
  id: string;
  label: string;
  family: string;
  direction: EaseDirection;
}
export interface BezierEasing extends Base {
  kind: 'bezier';
  bezier: Bezier;
}
export interface FnEasing extends Base {
  kind: 'fn';
  fn: (x: number) => number;
}
export type EasingDef = BezierEasing | FnEasing;

const B = (family: string, direction: EaseDirection, bezier: Bezier, label?: string): BezierEasing => ({
  id: `${family}-${direction}`,
  label: label ?? `${family[0].toUpperCase()}${family.slice(1)} ${direction === 'inOut' ? 'In-Out' : direction === 'in' ? 'In' : 'Out'}`,
  family,
  direction,
  kind: 'bezier',
  bezier,
});

function bounceOut(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

function elasticOut(x: number): number {
  const c4 = (2 * Math.PI) / 3;
  return x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}
function elasticIn(x: number): number {
  const c4 = (2 * Math.PI) / 3;
  return x <= 0 ? 0 : x >= 1 ? 1 : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4);
}
function elasticInOut(x: number): number {
  const c5 = (2 * Math.PI) / 4.5;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x < 0.5
    ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
    : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1;
}

const F = (family: string, direction: EaseDirection, fn: (x: number) => number): FnEasing => ({
  id: `${family}-${direction}`,
  label: `${family[0].toUpperCase()}${family.slice(1)} ${direction === 'inOut' ? 'In-Out' : direction === 'in' ? 'In' : 'Out'}`,
  family,
  direction,
  kind: 'fn',
  fn,
});

export const EASINGS: EasingDef[] = [
  B('linear', 'inOut', [1 / 3, 1 / 3, 2 / 3, 2 / 3], 'Linear'),
  B('ease', 'inOut', [1 / 3, 0, 2 / 3, 1], 'Easy Ease'),
  B('ease', 'in', [1 / 3, 0, 2 / 3, 2 / 3], 'Easy Ease In'),
  B('ease', 'out', [1 / 3, 1 / 3, 2 / 3, 1], 'Easy Ease Out'),
  B('sine', 'in', [0.12, 0, 0.39, 0]),
  B('sine', 'out', [0.61, 1, 0.88, 1]),
  B('sine', 'inOut', [0.37, 0, 0.63, 1]),
  B('quad', 'in', [0.11, 0, 0.5, 0]),
  B('quad', 'out', [0.5, 1, 0.89, 1]),
  B('quad', 'inOut', [0.45, 0, 0.55, 1]),
  B('cubic', 'in', [0.32, 0, 0.67, 0]),
  B('cubic', 'out', [0.33, 1, 0.68, 1]),
  B('cubic', 'inOut', [0.65, 0, 0.35, 1]),
  B('quart', 'in', [0.5, 0, 0.75, 0]),
  B('quart', 'out', [0.25, 1, 0.5, 1]),
  B('quart', 'inOut', [0.76, 0, 0.24, 1]),
  B('quint', 'in', [0.64, 0, 0.78, 0]),
  B('quint', 'out', [0.22, 1, 0.36, 1]),
  B('quint', 'inOut', [0.83, 0, 0.17, 1]),
  B('expo', 'in', [0.7, 0, 0.84, 0]),
  B('expo', 'out', [0.16, 1, 0.3, 1]),
  B('expo', 'inOut', [0.87, 0, 0.13, 1]),
  B('circ', 'in', [0.55, 0, 1, 0.45]),
  B('circ', 'out', [0, 0.55, 0.45, 1]),
  B('circ', 'inOut', [0.85, 0, 0.15, 1]),
  B('back', 'in', [0.36, 0, 0.66, -0.56]),
  B('back', 'out', [0.34, 1.56, 0.64, 1]),
  B('back', 'inOut', [0.68, -0.6, 0.32, 1.6]),
  F('elastic', 'in', elasticIn),
  F('elastic', 'out', elasticOut),
  F('elastic', 'inOut', elasticInOut),
  F('bounce', 'in', (x) => 1 - bounceOut(1 - x)),
  F('bounce', 'out', bounceOut),
  F('bounce', 'inOut', (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2)),
  // Short-form specials: hard snaps and punchy overshoots.
  B('snap', 'inOut', [0.9, 0, 0.1, 1], 'Snap'),
  B('punch', 'out', [0.2, 1.9, 0.45, 1], 'Punch Out'),
  B('whip', 'inOut', [0.95, 0, 0.05, 1], 'Whip'),
];

const BY_ID = new Map(EASINGS.map((e) => [e.id, e]));

export function easingById(id: string): EasingDef | undefined {
  return BY_ID.get(id);
}

export const EASING_FAMILIES = [...new Set(EASINGS.map((e) => e.family))];

/** Function curves keyed by id (what `Keyframe.outCurve` may reference). */
export function curveFn(id: string): ((x: number) => number) | null {
  const e = BY_ID.get(id);
  return e && e.kind === 'fn' ? e.fn : null;
}
