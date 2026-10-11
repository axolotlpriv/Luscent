/**
 * `.lsp` — the Luscent project file.
 *
 * Layout (all integers little-endian):
 *
 *   bytes 0-3   magic "LSP" + format byte (1)
 *   bytes 4-7   header length N
 *   bytes 8..   header: UTF-8 JSON { format, version, savedAt, project, media }
 *   then        media blobs back to back; `media[i].offset/size` index into
 *               this section
 *
 * Media is optional: a project saved without it still opens and asks to relink
 * the files. Blobs are never read into memory while saving or opening; they are
 * sliced out of the file on demand.
 *
 * Files from before the format existed (`*.luscent.json`) are still accepted.
 */
import type { MediaItem, Project } from './types';
import { PROJECT_FORMAT, PROJECT_VERSION, checkAndMigrate, jsonReplacer, jsonReviver } from './serialize';

export const LSP_EXTENSION = '.lsp';
export const LSP_MIME = 'application/x-luscent-project';
const MAGIC = [0x4c, 0x53, 0x50, 0x01]; // "LSP\x01"

export interface LspMediaEntry {
  id: string;
  name: string;
  mimeType: string;
  offset: number;
  size: number;
}

interface LspHeader {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  app: string;
  project: Project;
  media: LspMediaEntry[];
}

export interface LspContents {
  project: Project;
  /** Embedded media blobs by media id (empty when saved without media). */
  media: Map<string, Blob>;
  savedAt: string;
}

/** Build a project file. `media` is the embedded blobs, keyed by media id. */
export function encodeLsp(project: Project, media: Array<{ id: string; blob: Blob }> = []): Blob {
  const entries: LspMediaEntry[] = [];
  let offset = 0;
  for (const m of media) {
    const item: MediaItem | undefined = project.media[m.id];
    entries.push({ id: m.id, name: item?.name ?? m.id, mimeType: m.blob.type || item?.mimeType || 'application/octet-stream', offset, size: m.blob.size });
    offset += m.blob.size;
  }
  const header: LspHeader = { format: PROJECT_FORMAT, version: PROJECT_VERSION, savedAt: new Date().toISOString(), app: 'luscent', project, media: entries };
  const json = new TextEncoder().encode(JSON.stringify(header, jsonReplacer));
  const prefix = new Uint8Array(8);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint32(4, json.length, true);
  return new Blob([prefix, json, ...media.map((m) => m.blob)], { type: LSP_MIME });
}

/** Read a `.lsp` file (or a legacy `.luscent.json`). */
export async function decodeLsp(file: Blob): Promise<LspContents> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head.length >= 4 && MAGIC.every((b, i) => head[i] === b)) {
    const len = new DataView(head.buffer).getUint32(4, true);
    if (8 + len > file.size) throw new Error('This project file is damaged (it ends too early).');
    const header = JSON.parse(await file.slice(8, 8 + len).text(), jsonReviver) as LspHeader;
    const project = checkAndMigrate(header);
    const base = 8 + len;
    const media = new Map<string, Blob>();
    for (const e of header.media ?? []) {
      if (base + e.offset + e.size > file.size) continue; // truncated: treat as missing media
      media.set(e.id, file.slice(base + e.offset, base + e.offset + e.size, e.mimeType));
    }
    return { project, media, savedAt: header.savedAt };
  }
  // Legacy JSON project (no embedded media).
  const text = await file.text();
  if (text.trimStart().startsWith('{')) {
    const parsed = JSON.parse(text, jsonReviver) as { savedAt?: string };
    return { project: checkAndMigrate(parsed as Parameters<typeof checkAndMigrate>[0]), media: new Map(), savedAt: parsed.savedAt ?? '' };
  }
  throw new Error('This is not a Luscent project (.lsp) file.');
}

/** File name for a project, e.g. "My Edit.lsp". */
export function lspFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Untitled Project';
  return base + LSP_EXTENSION;
}
