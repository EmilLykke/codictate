import type { PlatformRuntime } from './platform'

export type BinaryId =
  | 'keyboard'
  | 'microphone'
  | 'window'
  | 'observer'
  | 'parakeet'
  | 'llama'
  | 'crispasr'

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
}

const windows: Record<BinaryId, BinaryArtifact | null> = {
  keyboard: windowsHelper,
  microphone: windowsHelper,
  window: windowsHelper,
  parakeet: windowsHelper,
  observer: null,
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
    llama: macos.llama,
    crispasr: macos.crispasr,
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
