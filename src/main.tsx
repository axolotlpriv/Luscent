import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { installTransport } from './engine/playback/Transport';
import { installAutosave, restoreSession } from './engine/persist/autosave';
import { editor } from './state/store';
import { seedDemo } from './demo';
import { registerBuiltinEffects } from './effects';
import { pluginStore } from './engine/plugins/pluginStore';
import { effectRegistry } from './core/effects/registry';
import './ui/styles/app.css';

registerBuiltinEffects();
installTransport();
void pluginStore.loadInstalled();
void pluginStore.loadBundled();

async function boot() {
  const restored = await restoreSession();
  if (!restored) seedDemo();
  installAutosave();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Expose for debugging and automated smoke tests.
  (window as unknown as { luscent: unknown }).luscent = { editor, effects: effectRegistry, plugins: pluginStore };
}

void boot();
