import { join } from 'node:path'
import { getPlatformRuntime } from '../../platform/runtime'

const CANDIDATE_PATHS =
  getPlatformRuntime() === 'windows'
    ? [
        join(import.meta.dir, '../native-helpers/whisper-cli.exe'),
        join(import.meta.dir, '../../../../vendors/whisper/whisper-cli.exe'),
      ]
    : [
        join(import.meta.dir, '../native-helpers/whisper-cli'),
        join(import.meta.dir, '../../../../vendors/whisper/whisper-cli'),
      ]

let resolvedPath: string | null = null

export async function findWhisperCliBinary(): Promise<string> {
  if (resolvedPath) return resolvedPath

  for (const candidate of CANDIDATE_PATHS) {
    if (await Bun.file(candidate).exists()) {
      resolvedPath = candidate
      return candidate
    }
  }

  throw new Error(
    getPlatformRuntime() === 'windows'
      ? 'whisper-cli.exe not found. Run `bun run build:native:windows-helper` and let Electrobun prebuild vendor whisper.cpp, then rebuild the app.'
      : 'whisper-cli not found. Run `bun run build:native` so whisper.cpp is vendored, then rebuild the app.'
  )
}
