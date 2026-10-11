/**
 * Native (Capacitor) integration. Only loaded inside the Android app.
 */
import { App } from '@capacitor/app';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

/** Multiple of 3 so each chunk is valid base64 on its own. */
const CHUNK = 3 * 1024 * 1024;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Write a blob to app storage in chunks (a 200 MB export never sits in memory
 * as one string), then open the share sheet. That is how a file leaves the app:
 * Save to Files, Drive, Photos, messaging...
 */
export async function saveNative(name: string, blob: Blob): Promise<string> {
  const path = `exports/${Date.now()}-${name}`;
  for (let off = 0; off < blob.size || off === 0; off += CHUNK) {
    const data = await toBase64(blob.slice(off, off + CHUNK));
    if (off === 0) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    if (blob.size === 0) break;
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: name, url: uri, dialogTitle: `Save ${name}` });
  // The share sheet has its own copy of the stream by now; keep the cache from growing.
  setTimeout(() => void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined), 10 * 60_000);
  return 'the share sheet';
}

/** Dark system bars and the Android back button. */
export async function initNative(handlers: { back: () => 'handled' | 'exit' }): Promise<void> {
  await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
  await StatusBar.setBackgroundColor({ color: '#0b0c10' }).catch(() => undefined);
  await App.addListener('backButton', () => {
    if (handlers.back() === 'exit') void App.exitApp();
  });
  await SplashScreen.hide().catch(() => undefined);
}
