import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles/app.css';
import { App } from './ui/App';
import { installTransport } from './engine/playback/Transport';
import { installAutosave } from './engine/persist/autosave';
import { editor } from './state/store';
import { registerBuiltinEffects } from './effects';
import { pluginStore } from './engine/plugins/pluginStore';
import { effectRegistry } from './core/effects/registry';
import { GpuFarneback } from './engine/flow/gpuFarneback';
import { farnebackFlow } from './core/flow/farneback';
import { getGpuDevice } from './engine/gpu/device';
import { isNativeApp } from './engine/platform/files';
import { openProjectFile } from './state/projectActions';
import { usePresetLibrary } from './state/presetLibrary';

registerBuiltinEffects();
installTransport();
void pluginStore.loadInstalled();
void pluginStore.loadBundled();

async function boot() {
  installAutosave();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Expose for debugging and automated smoke tests.
  (window as unknown as { luscent: unknown }).luscent = {
    editor,
    effects: effectRegistry,
    plugins: pluginStore,
    presets: usePresetLibrary,
    // Engine internals for automated tests and debugging.
    debug: { GpuFarneback, farnebackFlow, getGpuDevice },
  };
}

void boot();

// Installed desktop PWA: double-clicking a .lsp file opens it here.
type LaunchQueue = { setConsumer(fn: (p: { files: Array<{ getFile(): Promise<File> }> }) => void): void };
(window as unknown as { launchQueue?: LaunchQueue }).launchQueue?.setConsumer(async (params) => {
  const file = await params.files[0]?.getFile();
  if (file) void openProjectFile(file);
});

// Installable + offline after the first visit. Not needed (and not wanted) inside the Android app.
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeApp()) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}
