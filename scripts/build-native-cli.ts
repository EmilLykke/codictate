// Builds the `codictate` command-line client (native/codictate-cli, docs/CLI.md) for the
// host the app is built on: aarch64-apple-darwin on macOS, x86_64-pc-windows-msvc on
// Windows. electrobun.config.ts copies the result into Resources/app/bin.

import { join } from "path";

const CLI_TARGETS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "aarch64-apple-darwin",
  win32: "x86_64-pc-windows-msvc",
};

const CLI_CRATE_DIR = "native/codictate-cli";

/** Repo-relative path of the release client for `platform`, as the build leaves it. */
export function cliBinarySource(platform: NodeJS.Platform): string {
  const target = CLI_TARGETS[platform];
  const exe = platform === "win32" ? "codictate.exe" : "codictate";
  return target
    ? `${CLI_CRATE_DIR}/target/${target}/release/${exe}`
    : `${CLI_CRATE_DIR}/target/release/${exe}`;
}

if (import.meta.main) {
  const target = CLI_TARGETS[process.platform];
  const manifest = join(import.meta.dir, "..", CLI_CRATE_DIR, "Cargo.toml");
  const result = Bun.spawnSync(
    [
      "cargo",
      "build",
      "--release",
      "--manifest-path",
      manifest,
      ...(target ? ["--target", target] : []),
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) {
    console.error("[build-native-cli] cargo build failed");
    process.exit(result.exitCode ?? 1);
  }
  console.log(`[build-native-cli] Built ${cliBinarySource(process.platform)}`);
}
