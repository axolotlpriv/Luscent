# Project files (`.lsp`)

A Luscent project file is a single binary container with the project and, optionally, the media it uses. All integers are little-endian.

```
bytes 0-3    magic: "LSP" then 0x01 (format version)
bytes 4-7    N, the header length in bytes
bytes 8..    header: UTF-8 JSON, N bytes
then         media blobs back to back
```

## Header

```json
{
  "format": "luscent-project",
  "version": 1,
  "savedAt": "2026-10-11T04:00:00.000Z",
  "app": "luscent",
  "project": { "...": "the project, as in src/core/model/types.ts" },
  "media": [
    { "id": "media_ab12", "name": "clip.mp4", "mimeType": "video/mp4", "offset": 0, "size": 8123456 }
  ]
}
```

- `project` is the plain JSON project model. Numbers JSON can't hold (`Infinity` for stills) are written as `{"$num": "Infinity"}`.
- `media[i].offset` is relative to the start of the blob section (byte `8 + N`). Each entry's `id` matches a key in `project.media`.
- A file saved **without media** has an empty `media` list. Opening it marks the clips as missing so they can be relinked from the Project panel.

## Behaviour

- Saving never reads the media into memory: the blobs are passed to the `Blob` constructor and the browser streams them.
- Opening slices media out of the file lazily and stores it in the browser's media store, so playback doesn't depend on the file staying around.
- A truncated file opens with whatever media is intact; media that runs past the end of the file is treated as missing. A file cut inside the header is rejected as damaged.
- `*.luscent.json` files from earlier versions (the same header, no container) are still read.
- A file from a newer format version is refused with a clear message instead of being half-loaded. Migrations for older versions run in `src/core/model/serialize.ts`.

The code is in `src/core/model/lsp.ts`; the file list is also available as a MIME type, `application/x-luscent-project`.
