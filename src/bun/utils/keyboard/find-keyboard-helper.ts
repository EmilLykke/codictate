import { getPlatformRuntime } from '../../platform/runtime'
import { requireRuntimeBinary } from '../../platform/binaries'

export async function findKeyboardHelperBinary(): Promise<{
  path: string
  kind: 'macos' | 'windows'
}> {
  return {
    path: requireRuntimeBinary('keyboard'),
    kind: getPlatformRuntime() === 'windows' ? 'windows' : 'macos',
  }
}
