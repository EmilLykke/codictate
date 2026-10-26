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

  test('Command-Line Control is off until turned on, and persists', async () => {
    const dependencies = testDependencies()
    const config = new AppConfig(dependencies)
    await config.load()
    expect(config.getCommandLineControl()).toBe(false)
    expect(config.getSettings().commandLineControl).toBe(false)

    expect(
      await config.updateGeneralSettings({
        commandLineControl: 'yes' as unknown as boolean,
      })
    ).toBe(false)
    expect(config.getCommandLineControl()).toBe(false)

    expect(
      await config.updateGeneralSettings({ commandLineControl: true })
    ).toBe(true)
    const persisted = JSON.parse(
      readFileSync(dependencies.paths.mainConfig, 'utf8')
    ) as Record<string, unknown>
    expect(persisted.commandLineControl).toBe(true)

    const reloaded = new AppConfig(dependencies)
    await reloaded.load()
    expect(reloaded.getCommandLineControl()).toBe(true)
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

  test('a config from before Parakeet Preparation existed is not prepared, whatever is on disk', async () => {
    const dependencies = testDependencies({ isModelAvailable: () => true })
    writeFileSync(dependencies.paths.mainConfig, '{}')
    const config = new AppConfig(dependencies)
    await config.load()
    expect(config.isParakeetCoreMlReady()).toBe(false)
  })
})

describe('getDictationPlanFor (command-line overrides)', () => {
  const PARAKEET = 'parakeet-tdt-0.6b-v3'

  async function liveConfig() {
    const dependencies = testDependencies({
      isModelAvailable: (id) => id === DEFAULT_MODEL_ID || id === PARAKEET,
      getModelAvailability: () => ({
        [DEFAULT_MODEL_ID]: true,
        [PARAKEET]: true,
      }),
    })
    const config = new AppConfig(dependencies)
    await config.load()
    expect(
      await config.updateTranscriptionSettings({
        speechModelId: PARAKEET,
        streamMode: true,
      })
    ).toBe(true)
    return { config, dependencies }
  }

  test('no overrides is exactly the shortcut plan', async () => {
    const { config } = await liveConfig()
    expect(config.getDictationPlanFor({})).toEqual(config.getDictationPlan())
    expect(config.getDictationPlan()).toMatchObject({
      status: 'runnable',
      mode: 'live',
    })
  })

  test('forceBatch turns Live Transcription off for this plan only', async () => {
    const { config, dependencies } = await liveConfig()
    const before = readFileSync(dependencies.paths.mainConfig, 'utf8')
    expect(config.getDictationPlanFor({ forceBatch: true })).toMatchObject({
      status: 'runnable',
      mode: 'batch',
      speechModelId: PARAKEET,
    })
    expect(config.getStreamMode()).toBe(true)
    expect(readFileSync(dependencies.paths.mainConfig, 'utf8')).toBe(before)
  })

  test('a Speech Model override runs that model and never writes the selection', async () => {
    const { config } = await liveConfig()
    expect(
      config.getDictationPlanFor({
        speechModelId: DEFAULT_MODEL_ID,
        transcriptionLanguageId: 'da',
        forceBatch: true,
      })
    ).toMatchObject({
      status: 'runnable',
      mode: 'batch',
      speechModelId: DEFAULT_MODEL_ID,
      transcriptionLanguageId: 'da',
      languageCode: 'da',
    })
    expect(config.getSpeechModelId()).toBe(PARAKEET)
  })

  test('a Speech Model override that cannot stream runs as a Batch Dictation', async () => {
    const { config, dependencies } = await liveConfig()
    const before = readFileSync(dependencies.paths.mainConfig, 'utf8')
    expect(
      config.getDictationPlanFor({ speechModelId: DEFAULT_MODEL_ID })
    ).toMatchObject({
      status: 'runnable',
      mode: 'batch',
      speechModelId: DEFAULT_MODEL_ID,
    })
    // The setting is untouched, and a Speech Model that can stream still streams.
    expect(config.getStreamMode()).toBe(true)
    expect(config.getSpeechModelId()).toBe(PARAKEET)
    expect(readFileSync(dependencies.paths.mainConfig, 'utf8')).toBe(before)
    expect(
      config.getDictationPlanFor({ speechModelId: PARAKEET })
    ).toMatchObject({ status: 'runnable', mode: 'live' })
  })

  test('an override that cannot run is blocked, not substituted', async () => {
    const { config } = await liveConfig()
    // Weights that are not installed.
    expect(
      config.getDictationPlanFor({
        speechModelId: 'large-v3-q5_0',
        forceBatch: true,
      })
    ).toMatchObject({ status: 'blocked', reason: 'speech_model_not_installed' })
  })
})

describe('File Transcription Settings', () => {
  const SMALL = 'small-q5_1'
  const PARAKEET = 'parakeet-tdt-0.6b-v3'

  /** A mutable install set, so a test can delete weights between two heal passes. */
  function installs(initial: string[]) {
    const installed = new Set([DEFAULT_MODEL_ID, ...initial])
    const dependencies = testDependencies({
      isModelAvailable: (id) => installed.has(id),
      getModelAvailability: () =>
        Object.fromEntries([...installed].map((id) => [id, true])),
    })
    return { installed, dependencies }
  }

  function persisted(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  }

  test('follow the Dictation settings until the user changes one, and persist nothing meanwhile', async () => {
    const { dependencies } = installs([SMALL])
    writeFileSync(
      dependencies.paths.mainConfig,
      JSON.stringify({
        speechModelId: SMALL,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      })
    )
    const config = new AppConfig(dependencies)
    await config.load()

    const expected = {
      speechModelId: SMALL,
      transcriptionLanguageId: 'da',
      translateToEnglish: true,
    }
    expect(config.getFileTranscriptionSettings()).toEqual(expected)
    expect(config.getSettings().fileTranscription).toMatchObject({
      ...expected,
      translateReadiness: { ready: true },
      healAnnouncements: [],
    })

    // A Dictation change carries over while they follow.
    expect(
      await config.updateTranscriptionSettings({
        speechModelId: DEFAULT_MODEL_ID,
        translateToEnglish: false,
      })
    ).toBe(true)
    expect(config.getFileTranscriptionSettings()).toEqual({
      speechModelId: DEFAULT_MODEL_ID,
      transcriptionLanguageId: 'da',
      translateToEnglish: false,
    })
    expect(
      persisted(dependencies.paths.mainConfig).fileTranscription
    ).toBeNull()
  })

  test('the first accepted write makes them their own, from the Dictation values plus the patch', async () => {
    const { dependencies } = installs([SMALL])
    const config = new AppConfig(dependencies)
    await config.load()
    expect(
      await config.updateTranscriptionSettings({
        transcriptionLanguageId: 'da',
      })
    ).toBe(true)

    expect(
      await config.updateFileTranscriptionSettings({ speechModelId: SMALL })
    ).toBe(true)
    const expected = {
      speechModelId: SMALL,
      transcriptionLanguageId: 'da',
      translateToEnglish: false,
    }
    expect(config.getFileTranscriptionSettings()).toEqual(expected)
    expect(persisted(dependencies.paths.mainConfig).fileTranscription).toEqual(
      expected
    )

    // No longer following.
    expect(
      await config.updateTranscriptionSettings({
        transcriptionLanguageId: 'en',
      })
    ).toBe(true)
    expect(config.getFileTranscriptionSettings()).toEqual(expected)
  })

  test('a refused first write leaves them following', async () => {
    const { dependencies } = installs([])
    const config = new AppConfig(dependencies)
    await config.load()
    expect(
      await config.updateFileTranscriptionSettings({ speechModelId: SMALL })
    ).toBe(false)
    expect(
      await config.updateTranscriptionSettings({
        transcriptionLanguageId: 'da',
      })
    ).toBe(true)
    expect(config.getFileTranscriptionSettings().transcriptionLanguageId).toBe(
      'da'
    )
  })

  test('are chosen apart from the Dictation settings and round-trip through the file', async () => {
    const { dependencies } = installs([SMALL])
    const config = new AppConfig(dependencies)
    await config.load()

    expect(
      await config.updateFileTranscriptionSettings({
        speechModelId: SMALL,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      })
    ).toBe(true)
    await config.setLastTranscriptExportFolder('/Users/someone/Exports')

    expect(config.getSpeechModelId()).toBe(DEFAULT_MODEL_ID)
    expect(config.getSettings().translateToEnglish).toBe(false)

    const reloaded = new AppConfig(dependencies)
    await reloaded.load()
    expect(reloaded.getFileTranscriptionSettings()).toEqual({
      speechModelId: SMALL,
      transcriptionLanguageId: 'da',
      translateToEnglish: true,
    })
    expect(reloaded.getLastTranscriptExportFolder()).toBe(
      '/Users/someone/Exports'
    )
    // Changing the Dictation's leaves them alone.
    expect(
      await reloaded.updateTranscriptionSettings({ speechModelId: SMALL })
    ).toBe(true)
    expect(reloaded.getFileTranscriptionSettings().speechModelId).toBe(SMALL)
  })

  test('refuse a write that cannot run, and write nothing', async () => {
    const { dependencies } = installs([])
    writeFileSync(dependencies.paths.mainConfig, '{}')
    const config = new AppConfig(dependencies)
    await config.load()
    const before = readFileSync(dependencies.paths.mainConfig, 'utf8')

    expect(
      await config.updateFileTranscriptionSettings({ speechModelId: SMALL })
    ).toBe(false)
    expect(
      await config.updateFileTranscriptionSettings({ translateToEnglish: true })
    ).toBe(false)
    expect(
      await config.updateFileTranscriptionSettings({
        translateToEnglish: 'yes' as unknown as boolean,
      })
    ).toBe(false)
    expect(config.getFileTranscriptionSettings().speechModelId).toBe(
      DEFAULT_MODEL_ID
    )
    expect(readFileSync(dependencies.paths.mainConfig, 'utf8')).toBe(before)
  })

  test("heal after a Speech Model is deleted: fall back to the Dictation's, announce, dismiss", async () => {
    const { installed, dependencies } = installs([SMALL, PARAKEET])
    const config = new AppConfig(dependencies)
    await config.load()
    expect(
      await config.updateTranscriptionSettings({ speechModelId: PARAKEET })
    ).toBe(true)
    expect(
      await config.updateFileTranscriptionSettings({
        speechModelId: SMALL,
        transcriptionLanguageId: 'da',
        translateToEnglish: true,
      })
    ).toBe(true)

    installed.delete(SMALL)
    await config.healRunnableSettings({ retireSettledAnnouncements: true })

    const state = config.getSettings().fileTranscription
    expect(state).toMatchObject({
      speechModelId: PARAKEET,
      transcriptionLanguageId: 'auto',
      translateToEnglish: false,
      translateReadiness: { ready: false },
    })
    expect(state.healAnnouncements.map((n) => n.target)).toEqual([
      'speech_model',
      'translate_to_english',
    ])
    // The Dictation's own announcements are untouched: nothing about them changed.
    expect(config.getSettings().healAnnouncements).toEqual([])
    expect(
      persisted(dependencies.paths.mainConfig).fileTranscription
    ).toMatchObject({ speechModelId: PARAKEET })

    expect(config.dismissFileTranscriptionHealAnnouncements()).toBe(true)
    expect(config.getSettings().fileTranscription.healAnnouncements).toEqual([])
    expect(config.dismissFileTranscriptionHealAnnouncements()).toBe(false)
  })

  test('heal at boot when the persisted Speech Model is gone', async () => {
    const { dependencies } = installs([])
    writeFileSync(
      dependencies.paths.mainConfig,
      JSON.stringify({
        fileTranscription: {
          speechModelId: SMALL,
          transcriptionLanguageId: 'da',
          translateToEnglish: false,
        },
      })
    )
    const config = new AppConfig(dependencies)
    await config.load()
    const state = config.getSettings().fileTranscription
    expect(state.speechModelId).toBe(DEFAULT_MODEL_ID)
    expect(state.transcriptionLanguageId).toBe('da')
    expect(state.healAnnouncements.map((n) => n.reason)).toEqual([
      'speech_model_not_installed',
    ])
  })

  test('a Dictation write that removes the translate source turns file Translate off', async () => {
    const { dependencies } = installs([SMALL])
    const config = new AppConfig(dependencies)
    await config.load()
    expect(
      await config.updateTranscriptionSettings({
        translateDefaultLanguageId: 'da',
      })
    ).toBe(true)
    expect(
      await config.updateFileTranscriptionSettings({
        speechModelId: SMALL,
        translateToEnglish: true,
      })
    ).toBe(true)

    expect(
      await config.updateTranscriptionSettings({
        translateDefaultLanguageId: 'auto',
      })
    ).toBe(true)
    const state = config.getSettings().fileTranscription
    expect(state.translateToEnglish).toBe(false)
    expect(state.healAnnouncements.map((n) => n.reason)).toEqual([
      'no_translate_source_language',
    ])
  })
})
