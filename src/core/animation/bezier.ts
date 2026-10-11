/**
 * Cubic bezier helpers for temporal interpolation.
 *
 * A temporal segment is a 1-D cubic in (time, value) space with control points
 * P0=(0,0), P1=(x1,y1), P2=(x2,y2), P3=(1,1) after normalisation. x must be
 * monotonic for the curve to be a function of time, which is guaranteed when
 * 0 <= x1, x2 <= 1 (we clamp influences into that range).
 */

function sampleCurve(a: number, b: number, c: number, t: number): number {
  return ((a * t + b) * t + c) * t;
}

function sampleDerivative(a: number, b: number, c: number, t: number): number {
  return (3 * a * t + 2 * b) * t + c;
}

/**
 * Evaluate a unit cubic bezier (CSS `cubic-bezier(x1,y1,x2,y2)` semantics) at
 * normalised time `x` in [0,1]. y values may leave [0,1] (overshoot).
 */
export function cubicBezierAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  // Newton-Raphson, falling back to bisection for flat regions.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleCurve(ax, bx, cx, t) - x;
    if (Math.abs(err) < 1e-7) return sampleCurve(ay, by, cy, t);
    const d = sampleDerivative(ax, bx, cx, t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sampleCurve(ax, bx, cx, t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleCurve(ay, by, cy, t);
}

/** Slope dy/dx of the unit bezier at normalised time x. */
export function cubicBezierSlope(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const h = 1e-4;
  const a = cubicBezierAt(x1, y1, x2, y2, Math.max(0, x - h));
  const b = cubicBezierAt(x1, y1, x2, y2, Math.min(1, x + h));
  return (b - a) / (Math.min(1, x + h) - Math.max(0, x - h));
}
