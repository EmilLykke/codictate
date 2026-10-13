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
   * The Silero VAD weights crispasr loads with `--vad -vm <path>` on the `nt-vad` path
   * (ADR-0010). Not an executable: a pinned data file shipped next to crispasr, so it is never
   * downloaded at runtime.
   */
  | 'silero-vad'

export interface BinaryArtifact {
  source: string
  destination: string
  remediation: string
}

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

const macos: Record<BinaryId, BinaryArtifact> = {
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
  parakeet: {
    source: 'vendors/parakeet/CodictateParakeetHelper',
    destination: 'native-helpers/CodictateParakeetHelper',
    remediation:
      'CodictateParakeetHelper not found. Run `bun scripts/pre-build.ts`, then rebuild the app.',
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
  parakeet: windowsHelper,
  observer: null,
  media: windowsHelper,
  llama: {
    ...macos.llama,
    source: macos.llama.source + '.exe',
    destination: macos.llama.destination + '.exe',
  },
  crispasr: {
    ...macos.crispasr,
    source: macos.crispasr.source + '.exe',
    destination: macos.crispasr.destination + '.exe',
  },
  'silero-vad': sileroVad,
}

export const BINARY_MANIFEST: Record<
  PlatformRuntime,
  Record<BinaryId, BinaryArtifact | null>
> = {
  macos,
  windows,
  linux: {
    keyboard: null,
    microphone: null,
    window: null,
    observer: null,
    parakeet: null,
    media: null,
    llama: macos.llama,
    crispasr: macos.crispasr,
    'silero-vad': sileroVad,
  },
}

/** The same destinations are consumed by packaging and runtime lookup. */
export function binaryBuildCopy(
  platform: PlatformRuntime
): Record<string, string> {
  return Object.fromEntries(
    Object.values(BINARY_MANIFEST[platform])
      .filter((artifact): artifact is BinaryArtifact => artifact !== null)
      .map(({ source, destination }) => [source, destination])
  )
}
