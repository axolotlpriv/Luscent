/**
 * Getting files in and out of the app. In a browser a download is enough; the
 * Android app (Capacitor) has no download manager for blob URLs, so it writes
 * to app storage and opens the system share sheet instead.
 */
export function isNativeApp(): boolean {
  return !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}

function browserDownload(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Save a blob as a user-visible file. Resolves with where it went, for a toast. */
export async function saveFile(name: string, blob: Blob): Promise<string> {
  if (!isNativeApp()) {
    browserDownload(name, blob);
    return 'Downloads';
  }
  const { saveNative } = await import('./native');
  return saveNative(name, blob);
}
