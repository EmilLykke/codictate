import type { ElectrobunConfig } from "electrobun";
import {
  CRISPASR_BUNDLE_SUBDIR,
  CRISPASR_MACOS_DYLIBS,
  CRISPASR_WINDOWS_DLLS,
  LLAMA_MACOS_DYLIBS,
  LLAMA_WINDOWS_DLLS,
} from "./scripts/vendor-manifest";

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
const WINDOWS_VC_RUNTIME_DLLS = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
];

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
  buildCopy["native/CodictateWindowsHelper/target/release/DirectML.dll"] =
    "native-helpers/DirectML.dll";
  buildCopy["vendors/llama/llama-completion.exe"] =
    "native-helpers/llama-completion.exe";
  // Prebuilt llama is shared-library based, so its ggml/llama DLLs ship alongside it.
  for (const dll of LLAMA_WINDOWS_DLLS) {
    buildCopy[`vendors/llama/${dll}`] = `native-helpers/${dll}`;
  }
  buildCopy["vendors/crispasr/crispasr.exe"] =
    `native-helpers/${CRISPASR_BUNDLE_SUBDIR}/crispasr.exe`;
  for (const dll of CRISPASR_WINDOWS_DLLS) {
    buildCopy[`vendors/crispasr/${dll}`] =
      `native-helpers/${CRISPASR_BUNDLE_SUBDIR}/${dll}`;
  }
  buildCopy["vendors/whisper/ggml-large-v3-turbo-q5_0.bin"] =
    "native-helpers/ggml-large-v3-turbo-q5_0.bin";
  buildCopy["vendors/windows/TrayIcon.ico"] = "images/TrayIcon.ico";
  buildCopy["src/assets/images/MacDocIcon.ico"] = "images/WindowsAppIcon.ico";
  for (const dll of WINDOWS_VC_RUNTIME_DLLS) {
    buildCopy[`vendors/windows/vc-runtime/${dll}`] = `native-helpers/${dll}`;
  }
} else {
  buildCopy["src/bun/utils/keyboard/KeyListener"] =
    "native-helpers/KeyListener";
  buildCopy["src/bun/utils/audio/MicRecorder"] = "native-helpers/MicRecorder";
  buildCopy["vendors/llama/llama-completion"] =
    "native-helpers/llama-completion";
  // Prebuilt llama resolves these through @rpath = @loader_path, so they must sit
  // in the same directory as the binary.
  for (const dylib of LLAMA_MACOS_DYLIBS) {
    buildCopy[`vendors/llama/${dylib}`] = `native-helpers/${dylib}`;
  }
  buildCopy["vendors/crispasr/crispasr"] =
    `native-helpers/${CRISPASR_BUNDLE_SUBDIR}/crispasr`;
  for (const dylib of CRISPASR_MACOS_DYLIBS) {
    buildCopy[`vendors/crispasr/${dylib}`] =
      `native-helpers/${CRISPASR_BUNDLE_SUBDIR}/${dylib}`;
  }
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
    version: "0.0.54-canary.3",
  },
  runtime: {
    // Keep the app alive when the window is closed — it lives in the tray
    exitOnLastWindowClosed: false,
  },
  build: {
    copy: buildCopy,
    watchIgnore: ["dist/**"],
    mac: {
      // Electrobun still consumes a legacy .iconset. `scripts/pre-build.ts`
      // regenerates it from `src/assets/images/MacAppIconFlat.svg`, a borderless
      // square source that lets macOS apply its own outer icon treatment.
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
