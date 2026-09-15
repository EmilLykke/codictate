import { describe, expect, test } from 'bun:test'
import {
  requireBinary,
  resolveBinary,
  resolveBinaryAsync,
} from './resolve-binary'

describe('binary resolution', () => {
  test('uses candidate order rather than filesystem enumeration order', () => {
    const visited: string[] = []
    const resolved = resolveBinary(
      ['/bundle/helper', '/repo/helper'],
      (path) => {
        visited.push(path)
        return path === '/bundle/helper' || path === '/repo/helper'
      }
    )

    expect(resolved).toBe('/bundle/helper')
    expect(visited).toEqual(['/bundle/helper'])
  })

  test('returns null after checking every missing candidate', () => {
    const visited: string[] = []
    expect(
      resolveBinary(['/one', '/two'], (path) => {
        visited.push(path)
        return false
      })
    ).toBeNull()
    expect(visited).toEqual(['/one', '/two'])
  })

  test('supports async existence checks without changing priority', async () => {
    const visited: string[] = []
    const resolved = await resolveBinaryAsync(
      ['/bundle/helper', '/repo/helper'],
      async (path) => {
        visited.push(path)
        return path === '/repo/helper'
      }
    )

    expect(resolved).toBe('/repo/helper')
    expect(visited).toEqual(['/bundle/helper', '/repo/helper'])
  })

  test('preserves the caller-owned remediation for required binaries', () => {
    expect(() => requireBinary(null, 'Build Helper first.')).toThrow(
      'Build Helper first.'
    )
    expect(requireBinary('/bundle/helper', 'unused')).toBe('/bundle/helper')
  })
})
