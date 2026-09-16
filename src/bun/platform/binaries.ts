import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BINARY_MANIFEST, type BinaryId } from '../../shared/binary-manifest'
import type { PlatformRuntime } from '../../shared/platform'
import { getPlatformRuntime } from './runtime'
import { resolveBinary } from './resolve-binary'

export interface BinaryLocation {
  platform: PlatformRuntime
  bundleRoot: string
  repositoryRoot: string
  exists: (path: string) => boolean
}

/** Electrobun bundles the entry under Resources/app; development runs this source directly. */
const runtimeLocation = (): BinaryLocation => ({
  platform: getPlatformRuntime(),
  bundleRoot: resolve(import.meta.dir, '..'),
  repositoryRoot: resolve(import.meta.dir, '../../..'),
  exists: existsSync,
})

export function findBinary(
  id: BinaryId,
  location: BinaryLocation = runtimeLocation()
): string | null {
  const artifact = BINARY_MANIFEST[location.platform][id]
  if (artifact === null) return null
  return resolveBinary(
    [
      join(location.bundleRoot, artifact.destination),
      join(location.repositoryRoot, artifact.source),
    ],
    location.exists
  )
}

export function requireRuntimeBinary(
  id: BinaryId,
  location: BinaryLocation = runtimeLocation()
): string {
  const path = findBinary(id, location)
  if (path !== null) return path
  const artifact = BINARY_MANIFEST[location.platform][id]
  throw new Error(
    artifact?.remediation ??
      `${id} Native Helper is not supported on ${location.platform}.`
  )
}
