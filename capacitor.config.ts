import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.luscent.editor',
  appName: 'Luscent',
  webDir: 'dist',
  backgroundColor: '#0b0c10',
  android: {
    // The app is the whole web build bundled in the APK; nothing is loaded from the network.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#0b0c10',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b0c10',
    },
  },
};

export default config;
