import { describe, expect, test } from 'bun:test'
import {
  MACOS_PARAKEET_HELPER_NAMES,
  binaryBuildCopy,
  binaryManifest,
  buildChannelFrom,
  type BuildChannel,
} from './binary-manifest'

const CHANNELS: BuildChannel[] = ['stable', 'canary', 'dev']

describe('per-channel macOS Parakeet helper', () => {
  test('reads CODICTATE_CHANNEL like electrobun.config.ts does', () => {
    expect(buildChannelFrom(undefined)).toBe('dev')
    expect(buildChannelFrom('dev')).toBe('dev')
    expect(buildChannelFrom('canary')).toBe('canary')
    expect(buildChannelFrom('stable')).toBe('stable')
    expect(buildChannelFrom('')).toBe('stable')
  })

  test('stable keeps its name; canary and dev get their own', () => {
    expect(MACOS_PARAKEET_HELPER_NAMES).toEqual({
      stable: 'CodictateParakeetHelper',
      canary: 'CodictateParakeetHelperCanary',
      dev: 'CodictateParakeetHelperDev',
    })
  })

  test('every channel bundles the one vendored build under its own name, and only that one', () => {
    const names = Object.values(MACOS_PARAKEET_HELPER_NAMES)
    for (const channel of CHANNELS) {
      const parakeet = binaryManifest(channel).macos.parakeet!
      expect(parakeet.source).toBe(
        'vendors/parakeet/CodictateParakeetHelperDev'
      )
      expect(parakeet.destination).toBe(
        `native-helpers/${MACOS_PARAKEET_HELPER_NAMES[channel]}`
      )
      expect(parakeet.remediation).toContain(
        MACOS_PARAKEET_HELPER_NAMES[channel]
      )
      const bundled = Object.values(binaryBuildCopy('macos', channel)).filter(
        (destination) =>
          names.some((name) => destination === `native-helpers/${name}`)
      )
      expect(bundled).toEqual([parakeet.destination])
    }
  })

  test('Windows and Linux are the same on every channel', () => {
    for (const channel of CHANNELS) {
      expect(binaryManifest(channel).windows).toEqual(
        binaryManifest('stable').windows
      )
      expect(binaryManifest(channel).linux).toEqual(
        binaryManifest('stable').linux
      )
      expect(binaryBuildCopy('windows', channel)).toEqual(
        binaryBuildCopy('windows', 'stable')
      )
    }
  })
})
