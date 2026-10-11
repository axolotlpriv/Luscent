/** Native (Capacitor) file output. Only loaded inside the Android app. */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function saveNative(name: string, blob: Blob): Promise<string> {
  const data = await toBase64(blob);
  const written = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache, recursive: true });
  // The share sheet is how files leave the app: Save to Files, Drive, Photos, messaging…
  await Share.share({ title: name, url: written.uri, dialogTitle: `Save ${name}` });
  return 'share sheet';
}
