import type { ElectrobunConfig } from "electrobun";

const buildChannel = process.env.CODICTATE_CHANNEL ?? "dev";
const appIdentifier =
  buildChannel === "canary"
    ? "app.codictate.canary"
    : buildChannel === "dev"
      ? "app.codictate.dev"
      : "app.codictate";

/** Single product name — do not append "canary" / "dev" here. Electrobun combines
 *  this with `electrobun build --env=…` to produce macOS bundle folder + CFBundleName:
 *  stable → "Codictate", canary → "Codictate-canary", dev → "Codictate-dev"
 *  (see getMacOSBundleDisplayName in Electrobun). Putting the channel in `name`
 *  would yield broken names like "Codictate Canary-canary". */
const APP_NAME = "Codictate";
const isWindowsHost = process.platform === "win32";

const buildCopy: Record<string, string> = {
  "dist/index.html": "views/mainview/index.html",
  "dist/assets": "views/mainview/assets",
  // -- Sounds (src/assets/sounds -> app/sounds)
  "src/assets/sounds/dictation-start.wav": "sounds/dictation-start.wav",
  "src/assets/sounds/dictation-stop.wav": "sounds/dictation-stop.wav",
  "src/assets/sounds/dictation-cancel.wav": "sounds/dictation-cancel.wav",
  "src/assets/sounds/funmode-dictation-start.mp3":
    "sounds/funmode-dictation-start.mp3",
  "src/assets/sounds/funmode-dication-end.mp3":
    "sounds/funmode-dication-end.mp3",
};

if (isWindowsHost) {
  buildCopy[
    "native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe"
  ] = "native-helpers/CodictateWindowsHelper.exe";
  buildCopy["vendors/whisper/whisper-cli.exe"] =
    "native-helpers/whisper-cli.exe";
  buildCopy["vendors/llama/llama-completion.exe"] =
    "native-helpers/llama-completion.exe";
  buildCopy["vendors/whisper/ggml-large-v3-turbo-q5_0.bin"] =
    "native-helpers/ggml-large-v3-turbo-q5_0.bin";
  buildCopy["vendors/windows/TrayIcon.ico"] = "images/TrayIcon.ico";
  buildCopy["src/assets/images/MacDocIcon.ico"] = "images/WindowsAppIcon.ico";
} else {
  buildCopy["src/bun/utils/keyboard/KeyListener"] =
    "native-helpers/KeyListener";
  buildCopy["src/bun/utils/audio/MicRecorder"] = "native-helpers/MicRecorder";
  buildCopy["vendors/whisper/whisper-cli"] = "native-helpers/whisper-cli";
  buildCopy["vendors/llama/llama-completion"] =
    "native-helpers/llama-completion";
  buildCopy["vendors/parakeet/CodictateParakeetHelper"] =
    "native-helpers/CodictateParakeetHelper";
  buildCopy["vendors/window-helper/CodictateWindowHelper"] =
    "native-helpers/CodictateWindowHelper";
  buildCopy["vendors/observer/CodictateObserverHelper"] =
    "native-helpers/CodictateObserverHelper";
  buildCopy["vendors/whisper/ggml-large-v3-turbo-q5_0.bin"] =
    "native-helpers/ggml-large-v3-turbo-q5_0.bin";
  // -- Images (src/assets/images -> app/images)
  buildCopy["src/assets/images/MacTrayIcon.svg"] = "images/MacTrayIcon.svg";
  buildCopy["src/assets/images/MacDocIcon.png"] = "images/MacDocIcon.png";
}

export default {
  app: {
    name: APP_NAME,
    identifier: appIdentifier,
    version: "0.0.40",
  },
  runtime: {
    // Keep the app alive when the window is closed — it lives in the tray
    exitOnLastWindowClosed: false,
  },
  build: {
    copy: buildCopy,
    watchIgnore: ["dist/**"],
    mac: {
      icons: "icon.iconset",
      bundleCEF: false,
      codesign: true,
      notarize: true,
      // Must be boolean `true` — Electrobun copies this object into the *signed*
      // entitlements plist. A string becomes `<string>…</string>`, which is invalid
      // for this key; TCC/mic then fails silently under hardened runtime.
      // NSMicrophoneUsageDescription is set in scripts/post-build.ts (+ post-wrap).
      entitlements: {
        "com.apple.security.device.audio-input": true,
      },
    },
    linux: {
      bundleCEF: false,
      icon: "src/assets/images/MacDocIcon.png",
    },
    win: {
      bundleCEF: false,
      icon: "src/assets/images/MacDocIcon.ico",
    },
  },
  release: {
    // Always resolves to the latest non-prerelease (= stable) release.
    // Electrobun fetches {baseUrl}/{channel}-{os}-{arch}-update.json
    // Both stable and canary artifacts are uploaded to the stable release,
    // so canary users can also find updates here.
    baseUrl: "https://github.com/EmilLykke/codictate/releases/latest/download",
  },
  scripts: {
    preBuild: "./scripts/pre-build.ts",
    postBuild: "./scripts/post-build.ts",
    postWrap: "./scripts/post-wrap.ts",
  },
} satisfies ElectrobunConfig;
