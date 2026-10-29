// Runs inside Electrobun's build pipeline after the .app bundle is assembled.
// Electrobun reads icon.iconset/ directly (mac.icons in electrobun.config.ts).
// The iconset is committed to the repo, but this script regenerates missing
// sizes so a fresh clone still builds correctly.

import { basename, join } from "path";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
} from "fs";
import {
  BINARY_MANIFEST,
  MACOS_PARAKEET_HELPER_NAMES,
} from "../src/shared/binary-manifest";
import {
  ONNXRUNTIME_BINDING_DIRS,
  missingOnnxRuntimeFiles,
  onnxRuntimeBuildCopy,
} from "./onnxruntime-bundle";

if (process.platform !== "darwin") {
  console.log("[post-build] non-macOS host detected, skipping macOS bundle patching");
  process.exit(0);
}

const buildDir = process.env.ELECTROBUN_BUILD_DIR;

if (!buildDir) {
  console.error("[post-build] Missing ELECTROBUN_BUILD_DIR");
  process.exit(1);
}

const appBundle = readdirSync(buildDir).find((f) => f.endsWith(".app"));
if (!appBundle) {
  console.error(`[post-build] No .app bundle found in ${buildDir}`);
  process.exit(1);
}
console.log(`[post-build] Patching bundle: ${appBundle}`);

const contentsDir = join(buildDir, appBundle, "Contents");
const resourcesDir = join(contentsDir, "Resources");
const plistPath = join(contentsDir, "Info.plist");

// ─── Patch Info.plist ─────────────────────────────────────────────────────────

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
// Required on current macOS for system permission dialogs to appear for signed apps.
// Without these, CGRequestListenEventAccess / accessibility prompts can fail silently.
setOrAdd(
  "NSInputMonitoringUsageDescription",
  '"Codictate listens for your global dictation shortcut while you use other apps."',
);
setOrAdd(
  "NSAccessibilityUsageDescription",
  '"Codictate uses accessibility to paste transcribed text into the app that has focus."',
);

// Do NOT rename the `launcher` binary — Electrobun's codesignAppBundle() signs
// `Contents/MacOS/launcher` by path; renaming breaks TCC / System Settings listing.
//
// CFBundleName (and the .app folder name) already come from electrobun.config.ts
// `app.name` + `--env` via Electrobun's getMacOSBundleDisplayName — no PlistBuddy
// needed here for display naming.

// AppLauncher swap was removed.
//
// Rationale: With a signed/notarized build the Bun runtime must remain the
// CFBundleExecutable so that macOS Launch Services registers it as the
// "responsible process" for the app bundle. Subprocesses (KeyListener, etc.)
// inherit that responsibility and their CGRequestListenEventAccess / TCC calls
// are attributed to app.codictate.canary correctly.
//
// Inserting an AppLauncher shim as CFBundleExecutable pushes Bun one level
// down the process tree (grandchild relationship with KeyListener), breaking
// TCC attribution on macOS 13+.  The premature CGRequestListenEventAccess()
// call in AppLauncher (before any UI window exists) also consumed the one-shot
// TCC dialog opportunity, preventing subsequent calls from showing the sheet.

// ─── Compile iconset → .icns and embed in bundle ──────────────────────────────
// Without CFBundleIconFile + a valid .icns in Resources/, macOS shows a generic
// icon in permission dialogs (Accessibility, Microphone, etc.).

const iconsetDir = join(import.meta.dir, "..", "icon.iconset");
if (existsSync(iconsetDir)) {
  const icnsPath = join(resourcesDir, "AppIcon.icns");
  mkdirSync(resourcesDir, { recursive: true });
  const result = Bun.spawnSync(
    ["iconutil", "-c", "icns", iconsetDir, "--output", icnsPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.exitCode === 0) {
    setOrAdd("CFBundleIconFile", "AppIcon");
    console.log("[post-build] Compiled icon.iconset → AppIcon.icns");
  } else {
    console.warn("[post-build] iconutil failed — icon may be missing in permission dialogs");
  }
}

// ─── Sign bundled native helpers (required for notarization) ────────────────
// Electrobun signs MacOS/, Frameworks/, and Resources/app/bun/**/*.node but does
// not sign arbitrary executables under Resources/app/. Apple notarization rejects
// any unsigned Mach-O inside the zip, so we Developer ID–sign helpers here with
// hardened runtime + secure timestamp — same flags Electrobun uses elsewhere.
//
// Each helper must embed its own entitlements: with `--options runtime`, macOS
// denies mic / ML capabilities unless the binary declares them (silent failure or
// stale TCC behavior). See entitlements/*.entitlements.
//
// Runs before Electrobun's codesignAppBundle (see node_modules/electrobun/...).

const developerId = process.env.ELECTROBUN_DEVELOPER_ID;

// Electrobun always sets ELECTROBUN_APP_IDENTIFIER from electrobun.config.ts
// (app.identifier ← CODICTATE_CHANNEL): canary → app.codictate.canary,
// dev → app.codictate.dev, stable → app.codictate.
// Fallbacks only if the hook is run without that env (e.g. manual script run).
function resolveAppIdentifier(): string {
  const fromElectrobun = process.env.ELECTROBUN_APP_IDENTIFIER?.trim();
  if (fromElectrobun) return fromElectrobun;

  const env = process.env.ELECTROBUN_BUILD_ENV;
  if (env === "canary") return "app.codictate.canary";
  if (env === "dev") return "app.codictate.dev";
  return "app.codictate";
}

const appIdentifier = resolveAppIdentifier();
const nativeHelpersDir = join(resourcesDir, "app", "native-helpers");
const entitlementsRoot = join(import.meta.dir, "..", "entitlements");
/** Basename → entitlements plist (Developer ID + hardened runtime). */
const helperEntitlementsByBasename: Record<string, string> = {
  KeyListener: join(entitlementsRoot, "KeyListener.entitlements"),
  MicRecorder: join(entitlementsRoot, "MicRecorder.entitlements"),
  "llama-completion": join(entitlementsRoot, "llama-completion.entitlements"),
  crispasr: join(entitlementsRoot, "crispasr.entitlements"),
  CodictateWindowHelper: join(
    entitlementsRoot,
    "CodictateWindowHelper.entitlements",
  ),
  CodictateParakeetHelper: join(
    entitlementsRoot,
    "CodictateParakeetHelper.entitlements",
  ),
  CodictateObserverHelper: join(
    entitlementsRoot,
    "CodictateObserverHelper.entitlements",
  ),
  CodictateMediaHelper: join(
    entitlementsRoot,
    "CodictateMediaHelper.entitlements",
  ),
};
/**
 * This channel's Parakeet helper: the one Swift product, renamed per channel when
 * electrobun.config.ts copies it (MACOS_PARAKEET_HELPER_NAMES in binary-manifest.ts).
 * Read from the same manifest and env as that copy, so the two cannot disagree.
 */
const parakeetHelperName = basename(BINARY_MANIFEST.macos.parakeet!.destination);
/**
 * The name a helper's entitlements plist and signing identifier are keyed on. Every channel's
 * Parakeet helper uses the stable name, so a renamed one keeps the entitlements and the
 * identifier it had before the rename (`<app id>.native.codictateparakeethelper`): the app
 * identifier already names the channel, and only the executable name decides the compile slot.
 */
function signingNameForHelper(name: string): string {
  return Object.values(MACOS_PARAKEET_HELPER_NAMES).includes(name)
    ? MACOS_PARAKEET_HELPER_NAMES.stable
    : name;
}
const CODESIGN_RETRIES = 3;
const buildEnv = process.env.ELECTROBUN_BUILD_ENV ?? "dev";

function resolveEntitlementsForHelper(name: string): string | undefined {
  const mapped = helperEntitlementsByBasename[name];
  if (mapped && existsSync(mapped)) return mapped;
  const fallback = join(entitlementsRoot, `${name}.entitlements`);
  if (existsSync(fallback)) return fallback;
  return undefined;
}

/** True for Mach-O binaries Electrobun does not sign (executables, dylibs, bundles); not .o / dSYM / data. */
function isCodesignableMachO(binaryPath: string): boolean {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(binaryPath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const desc = Bun.spawnSync(["file", "-b", binaryPath], { stdout: "pipe" })
    .stdout.toString();
  if (!desc.includes("Mach-O") || desc.includes("dSYM")) return false;
  if (desc.includes("Mach-O object")) return false;
  return (
    desc.includes("executable") ||
    desc.includes("dynamically linked shared library") ||
    desc.includes("bundle")
  );
}

/**
 * Every Mach-O under native-helpers, recursively. Vendor Binaries that ship their
 * own shared libraries land in a subdirectory when their library names would
 * collide with another vendor's (crispasr vs llama both ship ggml libraries), and
 * unsigned Mach-O anywhere under Resources/app/ fails notarization.
 */
function listCodesignableNativeHelpers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...listCodesignableNativeHelpers(fullPath));
    } else if (isCodesignableMachO(fullPath)) {
      paths.push(fullPath);
    }
  }
  paths.sort();
  return paths;
}

function verifyRequiredHelperExecutable(
  basename: string,
  remediation: string,
): void {
  const helperPath = join(nativeHelpersDir, basename);

  if (!existsSync(helperPath)) {
    console.error(
      `[post-build] ${basename} missing from native-helpers — ${remediation}`,
    );
    process.exit(1);
  }

  const fileType = Bun.spawnSync(["file", "-b", helperPath], {
    stdout: "pipe",
  });
  const kind = fileType.stdout.toString();
  if (
    !kind.includes("Mach-O") ||
    !kind.includes("executable") ||
    kind.includes("dSYM")
  ) {
    console.error(
      `[post-build] ${basename} is not a Mach-O executable (often a copied dSYM stub). ${remediation}`,
    );
    console.error(`[post-build] file(1) said: ${kind.trim()}`);
    process.exit(1);
  }

  console.log(`[post-build] Verified ${basename} is a Mach-O executable`);
}

verifyRequiredHelperExecutable(
  parakeetHelperName,
  "Re-run: bun run scripts/pre-build.ts",
);
// Another channel's name in this bundle would run in that channel's compile slot. Electrobun
// rebuilds the bundle folder from scratch, so this only trips if that ever stops being true.
for (const name of Object.values(MACOS_PARAKEET_HELPER_NAMES)) {
  if (name !== parakeetHelperName && existsSync(join(nativeHelpersDir, name))) {
    console.error(
      `[post-build] native-helpers/${name} must not ship in a build that runs ${parakeetHelperName}`,
    );
    process.exit(1);
  }
}
verifyRequiredHelperExecutable(
  "llama-completion",
  "Re-run: bun run scripts/pre-build.ts",
);
verifyRequiredHelperExecutable(
  "CodictateWindowHelper",
  "Re-run: bun run build:native",
);

verifyRequiredHelperExecutable(
  "CodictateMediaHelper",
  "Re-run: bun run build:native",
);

// ─── The `codictate` command line (docs/CLI.md) ──────────────────────────────
// A Rust executable electrobun.config.ts copies to Resources/app/bin. Electrobun does not
// sign anything under Resources/app/bin, so it is signed here with the helpers, before
// Electrobun's codesignAppBundle seals the outer bundle.

const cliPath = join(resourcesDir, "app", "bin", "codictate");
{
  const remediation = "Re-run: bun run build:native:cli";
  if (!existsSync(cliPath)) {
    console.error(`[post-build] Resources/app/bin/codictate missing — ${remediation}`);
    process.exit(1);
  }
  const kind = Bun.spawnSync(["file", "-b", cliPath], { stdout: "pipe" }).stdout.toString();
  if (!kind.includes("Mach-O") || !kind.includes("executable")) {
    console.error(`[post-build] Resources/app/bin/codictate is not a Mach-O executable. ${remediation}`);
    console.error(`[post-build] file(1) said: ${kind.trim()}`);
    process.exit(1);
  }
  console.log("[post-build] Verified Resources/app/bin/codictate is a Mach-O executable");
}

// ─── ONNX Runtime (scripts/onnxruntime-bundle.ts) ────────────────────────────
// onnxruntime-node's binding and the one library it links, copied by electrobun.config.ts to
// Resources/app/bin/napi-v6/darwin/arm64 because that is where the bundled main process
// requires the binding from. Electrobun signs `.node` files only under Resources/app/bun and
// no dylib at all, so both are signed here. The launcher runs with hardened runtime, whose
// library validation refuses to load either one unless it carries our Team ID: the
// package's own ad hoc signatures are not enough.

const onnxRuntimePaths = Object.values(onnxRuntimeBuildCopy("macos")).map((destination) =>
  join(resourcesDir, "app", destination),
);
{
  const missing = missingOnnxRuntimeFiles(join(resourcesDir, "app"), "macos");
  if (missing.length > 0) {
    for (const file of missing) {
      console.error(
        `[post-build] Resources/app/${file} missing — run bun install --frozen-lockfile (it comes from onnxruntime-node)`,
      );
    }
    process.exit(1);
  }
  for (const path of onnxRuntimePaths) {
    const kind = Bun.spawnSync(["file", "-b", path], { stdout: "pipe" }).stdout.toString();
    if (!isCodesignableMachO(path) || !kind.includes("arm64")) {
      console.error(`[post-build] ${path} is not an arm64 Mach-O library. file(1) said: ${kind.trim()}`);
      process.exit(1);
    }
  }
  console.log("[post-build] Verified ONNX Runtime binding and library in Resources/app/bin/napi-v6");
}

const machoNativeHelpers = listCodesignableNativeHelpers(nativeHelpersDir);

// Non-dev builds are code-signed and notarized by Electrobun; unsigned Mach-O under
// Resources/app/ (the helpers and the command line) fails notarization. Fail fast if we
// cannot sign them.
if (buildEnv !== "dev" && !developerId) {
  console.error(
    "[post-build] ELECTROBUN_DEVELOPER_ID is required to sign native helpers, the command line and ONNX Runtime (stable/canary build).",
  );
  process.exit(1);
}

/** Developer ID signs one Mach-O with hardened runtime + secure timestamp, then verifies it. */
function codesignBinary(
  binaryPath: string,
  label: string,
  id: string,
  entitlementsPath: string | undefined,
  signingIdentity: string,
): void {
  const entitlementArgs =
    entitlementsPath && existsSync(entitlementsPath)
      ? (["--entitlements", entitlementsPath] as const)
      : [];
  if (entitlementArgs.length === 0) {
    console.warn(
      `[post-build] Missing entitlements for ${label} — signing without (add entitlements/<name>.entitlements if notarization fails)`,
    );
  }

  console.log(`[post-build] codesign ${label}`);
  let signed = false;
  for (let attempt = 1; attempt <= CODESIGN_RETRIES; attempt += 1) {
    const result = Bun.spawnSync(
      [
        "codesign",
        "--force",
        "--verbose",
        "--timestamp",
        "--options",
        "runtime",
        "--sign",
        signingIdentity,
        "--identifier",
        id,
        ...entitlementArgs,
        binaryPath,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (result.exitCode === 0) {
      signed = true;
      break;
    }
    if (attempt < CODESIGN_RETRIES) {
      console.warn(
        `[post-build] codesign retry ${attempt}/${CODESIGN_RETRIES - 1} for ${label}`,
      );
    }
  }
  if (!signed) {
    console.error(`[post-build] codesign failed for ${label}`);
    process.exit(1);
  }

  const verify = Bun.spawnSync(
    ["codesign", "--verify", "--strict", "--verbose=2", binaryPath],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (verify.exitCode !== 0) {
    console.error(`[post-build] codesign --verify failed for ${label}`);
    process.exit(1);
  }
}

if (developerId) {
  for (const binaryPath of machoNativeHelpers) {
    const name = binaryPath.split("/").pop() ?? binaryPath;
    codesignBinary(
      binaryPath,
      `native-helpers/${name}`,
      `${appIdentifier}.native.${signingNameForHelper(name).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      resolveEntitlementsForHelper(signingNameForHelper(name)),
      developerId,
    );
  }
  console.log(
    `[post-build] Signed and verified ${machoNativeHelpers.length} Mach-O native helper(s)`,
  );

  codesignBinary(
    cliPath,
    "app/bin/codictate",
    `${appIdentifier}.cli`,
    join(entitlementsRoot, "codictate-cli.entitlements"),
    developerId,
  );
  console.log("[post-build] Signed and verified the codictate command line");

  for (const path of onnxRuntimePaths) {
    const name = basename(path);
    // Libraries: no entitlements, like the `.node` files Electrobun signs.
    codesignBinary(
      path,
      `app/${ONNXRUNTIME_BINDING_DIRS.macos}/${name}`,
      `${appIdentifier}.onnxruntime.${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      undefined,
      developerId,
    );
  }
  console.log("[post-build] Signed and verified the ONNX Runtime binding and library");
} else if (buildEnv === "dev") {
  console.log(
    "[post-build] Skipping native helper, command-line and ONNX Runtime codesign (dev build, no ELECTROBUN_DEVELOPER_ID)",
  );
}

// ─── Releases are handled by scripts/release.sh ──────────────────────────────
// Run: bun run release:canary  /  bun run release:stable  /  bun run release

console.log("[post-build] Done");
