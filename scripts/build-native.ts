// `bun run build:native`: builds the Native Helpers for the host platform.
//
// - macOS:   the Swift helpers, via src/scripts/build-swift.sh (unchanged behaviour).
// - Linux:   the Rust helper (`CodictateWindowsHelper`, built without `.exe`).
// - Windows: the same Rust helper, as `build:native:windows-helper` does.
//
// This exists so `build:stable` / `build:canary` do not hard-fail on a host without
// swiftc. It builds; it never substitutes one helper for another.

import { existsSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const RUST_HELPER_MANIFEST = join(
  REPO_ROOT,
  "native",
  "CodictateWindowsHelper",
  "Cargo.toml",
);

function run(argv: string[]): void {
  console.log(`[build-native] ${argv.join(" ")}`);
  const result = Bun.spawnSync(argv, {
    cwd: REPO_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

/** `cargo` from PATH, else rustup's default location. */
function cargoExecutable(): string {
  if (Bun.which("cargo")) return "cargo";
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const fallback = home ? join(home, ".cargo", "bin", "cargo") : "";
  if (fallback && existsSync(fallback)) return fallback;
  console.error("[build-native] cargo not found. Install Rust: https://rustup.rs");
  process.exit(1);
}

switch (process.platform) {
  case "darwin":
    run([join(REPO_ROOT, "src", "scripts", "build-swift.sh")]);
    break;
  case "linux":
  case "win32":
    run([
      cargoExecutable(),
      "build",
      "--release",
      "--manifest-path",
      RUST_HELPER_MANIFEST,
    ]);
    break;
  default:
    console.error(`[build-native] No Native Helpers for ${process.platform}`);
    process.exit(1);
}
