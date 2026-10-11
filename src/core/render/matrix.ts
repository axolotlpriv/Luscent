/**
 * 2D affine matrices as [a, b, c, d, e, f] (canvas convention):
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Mat2D = [number, number, number, number, number, number];

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function translate(x: number, y: number): Mat2D {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx: number, sy: number): Mat2D {
  return [sx, 0, 0, sy, 0, 0];
}

/** Rotation in degrees, clockwise on screen (y down), like After Effects. */
export function rotate(deg: number): Mat2D {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export function apply(m: Mat2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Mat2D): Mat2D | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

/** Layer matrix: T(position) · R(rotation) · S(scale%) · T(-anchor). */
export function layerMatrix(anchor: [number, number], position: [number, number], scalePct: [number, number], rotationDeg: number): Mat2D {
  return multiply(
    multiply(translate(position[0], position[1]), rotate(rotationDeg)),
    multiply(scale(scalePct[0] / 100, scalePct[1] / 100), translate(-anchor[0], -anchor[1])),
  );
}

/** Largest axis scale factor of a matrix (for choosing raster resolution). */
export function maxScale(m: Mat2D): number {
  return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
}
