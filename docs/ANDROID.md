# Android app

The Android app is the web editor packaged with [Capacitor](https://capacitorjs.com): the whole build is bundled in the APK and runs in the system WebView, so it works offline and nothing is uploaded. Native code is limited to a few things a WebView can't do:

- **Saving files**: a download link does nothing in a WebView, so exports and `.lsp` projects are written to app storage in 3 MB chunks and handed to the share sheet (Save to Files, Drive, Photos, messaging).
- **Back button**: closes a dialog, then a sheet, then returns to the home page, then leaves the app.
- **System bars** are dark to match the editor, and the splash screen uses the app icon.

The package id is `app.luscent.editor` and the minimum Android version is 7.0 (API 24).

## Get the APK

Every push to `main` runs the **Android APK** workflow (Actions tab) and uploads `app-debug.apk` as the `luscent-android` artifact. A `v*` tag also attaches the APK to a GitHub Release.

To install it, open the file on the phone and allow installs from that source. A debug APK is signed with a debug key, which is fine for sideloading but not for the Play Store.

### Signed release builds

Add these repository secrets and the workflow also builds a signed `release` APK:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | your keystore, base64 encoded (`base64 -w0 release.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the key alias |
| `ANDROID_KEY_PASSWORD` | the key password |

Create a keystore once with `keytool -genkey -v -keystore release.jks -alias luscent -keyalg RSA -keysize 2048 -validity 10000` and keep it safe: apps signed with different keys can't update each other.

## Build it yourself

You need Node 22, JDK 21 and the Android SDK (platform 36, build-tools 36.0.0).

```bash
npm ci
npm run build            # web build into dist/
npx cap sync android     # copy it into the Android project
cd android
ANDROID_HOME=/path/to/sdk ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Or open the `android/` folder in Android Studio. Run `npx cap sync android` again after every web change. `npx capacitor-assets generate --android` rebuilds the icons and splash screens from `assets/`.

## Notes

- Video import, preview, effects and export use the WebView's WebGL2 and WebCodecs. The WebView follows the system's Chrome, so keep *Android System WebView* updated. Whether H.264 export works depends on the phone's hardware encoder; Luscent falls back to VP9 when there isn't one.
- 4K export and optical-flow slow motion are demanding. Expect them to be much slower than on a desktop GPU.
- WebGPU is only used when the WebView offers it. Otherwise WGSL plugins are unavailable and optical flow runs on the CPU.
