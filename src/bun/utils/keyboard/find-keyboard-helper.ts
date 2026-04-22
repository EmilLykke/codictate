import { join } from 'node:path'
import { getPlatformRuntime } from '../../platform/runtime'

const MAC_CANDIDATE_PATHS = [
  join(import.meta.dir, '../native-helpers/KeyListener'),
  join(import.meta.dir, 'KeyListener'),
]

const WINDOWS_CANDIDATE_PATHS = [
  join(import.meta.dir, '../native-helpers/CodictateWindowsHelper.exe'),
  join(
    import.meta.dir,
    '../../../../native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe'
  ),
]

let resolvedPath: string | null = null

export async function findKeyboardHelperBinary(): Promise<{
  path: string
  kind: 'macos' | 'windows'
}> {
  const runtime = getPlatformRuntime()

  if (resolvedPath) {
    return {
      path: resolvedPath,
      kind: runtime === 'windows' ? 'windows' : 'macos',
    }
  }

  const candidates =
    runtime === 'windows' ? WINDOWS_CANDIDATE_PATHS : MAC_CANDIDATE_PATHS

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      resolvedPath = candidate
      return {
        path: candidate,
        kind: runtime === 'windows' ? 'windows' : 'macos',
      }
    }
  }

  if (runtime === 'windows') {
    throw new Error(
      'CodictateWindowsHelper not found. Run `bun run build:native:windows-helper` so native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe exists, then rebuild the app.'
    )
  }

  throw new Error(
    'KeyListener not found. Run `bun run build:native` so the macOS native helper is built, then rebuild the app.'
  )
}
