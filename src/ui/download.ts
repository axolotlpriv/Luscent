import { saveFile } from '../engine/platform/files';

/** Save a Blob or text as a file (download in a browser, share sheet in the Android app). */
export function downloadBlob(name: string, blob: Blob): void {
  void saveFile(name, blob);
}

export function downloadText(name: string, text: string, type = 'application/json'): void {
  downloadBlob(name, new Blob([text], { type }));
}
