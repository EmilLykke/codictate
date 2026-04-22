import { join } from "path";

if (process.platform !== "darwin") {
  console.log("[post-wrap] non-macOS host detected, skipping wrapper plist patching");
  process.exit(0);
}

const wrapperBundlePath = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;

if (!wrapperBundlePath) {
  console.error("[post-wrap] Missing ELECTROBUN_WRAPPER_BUNDLE_PATH");
  process.exit(1);
}

const plistPath = join(wrapperBundlePath, "Contents", "Info.plist");

const plist = (command: string) =>
  Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", command, plistPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

const setOrAdd = (key: string, value: string) => {
  const result = plist(`Set :${key} ${value}`);
  if (result.exitCode !== 0) plist(`Add :${key} string ${value}`);
};

setOrAdd(
  "NSMicrophoneUsageDescription",
  '"Codictate uses the microphone to record your voice for dictation."',
);
setOrAdd(
  "NSInputMonitoringUsageDescription",
  '"Codictate listens for your global dictation shortcut while you use other apps."',
);
setOrAdd(
  "NSAccessibilityUsageDescription",
  '"Codictate uses accessibility to paste transcribed text into the app that has focus."',
);

// ─── Match Electrobun bundle naming on the wrapper Info.plist ────────────────
// Same rule as getMacOSBundleDisplayName(app.name, --env): stable has no suffix.
// Keep APP_NAME in sync with electrobun.config.ts `app.name`.
const APP_NAME = "Codictate";
const channel = process.env.CODICTATE_CHANNEL ?? "dev";
const macOSBundleDisplayName =
  channel === "stable" ? APP_NAME : `${APP_NAME}-${channel}`;

setOrAdd("CFBundleDisplayName", `"${macOSBundleDisplayName}"`);
setOrAdd("CFBundleName", `"${macOSBundleDisplayName}"`);

console.log("[post-wrap] Patched wrapper Info.plist privacy strings");
