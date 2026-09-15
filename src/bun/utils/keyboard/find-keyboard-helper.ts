import { join } from 'node:path'
import { getPlatformRuntime } from '../../platform/runtime'
import {
  requireBinary,
  resolveBinaryAsync,
} from '../../platform/resolve-binary'

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

let resolvedHelper: { path: string; kind: 'macos' | 'windows' } | null = null

export async function findKeyboardHelperBinary(): Promise<{
  path: string
  kind: 'macos' | 'windows'
}> {
  const runtime = getPlatformRuntime()

  if (resolvedHelper) return resolvedHelper

  const candidates =
    runtime === 'windows' ? WINDOWS_CANDIDATE_PATHS : MAC_CANDIDATE_PATHS

  const path = requireBinary(
    await resolveBinaryAsync(candidates),
    runtime === 'windows'
      ? 'CodictateWindowsHelper not found. Run `bun run build:native:windows-helper` so native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe exists, then rebuild the app.'
      : 'KeyListener not found. Run `bun run build:native` so the macOS native helper is built, then rebuild the app.'
  )
  resolvedHelper = { path, kind: runtime === 'windows' ? 'windows' : 'macos' }
  return resolvedHelper
}
