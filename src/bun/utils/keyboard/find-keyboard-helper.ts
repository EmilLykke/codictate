import type { PlatformRuntime } from '../../../shared/platform'
import { getPlatformRuntime } from '../../platform/runtime'
import { requireRuntimeBinary } from '../../platform/binaries'

export async function findKeyboardHelperBinary(): Promise<{
  path: string
  kind: PlatformRuntime
}> {
  return {
    path: requireRuntimeBinary('keyboard'),
    kind: getPlatformRuntime(),
  }
}
