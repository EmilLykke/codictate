import type { PlatformRuntime } from './platform'

export type BinaryId =
  | 'keyboard'
  | 'microphone'
  | 'window'
  | 'observer'
  | 'parakeet'
  | 'llama'
  | 'crispasr'
  /**
   * The media decoder File Transcription runs: `<helper> extract-audio <in> <out.wav>`.
   * AVFoundation in `CodictateMediaHelper` on macOS, Media Foundation in
   * `CodictateWindowsHelper` on Windows, with the same argv and exit codes (ADR-0009).
   */
  | 'media'
  /**
   * The Silero VAD weights crispasr loads with `--vad -vm <path>` on the `timestamps` path
   * (ADR-0011). Not an executable: a pinned data file shipped next to crispasr, so it is never
   * downloaded at runtime.
   */
  | 'silero-vad'

export interface BinaryArtifact {
  source: string
  destination: string
  remediation: string
}

/** The release channel a build is for, from `CODICTATE_CHANNEL`. */
export type BuildChannel = 'stable' | 'canary' | 'dev'

/** Reads `CODICTATE_CHANNEL` the way electrobun.config.ts does: unset is dev, anything but canary or dev is stable. */
export function buildChannelFrom(value: string | undefined): BuildChannel {
  if (value === undefined || value === 'dev') return 'dev'
  return value === 'canary' ? 'canary' : 'stable'
}

// `process` is typed only in the Bun tsconfig, and src/shared is also checked against the DOM one.
declare const process: { env: Record<string, string | undefined> }

/**
 * The channel this code was built for. electrobun.config.ts inlines `CODICTATE_CHANNEL` into the
 * app's Bun bundle (`build.bun.define`), so a packaged app knows its channel with no env set; the
 * build config, the build hooks and a source run read the real env.
 */
export const BUILD_CHANNEL: BuildChannel = buildChannelFrom(
  process.env.CODICTATE_CHANNEL
)

/**
 * The macOS Parakeet helper's executable name per channel. The Neural Engine keeps one compiled
 * copy of the encoder per (process name, model folder), and a binary with another signing
 * identity under the same name replaces it: a 12-19 s recompile. Every channel shares one model
 * folder, so with one name each switch between stable, canary and a dev build recompiled
 * (docs/research/PARAKEET_COLD_LOAD.md, section 2.3 item 3). Windows has no Neural Engine compile,
 * so its helper keeps one name on every channel.
 *
 * One Swift product: it is vendored under the dev name, so anything run from a checkout uses the
 * dev slot, and the stable and canary builds rename it when they copy it into the bundle.
 */
export const MACOS_PARAKEET_HELPER_NAMES: Record<BuildChannel, string> = {
  stable: 'CodictateParakeetHelper',
  canary: 'CodictateParakeetHelperCanary',
  dev: 'CodictateParakeetHelperDev',
}

const macosParakeet = (channel: BuildChannel): BinaryArtifact => ({
  source: `vendors/parakeet/${MACOS_PARAKEET_HELPER_NAMES.dev}`,
  destination: `native-helpers/${MACOS_PARAKEET_HELPER_NAMES[channel]}`,
  remediation: `${MACOS_PARAKEET_HELPER_NAMES[channel]} not found. Run \`bun scripts/pre-build.ts\`, then rebuild the app.`,
})

const windowsHelper: BinaryArtifact = {
  source:
    'native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe',
  destination: 'native-helpers/CodictateWindowsHelper.exe',
  remediation:
    'CodictateWindowsHelper not found. Run `bun run build:native:windows-helper`, then rebuild the app.',
}

/** Same file and the same place beside crispasr on every platform. */
const sileroVad: BinaryArtifact = {
  source: 'vendors/silero-vad/ggml-silero-v6.2.0.bin',
  destination: 'native-helpers/crispasr/ggml-silero-v6.2.0.bin',
  remediation:
    'Silero VAD weights not found. Run `bun run scripts/pre-build.ts --crispasr-only`, then rebuild the app.',
}

const macosShared: Omit<Record<BinaryId, BinaryArtifact>, 'parakeet'> = {
  keyboard: {
    source: 'src/bun/utils/keyboard/KeyListener',
    destination: 'native-helpers/KeyListener',
    remediation:
      'KeyListener not found. Run `bun run build:native`, then rebuild the app.',
  },
  microphone: {
    source: 'src/bun/utils/audio/MicRecorder',
    destination: 'native-helpers/MicRecorder',
    remediation:
      'MicRecorder not found. Run `bun run build:native`, then rebuild the app.',
  },
  window: {
    source: 'vendors/window-helper/CodictateWindowHelper',
    destination: 'native-helpers/CodictateWindowHelper',
    remediation:
      'CodictateWindowHelper not found. Run `bun scripts/pre-build.ts`, then rebuild the app.',
  },
  observer: {
    source: 'vendors/observer/CodictateObserverHelper',
    destination: 'native-helpers/CodictateObserverHelper',
    remediation:
      'CodictateObserverHelper not found. Run `bun scripts/pre-build.ts`, then rebuild the app.',
  },
  llama: {
    source: 'vendors/llama/llama-completion',
    destination: 'native-helpers/llama-completion',
    remediation:
      'llama-completion not found. Run `bun scripts/pre-build.ts --llama-only`, then rebuild the app.',
  },
  crispasr: {
    source: 'vendors/crispasr/crispasr',
    destination: 'native-helpers/crispasr/crispasr',
    remediation:
      'crispasr not found. Run `bun run scripts/pre-build.ts --crispasr-only`, then rebuild the app.',
  },
  media: {
    source: 'vendors/media-helper/CodictateMediaHelper',
    destination: 'native-helpers/CodictateMediaHelper',
    remediation:
      'CodictateMediaHelper not found. Run `bun run build:native`, then rebuild the app.',
  },
  'silero-vad': sileroVad,
}

const windows: Record<BinaryId, BinaryArtifact | null> = {
  keyboard: windowsHelper,
  microphone: windowsHelper,
  window: windowsHelper,
  // One name on every channel: Windows has no Neural Engine compile slot to keep apart.
  parakeet: windowsHelper,
  observer: null,
  media: windowsHelper,
  llama: {
    ...macosShared.llama,
    source: macosShared.llama.source + '.exe',
    destination: macosShared.llama.destination + '.exe',
  },
  crispasr: {
    ...macosShared.crispasr,
    source: macosShared.crispasr.source + '.exe',
    destination: macosShared.crispasr.destination + '.exe',
  },
  'silero-vad': sileroVad,
}

/** Every platform's artifacts for one channel's build. Only the macOS Parakeet helper differs. */
export function binaryManifest(
  channel: BuildChannel
): Record<PlatformRuntime, Record<BinaryId, BinaryArtifact | null>> {
  return {
    macos: { ...macosShared, parakeet: macosParakeet(channel) },
    windows,
    linux: {
      keyboard: null,
      microphone: null,
      window: null,
      observer: null,
      parakeet: null,
      media: null,
      llama: macosShared.llama,
      crispasr: macosShared.crispasr,
      'silero-vad': sileroVad,
    },
  }
}

export const BINARY_MANIFEST = binaryManifest(BUILD_CHANNEL)

/** The same destinations are consumed by packaging and runtime lookup. */
export function binaryBuildCopy(
  platform: PlatformRuntime,
  channel: BuildChannel = BUILD_CHANNEL
): Record<string, string> {
  return Object.fromEntries(
    Object.values(binaryManifest(channel)[platform])
      .filter((artifact): artifact is BinaryArtifact => artifact !== null)
      .map(({ source, destination }) => [source, destination])
  )
}
