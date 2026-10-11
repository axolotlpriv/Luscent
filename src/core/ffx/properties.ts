/**
 * After Effects property trees (tdgp groups / tdbs streams) → plain objects
 * with keyframes in seconds and AE temporal eases.
 */
import { cString, dataView, utf8Of, type RChunk } from './rifx';

export type AeInterp = 'linear' | 'bezier' | 'hold';

export interface AeEase {
  speed: number;
  /** 0..1 (stored as a fraction in the file; AE shows percent). */
  influence: number;
}

export interface AeKey {
  time: number;
  value: number[];
  inInterp: AeInterp;
  outInterp: AeInterp;
  /** One ease per dimension for non-spatial vectors, otherwise one. */
  inEase: AeEase[];
  outEase: AeEase[];
}

export interface AeProp {
  kind: 'prop';
  matchName: string;
  name?: string;
  dims: number;
  color: boolean;
  spatial: boolean;
  /** Keyframe ticks per second (tdb4 time base). */
  timeBase: number;
  staticValue: number[] | null;
  keys: AeKey[];
  expression?: string;
}

export interface AeEffectParamDef {
  matchName: string;
  name: string;
  type: number;
}

export interface AeGroup {
  kind: 'group';
  matchName: string;
  name?: string;
  children: AeNode[];
  /** Present on effect instances (LIST sspc). */
  effect?: { displayName?: string; params: AeEffectParamDef[] };
}

export interface AeUnsupported {
  kind: 'unsupported';
  matchName: string;
  listType: string;
}

export type AeNode = AeProp | AeGroup | AeUnsupported;

const INTERP: Record<number, AeInterp> = { 1: 'linear', 2: 'bezier', 3: 'hold' };

interface Tdb4 {
  dims: number;
  spatial: boolean;
  color: boolean;
  timeBase: number;
  animated: boolean;
}

function readTdb4(c: RChunk): Tdb4 {
  const dv = dataView(c);
  const spatialFlags = dv.getUint8(5);
  const typeFlags = dv.byteLength > 59 ? dv.getUint8(59) : 0;
  return {
    dims: dv.getUint16(2, false),
    spatial: (spatialFlags & (1 << 3)) !== 0,
    color: (typeFlags & 1) !== 0,
    timeBase: dv.getUint32(12, false),
    animated: dv.byteLength > 68 ? dv.getUint8(68) !== 0 : false,
  };
}

function readDoubles(c: RChunk): number[] {
  const dv = dataView(c);
  const out: number[] = [];
  for (let o = 0; o + 8 <= dv.byteLength; o += 8) out.push(dv.getFloat64(o, false));
  return out;
}

/** Item layouts from lhd3 (raw type, item size). */
type ItemType = 'color' | 'three_d' | 'three_d_spatial' | 'two_d' | 'two_d_spatial' | 'one_d' | 'no_value' | 'orientation' | 'marker' | 'shape' | 'unknown';

function itemType(raw: number, size: number, spatial: boolean): ItemType {
  if (raw !== 4) return 'unknown';
  switch (size) {
    case 152:
      return 'color';
    case 128:
      return spatial ? 'three_d_spatial' : 'three_d';
    case 104:
      return 'two_d_spatial';
    case 88:
      return 'two_d';
    case 48:
      return 'one_d';
    case 80:
      return 'orientation';
    case 64:
      return 'no_value';
    case 16:
      return 'marker';
    case 8:
      return 'shape';
  }
  return 'unknown';
}

function readKeys(list: RChunk, tdb4: Tdb4): AeKey[] | null {
  const lhd3 = list.children?.find((c) => c.type === 'lhd3');
  const ldat = list.children?.find((c) => c.type === 'ldat');
  if (!lhd3 || !ldat) return null;
  const h = dataView(lhd3);
  const count = h.getUint32(8, false);
  const size = h.getUint32(16, false);
  const raw = h.getUint8(23);
  const type = itemType(raw, size, tdb4.spatial);
  if (type === 'unknown' || type === 'marker' || type === 'shape' || type === 'no_value' || type === 'orientation') return null;
  const dv = dataView(ldat);
  const base = tdb4.timeBase || 30720;
  const keys: AeKey[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * size;
    if (o + size > dv.byteLength) break;
    const time = dv.getInt32(o, false) / base;
    const inInterp = INTERP[dv.getUint8(o + 4)] ?? 'linear';
    const outInterp = INTERP[dv.getUint8(o + 5)] ?? 'linear';
    const d = (k: number) => dv.getFloat64(o + 8 + k * 8, false);
    let value: number[];
    let inEase: AeEase[];
    let outEase: AeEase[];
    if (type === 'color') {
      // u8 unknown, f8 unknown, in speed, in influence, out speed, out influence, A R G B (0-255)
      inEase = [{ speed: d(2), influence: d(3) }];
      outEase = [{ speed: d(4), influence: d(5) }];
      const [a, r, g, b] = [d(6), d(7), d(8), d(9)];
      value = [r / 255, g / 255, b / 255, a / 255];
    } else if (type === 'two_d_spatial' || type === 'three_d_spatial') {
      const n = type === 'two_d_spatial' ? 2 : 3;
      // 8 bytes of flags, then: unknown, in speed, in inf, out speed, out inf, value[n], tangents…
      const s = (k: number) => dv.getFloat64(o + 16 + k * 8, false);
      inEase = [{ speed: s(1), influence: s(2) }];
      outEase = [{ speed: s(3), influence: s(4) }];
      value = Array.from({ length: n }, (_, j) => s(5 + j));
    } else {
      const n = type === 'one_d' ? 1 : type === 'two_d' ? 2 : 3;
      value = Array.from({ length: n }, (_, j) => d(j));
      inEase = Array.from({ length: n }, (_, j) => ({ speed: d(n + j), influence: d(2 * n + j) }));
      outEase = Array.from({ length: n }, (_, j) => ({ speed: d(3 * n + j), influence: d(4 * n + j) }));
    }
    keys.push({ time, value, inInterp, outInterp, inEase, outEase });
  }
  return keys;
}

function readStream(matchName: string, tdbs: RChunk): AeProp {
  const kids = tdbs.children ?? [];
  const tdb4c = kids.find((c) => c.type === 'tdb4');
  const tdb4: Tdb4 = tdb4c ? readTdb4(tdb4c) : { dims: 1, spatial: false, color: false, timeBase: 0, animated: false };
  const cdat = kids.find((c) => c.type === 'cdat');
  let staticValue = cdat ? readDoubles(cdat) : null;
  if (staticValue && tdb4.color && staticValue.length >= 4) {
    const [a, r, g, b] = staticValue;
    staticValue = [r / 255, g / 255, b / 255, a / 255];
  }
  const list = kids.find((c) => c.type === 'LIST' && c.list === 'list');
  const keys = list ? (readKeys(list, tdb4) ?? []) : [];
  const expr = kids.find((c) => c.type === 'Utf8');
  return {
    kind: 'prop',
    matchName,
    name: utf8Of(kids.find((c) => c.type === 'tdsn')),
    dims: tdb4.dims,
    color: tdb4.color,
    spatial: tdb4.spatial,
    timeBase: tdb4.timeBase,
    staticValue,
    keys,
    expression: expr ? utf8Of(expr) : undefined,
  };
}

function readParamDefs(parT: RChunk | undefined): AeEffectParamDef[] {
  const out: AeEffectParamDef[] = [];
  const kids = parT?.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type !== 'tdmn') continue;
    const mn = cString(kids[i]);
    const pard = kids[i + 1]?.type === 'pard' ? kids[i + 1] : undefined;
    if (!pard?.data || pard.data.length < 48) continue;
    const type = pard.data[15];
    const name = new TextDecoder('latin1').decode(pard.data.subarray(16, 48)).replace(/\0[\s\S]*$/, '');
    out.push({ matchName: mn, name, type });
  }
  return out;
}

/** Parse the children of a property group LIST (tdgp). */
export function readGroup(matchName: string, tdgp: RChunk, name?: string): AeGroup {
  const group: AeGroup = { kind: 'group', matchName, name, children: [] };
  const kids = tdgp.children ?? [];
  let current: string | null = null;
  for (const c of kids) {
    if (c.type === 'tdmn') {
      const mn = cString(c);
      current = mn === 'ADBE Group End' ? null : mn;
      continue;
    }
    if (!current || c.type !== 'LIST') continue;
    if (c.list === 'tdgp') group.children.push(readGroup(current, c));
    else if (c.list === 'tdbs') group.children.push(readStream(current, c));
    else if (c.list === 'sspc') {
      const inner = c.children?.find((x) => x.type === 'LIST' && x.list === 'tdgp');
      const g = inner ? readGroup(current, inner) : { kind: 'group' as const, matchName: current, children: [] };
      g.effect = {
        displayName: utf8Of(c.children?.find((x) => x.type === 'fnam')),
        params: readParamDefs(c.children?.find((x) => x.type === 'LIST' && x.list === 'parT')),
      };
      group.children.push(g);
    } else group.children.push({ kind: 'unsupported', matchName: current, listType: c.list ?? '?' });
    current = null;
  }
  return group;
}

/** Find a direct or nested child by match name. */
export function child(g: AeGroup, matchName: string): AeNode | undefined {
  return g.children.find((c) => c.matchName === matchName);
}
