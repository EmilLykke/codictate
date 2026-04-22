import { join } from 'node:path'
import { getPlatformRuntime } from '../../platform/runtime'

const MAC_CANDIDATE_PATHS = [
  join(import.meta.dir, '../native-helpers/MicRecorder'),
  join(import.meta.dir, 'MicRecorder'),
]

const WINDOWS_CANDIDATE_PATHS = [
  join(import.meta.dir, '../native-helpers/CodictateWindowsHelper.exe'),
  join(
    import.meta.dir,
    '../../../../native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe'
  ),
]

let resolvedPath: string | null = null

export const findMicRecorderBinary = async (): Promise<string> => {
  if (resolvedPath) return resolvedPath

  const candidatePaths =
    getPlatformRuntime() === 'windows'
      ? WINDOWS_CANDIDATE_PATHS
      : MAC_CANDIDATE_PATHS

  for (const candidate of candidatePaths) {
    if (await Bun.file(candidate).exists()) {
      resolvedPath = candidate
      return candidate
    }
  }

  throw new Error(
    getPlatformRuntime() === 'windows'
      ? 'CodictateWindowsHelper not found. Run `bun run build:native:windows-helper` so the Windows helper exists, then rebuild the app.'
      : 'MicRecorder not found. Run `bun run build:native` (or `swiftc` per src/scripts/build-swift.sh) so src/bun/utils/audio/MicRecorder exists, then rebuild the app.'
  )
}
