/**
 * RIFX (big-endian RIFF) reader for After Effects files (.ffx presets and
 * .aep projects share the same chunk vocabulary).
 *
 * Layout notes follow the MIT-licensed py_aep reverse-engineering work
 * (https://github.com/forticheprod/py_aep).
 */
export interface RChunk {
  type: string;
  /** LIST/RIFX sub-type (e.g. "tdgp", "tdbs", "FaFX"). */
  list?: string;
  children?: RChunk[];
  /** Body bytes for leaf chunks. */
  data?: Uint8Array;
}

/** Leaf chunk types whose body is itself a sequence of chunks (no list type). */
const CONTAINERS = new Set(['tdsn', 'fnam', 'pdnm']);

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function parseChildren(bytes: Uint8Array, start: number, end: number, depth: number): RChunk[] {
  const out: RChunk[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start;
  while (p + 8 <= end) {
    const type = ascii(bytes, p, 4);
    const size = dv.getUint32(p + 4, false);
    const body = p + 8;
    if (body + size > end || !/^[\x20-\x7e]{4}$/.test(type)) break;
    if ((type === 'LIST' || type === 'RIFX') && size >= 4 && depth < 64) {
      const list = ascii(bytes, body, 4);
      // "btdk" lists hold raw binary; everything else nests chunks.
      out.push(list === 'btdk' ? { type, list, data: bytes.subarray(body + 4, body + size) } : { type, list, children: parseChildren(bytes, body + 4, body + size, depth + 1) });
    } else if (CONTAINERS.has(type)) {
      out.push({ type, children: parseChildren(bytes, body, body + size, depth + 1), data: bytes.subarray(body, body + size) });
    } else {
      out.push({ type, data: bytes.subarray(body, body + size) });
    }
    p = body + size + (size & 1);
  }
  return out;
}

export function parseRifx(input: ArrayBuffer | Uint8Array): RChunk {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFX') throw new Error('Not an After Effects file (missing RIFX header).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = Math.min(dv.getUint32(4, false), bytes.length - 8);
  return { type: 'RIFX', list: ascii(bytes, 8, 4), children: parseChildren(bytes, 12, 8 + size, 0) };
}

export function dataView(c: RChunk): DataView {
  const d = c.data!;
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}

/** Null-terminated string from a chunk body. */
export function cString(c: RChunk): string {
  const d = c.data ?? new Uint8Array();
  let end = d.indexOf(0);
  if (end < 0) end = d.length;
  return new TextDecoder('utf-8').decode(d.subarray(0, end));
}

/** UTF-8 text of a container's Utf8 child (tdsn / fnam) or a bare Utf8 chunk. */
export function utf8Of(c: RChunk | undefined): string | undefined {
  if (!c) return undefined;
  if (c.type === 'Utf8') return new TextDecoder('utf-8').decode(c.data);
  const u = c.children?.find((x) => x.type === 'Utf8');
  return u ? new TextDecoder('utf-8').decode(u.data) : undefined;
}

/** Depth-first search. */
export function findAll(root: RChunk, pred: (c: RChunk) => boolean, out: RChunk[] = []): RChunk[] {
  if (pred(root)) out.push(root);
  for (const c of root.children ?? []) findAll(c, pred, out);
  return out;
}
