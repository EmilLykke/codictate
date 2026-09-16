import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  BINARY_MANIFEST,
  binaryBuildCopy,
  type BinaryId,
} from '../../shared/binary-manifest'
import {
  findBinary,
  requireRuntimeBinary,
  type BinaryLocation,
} from './binaries'

const location = (
  platform: BinaryLocation['platform'],
  files: string[]
): BinaryLocation => ({
  platform,
  bundleRoot: '/package/Resources',
  repositoryRoot: '/checkout',
  exists: (path) => files.includes(path),
})

describe('packaging and runtime binary contract', () => {
  for (const platform of ['macos', 'windows'] as const) {
    test(`${platform}: resolves every shipped role from package without a source checkout`, () => {
      const copy = binaryBuildCopy(platform)
      const files = Object.values(copy).map((destination) =>
        join('/package/Resources', destination)
      )
      const packaged = location(platform, files)
      for (const id of Object.keys(BINARY_MANIFEST[platform]) as BinaryId[]) {
        const artifact = BINARY_MANIFEST[platform][id]
        if (artifact === null) {
          expect(findBinary(id, packaged)).toBeNull()
        } else {
          expect(requireRuntimeBinary(id, packaged)).toBe(
            join('/package/Resources', artifact.destination)
          )
        }
      }
    })
    test(`${platform}: package wins over checkout; deleted binary is not cached`, () => {
      const artifact = BINARY_MANIFEST[platform].crispasr!
      const packaged = join('/package/Resources', artifact.destination)
      const source = join('/checkout', artifact.source)
      const files = [packaged, source]
      const paths = location(platform, files)
      expect(requireRuntimeBinary('crispasr', paths)).toBe(packaged)
      files.shift()
      expect(requireRuntimeBinary('crispasr', paths)).toBe(source)
      files.shift()
      expect(findBinary('crispasr', paths)).toBeNull()
      expect(() => requireRuntimeBinary('crispasr', paths)).toThrow(
        'crispasr-only'
      )
    })
  }

  test('Windows roles share one executable and macOS crispasr stays isolated from llama', () => {
    const win = binaryBuildCopy('windows')
    expect(win).toEqual({
      'native/CodictateWindowsHelper/target/release/CodictateWindowsHelper.exe':
        'native-helpers/CodictateWindowsHelper.exe',
      'vendors/llama/llama-completion.exe':
        'native-helpers/llama-completion.exe',
      'vendors/crispasr/crispasr.exe': 'native-helpers/crispasr/crispasr.exe',
    })
    const paths = location('windows', [
      '/package/Resources/native-helpers/CodictateWindowsHelper.exe',
    ])
    for (const id of [
      'keyboard',
      'microphone',
      'window',
      'parakeet',
    ] as const) {
      expect(requireRuntimeBinary(id, paths)).toBe(
        '/package/Resources/native-helpers/CodictateWindowsHelper.exe'
      )
    }
    expect(binaryBuildCopy('macos')['vendors/crispasr/crispasr']).toBe(
      'native-helpers/crispasr/crispasr'
    )
    expect(binaryBuildCopy('macos')['vendors/llama/llama-completion']).toBe(
      'native-helpers/llama-completion'
    )
  })

  test('unsupported helpers stay unavailable even if another platform binary exists', () => {
    const linux = location('linux', [
      '/package/Resources/native-helpers/CodictateParakeetHelper',
    ])
    expect(findBinary('parakeet', linux)).toBeNull()
    expect(() => requireRuntimeBinary('parakeet', linux)).toThrow(
      'not supported on linux'
    )
    expect(findBinary('observer', location('windows', []))).toBeNull()
  })
})
