import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PlatformCapabilities } from '../../shared/platform'
import { DEFAULT_MODEL_ID } from '../../shared/speech-models'
import { AppConfig, type AppConfigDependencies } from './AppConfig'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function testDependencies(
  overrides: Partial<AppConfigDependencies> = {}
): AppConfigDependencies {
  const root = mkdtempSync(join(tmpdir(), 'codictate-app-config-'))
  roots.push(root)
  const capabilities: PlatformCapabilities = {
    platform: 'macos',
    supportsMacPermissionFlow: true,
    supportsStreamMode: true,
    supportsFormatting: true,
    supportsCorrectionObserver: true,
    supportsNativeIndicator: true,
  }
  return {
    paths: {
      mainConfig: join(root, 'main-config.json'),
      dictionaryConfig: join(root, 'dictionary-config.json'),
      legacyConfig: join(root, 'app-config.json'),
      defaultHistory: join(root, 'History'),
    },
    getPlatformCapabilities: () => capabilities,
    isModelAvailable: (id) => id === DEFAULT_MODEL_ID,
    getModelAvailability: () => ({ [DEFAULT_MODEL_ID]: true }),
    detectFormattingAvailable: () => true,
    isFormatterModelInstalled: () => false,
    ...overrides,
  }
}

describe('AppConfig dependency seam', () => {
  test('round-trips concurrent settings writes through injected paths', async () => {
    const dependencies = testDependencies()
    const config = new AppConfig(dependencies)
    await config.load()

    await Promise.all([
      config.updateGeneralSettings({ funModeEnabled: true }),
      config.updateGeneralSettings({ soundEffectsEnabled: false }),
    ])

    const persisted = JSON.parse(
      readFileSync(dependencies.paths.mainConfig, 'utf8')
    ) as Record<string, unknown>
    expect(persisted.funModeEnabled).toBe(true)
    expect(persisted.soundEffectsEnabled).toBe(false)

    const reloaded = new AppConfig(dependencies)
    await reloaded.load()
    expect(reloaded.getSettings().funModeEnabled).toBe(true)
    expect(reloaded.getSettings().soundEffectsEnabled).toBe(false)
  })

  test('uses injected platform and model availability for writes and snapshots', async () => {
    const dependencies = testDependencies({
      getPlatformCapabilities: () => ({
        platform: 'windows',
        supportsMacPermissionFlow: false,
        supportsStreamMode: true,
        supportsFormatting: true,
        supportsCorrectionObserver: false,
        supportsNativeIndicator: true,
      }),
      isModelAvailable: (id) =>
        id === DEFAULT_MODEL_ID || id === 'parakeet-tdt-0.6b-v3',
      getModelAvailability: () => ({
        [DEFAULT_MODEL_ID]: true,
        'parakeet-tdt-0.6b-v3': true,
      }),
    })
    const config = new AppConfig(dependencies)
    await config.load()

    expect(await config.updateGeneralSettings({ shortcutId: 'fn-globe' })).toBe(
      false
    )
    expect(
      await config.updateTranscriptionSettings({
        speechModelId: 'parakeet-tdt-0.6b-v3',
      })
    ).toBe(true)

    const settings = config.getSettings()
    expect(settings.capabilities.platform).toBe('windows')
    expect(settings.shortcutId).toBe('option-space')
    expect(settings.speechModelId).toBe('parakeet-tdt-0.6b-v3')
    expect(settings.modelAvailability['parakeet-tdt-0.6b-v3']).toBe(true)
  })

  test('migrates legacy settings only into missing injected split files', async () => {
    const dependencies = testDependencies()
    writeFileSync(
      dependencies.paths.mainConfig,
      JSON.stringify({ funModeEnabled: false })
    )
    writeFileSync(
      dependencies.paths.legacyConfig,
      JSON.stringify({
        funModeEnabled: true,
        dictionaryEntries: [
          { kind: 'fuzzy', text: 'Electrobun', source: 'manual' },
        ],
        dictionaryAutoLearn: false,
      })
    )

    const config = new AppConfig(dependencies)
    await config.load()

    expect(config.getSettings().funModeEnabled).toBe(false)
    expect(config.getSettings().dictionary.entries).toContainEqual({
      kind: 'fuzzy',
      text: 'Electrobun',
      source: 'manual',
    })
    expect(readFileSync(dependencies.paths.mainConfig, 'utf8')).toContain(
      '"funModeEnabled":false'
    )
    expect(readFileSync(dependencies.paths.dictionaryConfig, 'utf8')).toContain(
      'Electrobun'
    )
  })

  test('distinguishes a first run from a config written before onboarding existed', async () => {
    const firstRunDependencies = testDependencies()
    const firstRun = new AppConfig(firstRunDependencies)
    await firstRun.load()
    expect(firstRun.getSettings().onboardingCompleted).toBe(false)

    const existingInstallDependencies = testDependencies()
    writeFileSync(existingInstallDependencies.paths.mainConfig, '{}')
    const existingInstall = new AppConfig(existingInstallDependencies)
    await existingInstall.load()
    expect(existingInstall.getSettings().onboardingCompleted).toBe(true)
  })
})
