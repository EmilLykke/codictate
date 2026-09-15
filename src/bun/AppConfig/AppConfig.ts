import { mkdirSync } from 'fs'
import { dirname } from 'node:path'
import {
  DEFAULT_MAX_RECORDING_DURATION_SECONDS,
  isValidMaxRecordingDurationSeconds,
  type RecordingDurationPresetSeconds,
} from '../../shared/recording-duration-presets'
import { isSupportedShortcutId } from '../../shared/shortcut-options'
import { isValidTranscriptionLanguageId } from '../../shared/transcription-languages'
import type {
  AppSettings,
  AudioDeviceDetails,
  AudioDuckingSettings,
  AudioDuckingSettingsPatch,
  DictationFailureNotice,
  DictionaryCandidate,
  DictionaryEntry,
  DictionarySettings,
  DictionarySettingsPatch,
  FormatterModelTier,
  FormattingRuntimeSettings,
  FormattingSettings,
  FormattingSettingsPatch,
  GeneralSettingsPatch,
  HistorySettingsPatch,
  RecordingIndicatorMode,
  StatsSettingsPatch,
  ShortcutId,
  StreamTranscriptionMode,
  ThemePreference,
  TranscriptionSettingsPatch,
} from '../../shared/types'
import { DEFAULT_MODEL_ID } from '../../shared/speech-models'
import type { PlatformCapabilities } from '../../shared/platform'
import {
  buildDictationPlan,
  getDictationReadiness,
  type BlockedDictationPlan,
  type DictationAvailability,
  type DictationPlan,
  type DictationReadiness,
} from '../../shared/dictation-plan'
import {
  applyRunnableDictationPatch,
  healDictationSettings,
  type RunnableDictationSettings,
  type SettingsHealAnnouncement,
} from '../../shared/settings-heal'
import {
  FORMATTING_MODE_ORDER,
  isValidDocumentStructure,
  isValidDocumentTone,
  isValidEmailClosingStyle,
  isValidEmailGreetingStyle,
  isValidFormattingModeId,
  isValidImessageTone,
  isValidSlackTone,
  type FormattingModeId,
} from '../../shared/formatting-modes'
import { persistedSpeechModelId } from './persisted-speech-model'
import {
  BUILTIN_DICTIONARY_ENTRIES,
  SerializedSnapshotWriter,
  formattingSettingsAfterPatch,
  legacyMigrationPlan,
  withBuiltinDictionaryEntries,
} from './state-helpers'
import { disableDebug, enableDebug, log } from '../utils/logger'
import {
  invalidateDictionaryCandidatesForText as getInvalidatedDictionaryCandidatesForText,
  parseDictionaryCandidates,
  stageDictionaryCandidate,
} from '../utils/dictionary/auto-learn-candidates'

export interface AppConfigPaths {
  readonly mainConfig: string
  readonly dictionaryConfig: string
  readonly legacyConfig: string
  readonly defaultHistory: string
}

export interface AppConfigDependencies {
  readonly paths: AppConfigPaths
  readonly getPlatformCapabilities: () => PlatformCapabilities
  readonly isModelAvailable: (id: string) => boolean
  readonly getModelAvailability: () => Record<string, boolean>
  readonly detectFormattingAvailable: () => boolean
  readonly isFormatterModelInstalled: (tier: FormatterModelTier) => boolean
}

const RECORDING_INDICATOR_MODES = new Set<RecordingIndicatorMode>([
  'off',
  'always',
  'when-active',
])

function isValidRecordingIndicatorMode(
  id: unknown
): id is RecordingIndicatorMode {
  return (
    typeof id === 'string' &&
    RECORDING_INDICATOR_MODES.has(id as RecordingIndicatorMode)
  )
}

function normalizeDictionaryKey(
  kind: DictionaryEntry['kind'],
  text: string,
  from?: string
): string {
  const normalizedText = text.trim().toLowerCase()
  if (kind === 'replacement') {
    return `replacement:${(from ?? '').trim().toLowerCase()}=>${normalizedText}`
  }
  return `fuzzy:${normalizedText}`
}

function defaultEnabledModes(): FormattingSettings['enabledModes'] {
  return {
    email: false,
    imessage: false,
    slack: false,
    document: false,
  }
}

function defaultFormattingSettings(
  available: boolean,
  modelAvailability: Record<FormatterModelTier, boolean>
): FormattingSettings {
  return {
    enabled: false,
    enabledModes: defaultEnabledModes(),
    forceModeId: null,
    formatterModelTier: 'fast',
    available,
    modelAvailability,
    email: {
      includeSenderName: false,
      greetingStyle: 'auto',
      closingStyle: 'auto',
      customGreeting: '',
      customClosing: '',
    },
    imessage: {
      tone: 'neutral',
      allowEmoji: false,
      // Default to LLM polish (not the deterministic bypass). Was true when
      // the backend was Apple Intelligence (slow / unreliable); the local
      // llama-completion run is ~1s, so the LLM is the better default now.
      lightweight: false,
    },
    slack: {
      tone: 'professional',
      allowEmoji: false,
      useMarkdown: true,
      lightweight: false,
    },
    document: {
      tone: 'neutral',
      structure: 'prose',
      lightweight: false,
    },
  }
}

function defaultAudioDuckingSettings(): AudioDuckingSettings {
  return {
    level: 0,
    includeHeadphones: true,
    includeBuiltInSpeakers: true,
  }
}

function defaultDictionarySettings(): DictionarySettings {
  return {
    entries: BUILTIN_DICTIONARY_ENTRIES.map((entry) => ({ ...entry })),
    autoLearn: true,
    candidates: [],
  }
}

interface PersistedMainSettings {
  audioDeviceName: string | null
  audioDeviceId: string | null
  audioDevice: number
  shortcutId: ShortcutId
  shortcutHoldOnlyId: ShortcutId | null
  funModeEnabled: boolean
  soundEffectsEnabled: boolean
  transcriptionLanguageId: string
  maxRecordingDuration: RecordingDurationPresetSeconds
  speechModelId: string
  translateToEnglish: boolean
  translateDefaultLanguageId: string
  onboardingCompleted: boolean
  recordingIndicatorMode: RecordingIndicatorMode
  recordingIndicatorPosition: { x: number; y: number } | null
  streamMode: boolean
  parakeetCoreMlReady: boolean
  streamTranscriptionMode: StreamTranscriptionMode
  userDisplayName: string
  formatting: Omit<FormattingSettings, 'available' | 'modelAvailability'>
  audioDucking: AudioDuckingSettings
  historyEnabled: boolean
  historyStoragePath: string
  historyMaxEntries: number
  historySaveAudio: boolean
  statsEnabled: boolean
  statsBackfillDone: boolean
  themePreference: ThemePreference
  debugMode: false
}

interface PersistedDictionarySettings {
  entries: DictionaryEntry[]
  autoLearn: boolean
  candidates: DictionaryCandidate[]
}

export class AppConfig {
  private audioDeviceName: string | null
  private audioDeviceId: string | null
  private audioDevice: number
  private shortcutId: ShortcutId
  private shortcutHoldOnlyId: ShortcutId | null
  private debugMode: boolean
  private funModeEnabled: boolean
  private soundEffectsEnabled: boolean
  private transcriptionLanguageId: string
  private maxRecordingDuration: RecordingDurationPresetSeconds
  private speechModelId: string
  private translateToEnglish: boolean
  private translateDefaultLanguageId: string
  private onboardingCompleted: boolean
  private recordingIndicatorMode: RecordingIndicatorMode
  private recordingIndicatorPosition: { x: number; y: number } | null
  private streamMode: boolean
  private parakeetCoreMlReady: boolean
  private streamTranscriptionMode: StreamTranscriptionMode
  private userDisplayName: string
  private formatting: FormattingSettings
  private audioDucking: AudioDuckingSettings
  private dictionary: DictionarySettings
  private historyEnabled: boolean
  private historyStoragePath: string
  private historyMaxEntries: number
  private historySaveAudio: boolean
  private statsEnabled: boolean
  private statsBackfillDone: boolean
  private themePreference: ThemePreference
  private _recentlyAppliedEntries: DictionaryEntry[] = []
  private recordingIndicatorOnboardingPreviewMode: RecordingIndicatorMode | null =
    null
  /**
   * What the most recent heal pass changed behind the user's back, carried in the settings
   * payload so the window can say it out loud. In memory only: an announcement describes one
   * moment, and replaying it after a restart would be a lie.
   */
  private healAnnouncements: SettingsHealAnnouncement[] = []

  /**
   * The last Dictation that refused to start, carried in the same settings payload for the
   * same reason. In memory only, and cleared by the first press that runs - which is the
   * whole promise a blocked plan makes.
   */
  private blockedDictation: BlockedDictationPlan | null = null

  /**
   * The last Dictation that started and then produced nothing. Same slot in the settings
   * payload, same in-memory lifetime - and deliberately not the same correction: a failed run
   * does not trigger the heal pass, because the configuration was runnable. ADR-0006.
   */
  private dictationFailure: DictationFailureNotice | null = null
  private readonly mainWriter: SerializedSnapshotWriter<string>
  private readonly dictionaryWriter: SerializedSnapshotWriter<string>

  /**
   * Wired once at boot. Everything derived from the `(settings, availability)` pair that
   * lives outside this class - today only Parakeet's automatic preparation - has to hear
   * about every change to either half, and there are two entry points rather than one: a
   * transcription settings write, and the heal pass that runs at boot, on a download, on a
   * delete and after a blocked Dictation.
   *
   * A callback rather than a direct call, so that `AppConfig` stays the settings adapter and
   * needs to know nothing about the process a preparation spawns.
   */
  private runnableDictationObserver: (() => void) | null = null

  constructor(private readonly dependencies: AppConfigDependencies) {
    this.mainWriter = new SerializedSnapshotWriter<string>(async (snapshot) => {
      mkdirSync(dirname(this.dependencies.paths.mainConfig), {
        recursive: true,
      })
      await Bun.write(this.dependencies.paths.mainConfig, snapshot)
    })
    this.dictionaryWriter = new SerializedSnapshotWriter<string>(
      async (snapshot) => {
        mkdirSync(dirname(this.dependencies.paths.dictionaryConfig), {
          recursive: true,
        })
        await Bun.write(this.dependencies.paths.dictionaryConfig, snapshot)
      }
    )
    this.audioDeviceName = null
    this.audioDeviceId = null
    this.audioDevice = 0
    this.shortcutId = 'option-space'
    this.shortcutHoldOnlyId = null
    this.debugMode = false
    this.funModeEnabled = false
    this.soundEffectsEnabled = true
    this.transcriptionLanguageId = 'auto'
    this.maxRecordingDuration = DEFAULT_MAX_RECORDING_DURATION_SECONDS
    this.speechModelId = DEFAULT_MODEL_ID
    this.translateToEnglish = false
    this.translateDefaultLanguageId = 'auto'
    this.onboardingCompleted = false
    this.recordingIndicatorMode = 'always'
    this.recordingIndicatorPosition = null
    this.streamMode = false
    this.parakeetCoreMlReady = false
    this.streamTranscriptionMode = 'vad'
    this.userDisplayName = ''
    this.formatting = defaultFormattingSettings(
      this.dependencies.detectFormattingAvailable(),
      {
        fast: this.dependencies.isFormatterModelInstalled('fast'),
        quality: this.dependencies.isFormatterModelInstalled('quality'),
      }
    )
    this.audioDucking = defaultAudioDuckingSettings()
    this.dictionary = defaultDictionarySettings()
    this.historyEnabled = false
    this.historyStoragePath = ''
    this.historyMaxEntries = 250
    this.historySaveAudio = false
    this.statsEnabled = false
    this.statsBackfillDone = false
    this.themePreference = 'dark'
  }

  private getPersistedMainSettings(): PersistedMainSettings {
    return {
      audioDeviceName: this.audioDeviceName,
      audioDeviceId: this.audioDeviceId,
      audioDevice: this.audioDevice,
      shortcutId: this.shortcutId,
      shortcutHoldOnlyId: this.shortcutHoldOnlyId,
      funModeEnabled: this.funModeEnabled,
      soundEffectsEnabled: this.soundEffectsEnabled,
      transcriptionLanguageId: this.transcriptionLanguageId,
      maxRecordingDuration: this.maxRecordingDuration,
      speechModelId: this.speechModelId,
      translateToEnglish: this.translateToEnglish,
      translateDefaultLanguageId: this.translateDefaultLanguageId,
      onboardingCompleted: this.onboardingCompleted,
      recordingIndicatorMode: this.recordingIndicatorMode,
      recordingIndicatorPosition: this.recordingIndicatorPosition,
      streamMode: this.streamMode,
      parakeetCoreMlReady: this.parakeetCoreMlReady,
      streamTranscriptionMode: this.streamTranscriptionMode,
      userDisplayName: this.userDisplayName,
      formatting: {
        enabled: this.formatting.enabled,
        enabledModes: { ...this.formatting.enabledModes },
        forceModeId: this.formatting.forceModeId,
        formatterModelTier: this.formatting.formatterModelTier,
        email: { ...this.formatting.email },
        imessage: { ...this.formatting.imessage },
        slack: { ...this.formatting.slack },
        document: { ...this.formatting.document },
      },
      audioDucking: { ...this.audioDucking },
      historyEnabled: this.historyEnabled,
      historyStoragePath: this.historyStoragePath,
      historyMaxEntries: this.historyMaxEntries,
      historySaveAudio: this.historySaveAudio,
      statsEnabled: this.statsEnabled,
      statsBackfillDone: this.statsBackfillDone,
      themePreference: this.themePreference,
      debugMode: false,
    }
  }

  private async saveMain(): Promise<void> {
    const snapshot = JSON.stringify(this.getPersistedMainSettings(), null, 2)
    await this.mainWriter.write(snapshot)
  }

  private async saveDictionary(): Promise<void> {
    // Every path that persists the dictionary passes through here, including auto-learning
    // helpers that do not call updateDictionarySettings.
    this.ensureBuiltinDictionaryEntries()
    const snapshot: PersistedDictionarySettings = {
      entries: this.dictionary.entries.map((entry) => ({ ...entry })),
      autoLearn: this.dictionary.autoLearn,
      candidates: this.dictionary.candidates.map((candidate) => ({
        ...candidate,
      })),
    }
    await this.dictionaryWriter.write(JSON.stringify(snapshot, null, 2))
  }

  private async saveAll(): Promise<void> {
    await Promise.all([this.saveMain(), this.saveDictionary()])
  }

  private applyPersistedMain(raw: Record<string, unknown>): void {
    const platform = this.dependencies.getPlatformCapabilities().platform
    if (raw.audioDeviceName !== undefined) {
      this.audioDeviceName =
        typeof raw.audioDeviceName === 'string' || raw.audioDeviceName === null
          ? raw.audioDeviceName
          : this.audioDeviceName
    }
    if (raw.audioDeviceId !== undefined) {
      this.audioDeviceId =
        typeof raw.audioDeviceId === 'string' || raw.audioDeviceId === null
          ? raw.audioDeviceId
          : this.audioDeviceId
    }
    if (typeof raw.audioDevice === 'number') this.audioDevice = raw.audioDevice
    if (isSupportedShortcutId(raw.shortcutId, platform)) {
      this.shortcutId = raw.shortcutId
    }
    if (
      raw.shortcutHoldOnlyId !== undefined &&
      raw.shortcutHoldOnlyId !== null &&
      isSupportedShortcutId(raw.shortcutHoldOnlyId, platform)
    ) {
      this.shortcutHoldOnlyId = raw.shortcutHoldOnlyId
    } else if (raw.shortcutHoldOnlyId === null) {
      this.shortcutHoldOnlyId = null
    }
    if (typeof raw.funModeEnabled === 'boolean') {
      this.funModeEnabled = raw.funModeEnabled
    }
    if (typeof raw.soundEffectsEnabled === 'boolean') {
      this.soundEffectsEnabled = raw.soundEffectsEnabled
    }
    if (
      typeof raw.transcriptionLanguageId === 'string' &&
      isValidTranscriptionLanguageId(raw.transcriptionLanguageId)
    ) {
      this.transcriptionLanguageId = raw.transcriptionLanguageId
    }
    if (
      typeof raw.maxRecordingDuration === 'number' &&
      isValidMaxRecordingDurationSeconds(raw.maxRecordingDuration)
    ) {
      this.maxRecordingDuration = raw.maxRecordingDuration
    }
    // Reads the pre-rename key too. See persisted-speech-model.ts, which owns both key names
    // and is tested without a filesystem.
    const selected = persistedSpeechModelId(raw)
    if (selected !== null) this.speechModelId = selected
    if (typeof raw.translateToEnglish === 'boolean') {
      this.translateToEnglish = raw.translateToEnglish
    }
    if (
      typeof raw.translateDefaultLanguageId === 'string' &&
      isValidTranscriptionLanguageId(raw.translateDefaultLanguageId)
    ) {
      this.translateDefaultLanguageId = raw.translateDefaultLanguageId
    } else {
      this.translateDefaultLanguageId = 'auto'
    }
    if (raw.onboardingCompleted === true) this.onboardingCompleted = true
    else if (raw.onboardingCompleted === false) this.onboardingCompleted = false
    // Existing installs predate this field and must not re-enter first-run onboarding.
    else this.onboardingCompleted = true
    if (isValidRecordingIndicatorMode(raw.recordingIndicatorMode)) {
      this.recordingIndicatorMode = raw.recordingIndicatorMode
    }
    if (
      raw.recordingIndicatorPosition !== null &&
      typeof raw.recordingIndicatorPosition === 'object' &&
      raw.recordingIndicatorPosition !== undefined &&
      Number.isFinite((raw.recordingIndicatorPosition as { x: unknown }).x) &&
      Number.isFinite((raw.recordingIndicatorPosition as { y: unknown }).y)
    ) {
      this.recordingIndicatorPosition = {
        x: Number((raw.recordingIndicatorPosition as { x: unknown }).x),
        y: Number((raw.recordingIndicatorPosition as { y: unknown }).y),
      }
    } else if (raw.recordingIndicatorPosition === null) {
      this.recordingIndicatorPosition = null
    }
    if (
      this.shortcutHoldOnlyId !== null &&
      this.shortcutHoldOnlyId === this.shortcutId
    ) {
      this.shortcutHoldOnlyId = null
    }
    if (typeof raw.streamMode === 'boolean') this.streamMode = raw.streamMode
    if (typeof raw.parakeetCoreMlReady === 'boolean') {
      this.parakeetCoreMlReady = raw.parakeetCoreMlReady
    } else {
      this.parakeetCoreMlReady = this.dependencies.isModelAvailable(
        'parakeet-tdt-0.6b-v3'
      )
    }
    if (
      raw.streamTranscriptionMode === 'live' ||
      raw.streamTranscriptionMode === 'vad'
    ) {
      this.streamTranscriptionMode = raw.streamTranscriptionMode
    }
    if (typeof raw.userDisplayName === 'string') {
      this.userDisplayName = raw.userDisplayName.trim()
    }
    if (
      raw.themePreference === 'system' ||
      raw.themePreference === 'light' ||
      raw.themePreference === 'dark'
    ) {
      this.themePreference = raw.themePreference
    }
    if (typeof raw.debugMode === 'boolean') {
      this.debugMode = raw.debugMode
      if (this.debugMode) enableDebug()
    }

    if (raw.formatting && typeof raw.formatting === 'object') {
      const formatting = raw.formatting as Record<string, unknown>
      if (typeof formatting.enabled === 'boolean') {
        this.formatting.enabled = formatting.enabled
      }
      if (formatting.forceModeId === null) {
        this.formatting.forceModeId = null
      } else if (isValidFormattingModeId(formatting.forceModeId)) {
        this.formatting.forceModeId = formatting.forceModeId
      }
      const validTiers: FormatterModelTier[] = ['fast', 'quality']
      if (
        validTiers.includes(formatting.formatterModelTier as FormatterModelTier)
      ) {
        this.formatting.formatterModelTier =
          formatting.formatterModelTier as FormatterModelTier
      }
      if (
        formatting.enabledModes &&
        typeof formatting.enabledModes === 'object'
      ) {
        const next = defaultEnabledModes()
        for (const id of FORMATTING_MODE_ORDER) {
          const value = (formatting.enabledModes as Record<string, unknown>)[id]
          if (typeof value === 'boolean') next[id] = value
        }
        this.formatting.enabledModes = next
      }
      if (formatting.email && typeof formatting.email === 'object') {
        const email = formatting.email as Record<string, unknown>
        if (typeof email.includeSenderName === 'boolean') {
          this.formatting.email.includeSenderName = email.includeSenderName
        }
        if (isValidEmailGreetingStyle(email.greetingStyle)) {
          this.formatting.email.greetingStyle = email.greetingStyle
        }
        if (isValidEmailClosingStyle(email.closingStyle)) {
          this.formatting.email.closingStyle = email.closingStyle
        }
        if (typeof email.customGreeting === 'string') {
          this.formatting.email.customGreeting = email.customGreeting
        }
        if (typeof email.customClosing === 'string') {
          this.formatting.email.customClosing = email.customClosing
        }
      }
      if (formatting.imessage && typeof formatting.imessage === 'object') {
        const imessage = formatting.imessage as Record<string, unknown>
        if (isValidImessageTone(imessage.tone)) {
          this.formatting.imessage.tone = imessage.tone
        }
        if (typeof imessage.allowEmoji === 'boolean') {
          this.formatting.imessage.allowEmoji = imessage.allowEmoji
        }
        if (typeof imessage.lightweight === 'boolean') {
          this.formatting.imessage.lightweight = imessage.lightweight
        }
      }
      if (formatting.slack && typeof formatting.slack === 'object') {
        const slack = formatting.slack as Record<string, unknown>
        if (isValidSlackTone(slack.tone)) {
          this.formatting.slack.tone = slack.tone
        }
        if (typeof slack.allowEmoji === 'boolean') {
          this.formatting.slack.allowEmoji = slack.allowEmoji
        }
        if (typeof slack.useMarkdown === 'boolean') {
          this.formatting.slack.useMarkdown = slack.useMarkdown
        }
        if (typeof slack.lightweight === 'boolean') {
          this.formatting.slack.lightweight = slack.lightweight
        }
      }
      if (formatting.document && typeof formatting.document === 'object') {
        const document = formatting.document as Record<string, unknown>
        if (isValidDocumentTone(document.tone)) {
          this.formatting.document.tone = document.tone
        }
        if (isValidDocumentStructure(document.structure)) {
          this.formatting.document.structure = document.structure
        }
        if (typeof document.lightweight === 'boolean') {
          this.formatting.document.lightweight = document.lightweight
        }
      }
    }

    if (raw.audioDucking && typeof raw.audioDucking === 'object') {
      const audioDucking = raw.audioDucking as Record<string, unknown>
      if (
        typeof audioDucking.level === 'number' &&
        Number.isFinite(audioDucking.level) &&
        audioDucking.level >= 0 &&
        audioDucking.level <= 100
      ) {
        this.audioDucking.level = Math.round(audioDucking.level)
      }
      if (typeof audioDucking.includeHeadphones === 'boolean') {
        this.audioDucking.includeHeadphones = audioDucking.includeHeadphones
      }
      if (typeof audioDucking.includeBuiltInSpeakers === 'boolean') {
        this.audioDucking.includeBuiltInSpeakers =
          audioDucking.includeBuiltInSpeakers
      }
    }

    if (typeof raw.historyEnabled === 'boolean') {
      this.historyEnabled = raw.historyEnabled
    }
    if (typeof raw.historyStoragePath === 'string') {
      this.historyStoragePath = raw.historyStoragePath
    }
    if (typeof raw.historyMaxEntries === 'number') {
      this.historyMaxEntries = raw.historyMaxEntries
    }
    if (typeof raw.historySaveAudio === 'boolean') {
      this.historySaveAudio = raw.historySaveAudio
    }
    if (typeof raw.statsEnabled === 'boolean') {
      this.statsEnabled = raw.statsEnabled
    }
    if (typeof raw.statsBackfillDone === 'boolean') {
      this.statsBackfillDone = raw.statsBackfillDone
    }
  }

  private parseDictionaryEntries(value: unknown): DictionaryEntry[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const parsed: DictionaryEntry[] = []
    for (const entry of value) {
      if (typeof entry === 'string') {
        const text = entry.trim()
        if (!text) continue
        const key = normalizeDictionaryKey('fuzzy', text)
        if (seen.has(key)) continue
        seen.add(key)
        parsed.push({ kind: 'fuzzy', text, source: 'manual' })
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const source =
        record.source === 'auto' ? ('auto' as const) : ('manual' as const)
      const kind =
        record.kind === 'replacement'
          ? ('replacement' as const)
          : ('fuzzy' as const)
      const textValue =
        typeof record.text === 'string'
          ? record.text
          : typeof record.word === 'string'
            ? record.word
            : ''
      const text = textValue.trim()
      if (!text) continue
      const from =
        kind === 'replacement' && typeof record.from === 'string'
          ? record.from.trim()
          : undefined
      if (kind === 'replacement' && !from) continue
      const key = normalizeDictionaryKey(kind, text, from)
      if (seen.has(key)) continue
      seen.add(key)
      const confidence =
        typeof record.confidence === 'number' &&
        Number.isFinite(record.confidence)
          ? record.confidence
          : undefined
      const timesApplied =
        typeof record.timesApplied === 'number' &&
        Number.isFinite(record.timesApplied)
          ? record.timesApplied
          : undefined
      const timesAccepted =
        typeof record.timesAccepted === 'number' &&
        Number.isFinite(record.timesAccepted)
          ? record.timesAccepted
          : undefined
      const timesReverted =
        typeof record.timesReverted === 'number' &&
        Number.isFinite(record.timesReverted)
          ? record.timesReverted
          : undefined
      const confidenceFields =
        confidence !== undefined
          ? { confidence, timesApplied, timesAccepted, timesReverted }
          : {}
      parsed.push(
        kind === 'replacement'
          ? { kind, from, text, source, ...confidenceFields }
          : { kind, text, source, ...confidenceFields }
      )
    }
    return parsed
  }

  private applyDictionarySettings(raw: Record<string, unknown>): void {
    if (Array.isArray(raw.entries)) {
      this.dictionary.entries = this.parseDictionaryEntries(raw.entries)
    }
    if (typeof raw.autoLearn === 'boolean') {
      this.dictionary.autoLearn = raw.autoLearn
    }
    if (Array.isArray(raw.candidates)) {
      this.dictionary.candidates = parseDictionaryCandidates(raw.candidates)
    }
    this.ensureBuiltinDictionaryEntries()
  }

  private ensureBuiltinDictionaryEntries(): void {
    this.dictionary.entries = withBuiltinDictionaryEntries(
      this.dictionary.entries
    )
  }

  private applyLegacyMainSettings(raw: Record<string, unknown>): void {
    this.applyPersistedMain(raw)

    if (typeof raw.formattingEnabled === 'boolean') {
      this.formatting.enabled = raw.formattingEnabled
    } else if (typeof raw.formattingModeId === 'string') {
      this.formatting.enabled = raw.formattingModeId !== 'none'
    }
    if (
      raw.formattingEnabledModes &&
      typeof raw.formattingEnabledModes === 'object'
    ) {
      const next = defaultEnabledModes()
      for (const id of FORMATTING_MODE_ORDER) {
        const value = (raw.formattingEnabledModes as Record<string, unknown>)[
          id
        ]
        if (typeof value === 'boolean') next[id] = value
      }
      this.formatting.enabledModes = next
    } else if (raw.formattingModeId === 'email') {
      this.formatting.enabledModes = { ...defaultEnabledModes(), email: true }
    }
    if (raw.formattingForceModeId === null) {
      this.formatting.forceModeId = null
    } else if (isValidFormattingModeId(raw.formattingForceModeId)) {
      this.formatting.forceModeId = raw.formattingForceModeId
    }
    if (typeof raw.formattingEmailIncludeSenderName === 'boolean') {
      this.formatting.email.includeSenderName =
        raw.formattingEmailIncludeSenderName
    }
    if (isValidEmailGreetingStyle(raw.formattingEmailGreetingStyle)) {
      this.formatting.email.greetingStyle = raw.formattingEmailGreetingStyle
    }
    if (isValidEmailClosingStyle(raw.formattingEmailClosingStyle)) {
      this.formatting.email.closingStyle = raw.formattingEmailClosingStyle
    }
    if (typeof raw.formattingEmailCustomGreeting === 'string') {
      this.formatting.email.customGreeting = raw.formattingEmailCustomGreeting
    }
    if (typeof raw.formattingEmailCustomClosing === 'string') {
      this.formatting.email.customClosing = raw.formattingEmailCustomClosing
    }
    if (isValidImessageTone(raw.formattingImessageTone)) {
      this.formatting.imessage.tone = raw.formattingImessageTone
    }
    if (typeof raw.formattingImessageAllowEmoji === 'boolean') {
      this.formatting.imessage.allowEmoji = raw.formattingImessageAllowEmoji
    }
    if (typeof raw.formattingImessageLightweight === 'boolean') {
      this.formatting.imessage.lightweight = raw.formattingImessageLightweight
    }
    if (isValidSlackTone(raw.formattingSlackTone)) {
      this.formatting.slack.tone = raw.formattingSlackTone
    }
    if (typeof raw.formattingSlackAllowEmoji === 'boolean') {
      this.formatting.slack.allowEmoji = raw.formattingSlackAllowEmoji
    }
    if (typeof raw.formattingSlackUseMarkdown === 'boolean') {
      this.formatting.slack.useMarkdown = raw.formattingSlackUseMarkdown
    }
    if (typeof raw.formattingSlackLightweight === 'boolean') {
      this.formatting.slack.lightweight = raw.formattingSlackLightweight
    }
    if (isValidDocumentTone(raw.formattingDocumentTone)) {
      this.formatting.document.tone = raw.formattingDocumentTone
    }
    if (isValidDocumentStructure(raw.formattingDocumentStructure)) {
      this.formatting.document.structure = raw.formattingDocumentStructure
    }
    if (typeof raw.formattingDocumentLightweight === 'boolean') {
      this.formatting.document.lightweight = raw.formattingDocumentLightweight
    }
    if (
      typeof raw.audioDuckingLevel === 'number' &&
      Number.isFinite(raw.audioDuckingLevel) &&
      raw.audioDuckingLevel >= 0 &&
      raw.audioDuckingLevel <= 100
    ) {
      this.audioDucking.level = Math.round(raw.audioDuckingLevel)
    }
    if (typeof raw.audioDuckingIncludeHeadphones === 'boolean') {
      this.audioDucking.includeHeadphones = raw.audioDuckingIncludeHeadphones
    }
    if (typeof raw.audioDuckingIncludeBuiltInSpeakers === 'boolean') {
      this.audioDucking.includeBuiltInSpeakers =
        raw.audioDuckingIncludeBuiltInSpeakers
    }
  }

  private applyLegacyDictionarySettings(raw: Record<string, unknown>): void {
    if (Array.isArray(raw.dictionaryEntries)) {
      this.dictionary.entries = this.parseDictionaryEntries(
        raw.dictionaryEntries
      )
    }
    if (typeof raw.dictionaryAutoLearn === 'boolean') {
      this.dictionary.autoLearn = raw.dictionaryAutoLearn
    }
    this.ensureBuiltinDictionaryEntries()
  }

  public async load() {
    await this.loadFromDisk()

    // Weights can vanish between two launches - a Finder delete, a failed disk, a
    // cloud-storage eviction - with no settings write to notice it. Boot is the one place
    // that always gets to look, so the same heal pass runs here rather than a second
    // field-by-field definition of the same thing.
    await this.healRunnableSettings()
  }

  private async loadFromDisk() {
    try {
      const [hasMain, hasDictionary, hasLegacy] = await Promise.all([
        Bun.file(this.dependencies.paths.mainConfig).exists(),
        Bun.file(this.dependencies.paths.dictionaryConfig).exists(),
        Bun.file(this.dependencies.paths.legacyConfig).exists(),
      ])

      if (hasMain) {
        const raw = (await Bun.file(
          this.dependencies.paths.mainConfig
        ).json()) as Record<string, unknown>
        this.applyPersistedMain(raw)
      }
      if (hasDictionary) {
        const raw = (await Bun.file(
          this.dependencies.paths.dictionaryConfig
        ).json()) as Record<string, unknown>
        this.applyDictionarySettings(raw)
      }

      const migration = legacyMigrationPlan(hasMain, hasDictionary, hasLegacy)
      if (migration.main || migration.dictionary) {
        const raw = (await Bun.file(
          this.dependencies.paths.legacyConfig
        ).json()) as Record<string, unknown>
        if (migration.main) this.applyLegacyMainSettings(raw)
        if (migration.dictionary) this.applyLegacyDictionarySettings(raw)
      }

      if (!hasMain && !hasDictionary && !hasLegacy) {
        log('config', 'using default app config', {
          shortcutId: this.shortcutId,
          streamMode: this.streamMode,
          streamTranscriptionMode: this.streamTranscriptionMode,
        })
        return
      }

      if (migration.main && migration.dictionary) await this.saveAll()
      else if (migration.main) await this.saveMain()
      else if (migration.dictionary) await this.saveDictionary()

      log('config', 'loaded app config', {
        shortcutId: this.shortcutId,
        shortcutHoldOnlyId: this.shortcutHoldOnlyId ?? undefined,
        streamMode: this.streamMode,
        streamTranscriptionMode: this.streamTranscriptionMode,
        translateToEnglish: this.translateToEnglish,
        transcriptionLanguageId: this.transcriptionLanguageId,
        formattingEnabled: this.formatting.enabled,
        formattingForceModeId: this.formatting.forceModeId,
      })
    } catch {
      log('config', 'using default app config', {
        shortcutId: this.shortcutId,
        streamMode: this.streamMode,
        streamTranscriptionMode: this.streamTranscriptionMode,
      })
    }
  }

  public getSettings(): AppSettings {
    const dictionaryEntries = this.dictionary.entries.map((entry) => ({
      ...entry,
    }))
    const dictionaryCandidates = this.dictionary.candidates.map(
      (candidate) => ({
        ...candidate,
      })
    )
    return {
      capabilities: this.dependencies.getPlatformCapabilities(),
      shortcutId: this.shortcutId,
      shortcutHoldOnlyId: this.shortcutHoldOnlyId,
      maxRecordingDuration: this.maxRecordingDuration,
      debugMode: this.debugMode,
      funModeEnabled: this.funModeEnabled,
      soundEffectsEnabled: this.soundEffectsEnabled,
      transcriptionLanguageId: this.transcriptionLanguageId,
      speechModelId: this.speechModelId,
      translateToEnglish: this.translateToEnglish,
      translateDefaultLanguageId: this.translateDefaultLanguageId,
      onboardingCompleted: this.onboardingCompleted,
      recordingIndicatorMode: this.recordingIndicatorMode,
      recordingIndicatorPosition: this.recordingIndicatorPosition,
      streamMode: this.streamMode,
      parakeetCoreMlReady: this.parakeetCoreMlReady,
      streamTranscriptionMode: this.streamTranscriptionMode,
      userDisplayName: this.userDisplayName,
      formatting: {
        ...this.formatting,
        enabledModes: { ...this.formatting.enabledModes },
        email: { ...this.formatting.email },
        imessage: { ...this.formatting.imessage },
        slack: { ...this.formatting.slack },
        document: { ...this.formatting.document },
      },
      audioDucking: { ...this.audioDucking },
      dictionary: {
        entries: dictionaryEntries,
        autoLearn: this.dictionary.autoLearn,
        candidates: dictionaryCandidates,
      },
      history: {
        enabled: this.historyEnabled,
        storagePath:
          this.historyStoragePath || this.dependencies.paths.defaultHistory,
        maxEntries: this.historyMaxEntries,
        saveAudio: this.historySaveAudio,
      },
      stats: {
        enabled: this.statsEnabled,
      },
      themePreference: this.themePreference,
      modelAvailability: this.dependencies.getModelAvailability(),
      healAnnouncements: this.getHealAnnouncements(),
      dictationReadiness: this.getDictationReadiness(),
      blockedDictation: this.getBlockedDictation(),
      dictationFailure: this.getDictationFailure(),
    }
  }

  /**
   * The `(settings, availability)` pair ADR-0005 is built on. `modelManager` and the platform
   * probe are read here and nowhere deeper, which is what keeps the heal pass itself pure.
   */
  private dictationAvailability(): DictationAvailability {
    return {
      isModelAvailable: this.dependencies.isModelAvailable,
      streamSupported:
        this.dependencies.getPlatformCapabilities().supportsStreamMode,
    }
  }

  private runnableDictationSettings(): RunnableDictationSettings {
    return {
      speechModelId: this.speechModelId,
      transcriptionLanguageId: this.transcriptionLanguageId,
      translateDefaultLanguageId: this.translateDefaultLanguageId,
      translateToEnglish: this.translateToEnglish,
      streamMode: this.streamMode,
      parakeetCoreMlReady: this.parakeetCoreMlReady,
    }
  }

  private applyRunnableDictationSettings(
    next: RunnableDictationSettings
  ): void {
    this.speechModelId = next.speechModelId
    this.transcriptionLanguageId = next.transcriptionLanguageId
    this.translateDefaultLanguageId = next.translateDefaultLanguageId
    this.translateToEnglish = next.translateToEnglish
    this.streamMode = next.streamMode
    this.parakeetCoreMlReady = next.parakeetCoreMlReady
  }

  private recordHealAnnouncements(
    announcements: SettingsHealAnnouncement[]
  ): void {
    if (announcements.length === 0) return
    this.healAnnouncements = announcements
    for (const announcement of announcements) {
      log('config', 'healed settings', {
        target: announcement.target,
        reason: announcement.reason,
      })
    }
  }

  /**
   * Register the observer above, and fire it once immediately.
   *
   * The immediate call is deliberate: `load()` has already healed by the time boot gets here,
   * so the current selection is the first change the observer needs to hear about.
   */
  public observeRunnableDictationSettings(observer: () => void): void {
    this.runnableDictationObserver = observer
    observer()
  }

  private notifyRunnableDictationSettled(): void {
    this.runnableDictationObserver?.()
  }

  /**
   * The availability arm of the enforcement: run after a Speech Model is downloaded or
   * deleted, and at boot. It corrects rather than refuses, because someone deleting
   * multi-gigabyte weights wants the disk space, not an argument.
   *
   * Returns what has to be said out loud, so the caller can also resync the tray and stop a
   * Live Transcription that just lost its Speech Model.
   */
  public async healRunnableSettings(options?: {
    /**
     * Retire an earlier correction if this pass finds nothing left to heal.
     *
     * Only the availability callers pass this. A correction is worth saying once and then
     * leaving on screen, so an ordinary settings write must not wipe it half a second after
     * it appeared - but a Speech Model finishing its download is the user fixing the very
     * thing the correction was about, and a notice that outlives its cause is just wrong.
     */
    retireSettledAnnouncements?: boolean
  }): Promise<SettingsHealAnnouncement[]> {
    const result = healDictationSettings(
      this.runnableDictationSettings(),
      this.dictationAvailability()
    )
    if (result.unchanged) {
      if (
        options?.retireSettledAnnouncements === true &&
        this.healAnnouncements.length > 0
      ) {
        this.healAnnouncements = []
      }
      // Still a settled `(settings, availability)` pair, and the availability half may be
      // what moved: a finished Parakeet download changes nothing about the settings and is
      // exactly the moment a preparation becomes possible.
      this.notifyRunnableDictationSettled()
      return []
    }
    this.applyRunnableDictationSettings(result.settings)
    this.recordHealAnnouncements(result.announcements)
    await this.saveMain()
    this.notifyRunnableDictationSettled()
    return result.announcements
  }

  /**
   * The one answer to "can Translate to English / Live Transcription run right now",
   * computed here because `dictationAvailability()` reads the filesystem and carries a
   * predicate that cannot cross the RPC bridge. Shipped as plain data in `getSettings()`.
   */
  private getDictationReadiness(): DictationReadiness {
    return getDictationReadiness(
      this.runnableDictationSettings(),
      this.dictationAvailability()
    )
  }

  /**
   * The whole run decision for one press of the Dictation Shortcut: which Speech Model,
   * Speech Engine, crispasr backend and Transcription Language will run, or the closed reason
   * nothing will. The Dictation path consumes this and re-derives none of it.
   *
   * Built fresh on every press rather than cached, because the availability half is a
   * filesystem question and weights can vanish between two presses with no settings write in
   * between. That case is the entire reason a blocked plan exists.
   */
  public getDictationPlan(): DictationPlan {
    return buildDictationPlan(
      this.runnableDictationSettings(),
      this.dictationAvailability()
    )
  }

  /**
   * Remember a Dictation that refused to start, so the window can show it in the banner slot
   * the heal announcements already use. Not persisted: the next press either works or blocks
   * again.
   */
  public recordBlockedDictation(plan: BlockedDictationPlan): void {
    this.blockedDictation = { ...plan }
    log('config', 'dictation blocked', { mode: plan.mode, reason: plan.reason })
  }

  /** Retires the notice once a Dictation runs. Returns true when there was one to retire. */
  public clearBlockedDictation(): boolean {
    if (this.blockedDictation === null) return false
    this.blockedDictation = null
    return true
  }

  private getBlockedDictation(): BlockedDictationPlan | null {
    return this.blockedDictation === null ? null : { ...this.blockedDictation }
  }

  /**
   * Remember a Dictation that ran and produced nothing, for the same banner slot. Not
   * persisted, and no heal pass: the settings were runnable, so there is nothing to correct.
   */
  public recordFailedDictation(failure: DictationFailureNotice): void {
    this.dictationFailure = { reason: failure.reason, message: failure.message }
    log('config', 'dictation failed', { reason: failure.reason })
  }

  /** Retires the notice once a Dictation runs. Returns true when there was one to retire. */
  public clearFailedDictation(): boolean {
    if (this.dictationFailure === null) return false
    this.dictationFailure = null
    return true
  }

  private getDictationFailure(): DictationFailureNotice | null {
    return this.dictationFailure === null ? null : { ...this.dictationFailure }
  }

  /**
   * Retire a correction because the user said they had read it. Returns true when there was
   * one to retire, so the caller only pushes settings when something actually changed.
   */
  public dismissHealAnnouncements(): boolean {
    if (this.healAnnouncements.length === 0) return false
    this.healAnnouncements = []
    return true
  }

  private getHealAnnouncements(): SettingsHealAnnouncement[] {
    return this.healAnnouncements.map((announcement) => ({ ...announcement }))
  }

  public getFormattingRuntimeSettings(): FormattingRuntimeSettings {
    return {
      enabled: this.formatting.enabled,
      enabledModes: { ...this.formatting.enabledModes },
      forceModeId: this.formatting.forceModeId,
      modelInstalled:
        this.formatting.modelAvailability[this.formatting.formatterModelTier],
      transcriptionLanguageId: this.transcriptionLanguageId,
      userDisplayName: this.userDisplayName,
      formatterModelTier: this.formatting.formatterModelTier,
      email: { ...this.formatting.email },
      imessage: { ...this.formatting.imessage },
      slack: { ...this.formatting.slack },
      document: { ...this.formatting.document },
    }
  }

  /** Re-check whether each formatter model GGUF exists on disk. */
  public refreshFormatterModelInstalled(): void {
    this.formatting.modelAvailability = {
      fast: this.dependencies.isFormatterModelInstalled('fast'),
      quality: this.dependencies.isFormatterModelInstalled('quality'),
    }
  }

  public async updateGeneralSettings(
    patch: GeneralSettingsPatch
  ): Promise<boolean> {
    const platform = this.dependencies.getPlatformCapabilities().platform
    if (
      patch.shortcutId !== undefined &&
      !isSupportedShortcutId(patch.shortcutId, platform)
    ) {
      return false
    }
    if (patch.shortcutHoldOnlyId !== undefined) {
      if (
        patch.shortcutHoldOnlyId !== null &&
        !isSupportedShortcutId(patch.shortcutHoldOnlyId, platform)
      ) {
        return false
      }
      const shortcutId = patch.shortcutId ?? this.shortcutId
      if (patch.shortcutHoldOnlyId === shortcutId) return false
    }
    if (
      patch.recordingIndicatorMode !== undefined &&
      !RECORDING_INDICATOR_MODES.has(patch.recordingIndicatorMode)
    ) {
      return false
    }
    if (
      patch.themePreference !== undefined &&
      patch.themePreference !== 'system' &&
      patch.themePreference !== 'light' &&
      patch.themePreference !== 'dark'
    ) {
      return false
    }
    if (patch.recordingIndicatorPosition !== undefined) {
      const pos = patch.recordingIndicatorPosition
      if (
        pos !== null &&
        (!Number.isFinite(pos.x) || !Number.isFinite(pos.y))
      ) {
        return false
      }
    }

    if (patch.shortcutId !== undefined) this.shortcutId = patch.shortcutId
    if (patch.shortcutHoldOnlyId !== undefined) {
      this.shortcutHoldOnlyId = patch.shortcutHoldOnlyId
    }
    if (
      this.shortcutHoldOnlyId !== null &&
      this.shortcutHoldOnlyId === this.shortcutId
    ) {
      this.shortcutHoldOnlyId = null
    }
    if (patch.debugMode !== undefined) {
      this.debugMode = patch.debugMode
      if (patch.debugMode) enableDebug()
      else disableDebug()
    }
    if (patch.funModeEnabled !== undefined) {
      this.funModeEnabled = patch.funModeEnabled
    }
    if (patch.soundEffectsEnabled !== undefined) {
      this.soundEffectsEnabled = patch.soundEffectsEnabled
    }
    if (patch.userDisplayName !== undefined) {
      this.userDisplayName = patch.userDisplayName.trim()
      if (this.userDisplayName) {
        this.formatting.email.includeSenderName = true
      }
    }
    if (patch.onboardingCompleted !== undefined) {
      this.onboardingCompleted = patch.onboardingCompleted
      if (this.onboardingCompleted) {
        this.recordingIndicatorOnboardingPreviewMode = null
      }
    }
    if (patch.recordingIndicatorMode !== undefined) {
      this.recordingIndicatorMode = patch.recordingIndicatorMode
    }
    if (patch.recordingIndicatorPosition !== undefined) {
      this.recordingIndicatorPosition = patch.recordingIndicatorPosition
    }
    if (patch.themePreference !== undefined) {
      this.themePreference = patch.themePreference
    }
    await this.saveMain()
    return true
  }

  public async updateTranscriptionSettings(
    patch: TranscriptionSettingsPatch
  ): Promise<boolean> {
    // Vocabulary checks first: these fields have a fixed set of legal values and nothing to
    // do with what is installed. `speechModelId` used to be checked here too; an unknown or
    // uninstalled Speech Model is now the heal pass's business, below, because the field-level
    // version of that check was exactly the "patch valid, result invalid" gap.
    if (
      patch.transcriptionLanguageId !== undefined &&
      !isValidTranscriptionLanguageId(patch.transcriptionLanguageId)
    ) {
      return false
    }
    if (
      patch.maxRecordingDuration !== undefined &&
      !isValidMaxRecordingDurationSeconds(patch.maxRecordingDuration)
    ) {
      return false
    }
    if (
      patch.translateDefaultLanguageId !== undefined &&
      !isValidTranscriptionLanguageId(patch.translateDefaultLanguageId)
    ) {
      return false
    }
    if (
      patch.streamTranscriptionMode !== undefined &&
      patch.streamTranscriptionMode !== 'live' &&
      patch.streamTranscriptionMode !== 'vad'
    ) {
      return false
    }

    // Validate the object the patch would produce, not the fields in the patch. This is the
    // only write path that touches the runnable slice, so it is the only one that has to.
    const outcome = applyRunnableDictationPatch(
      this.runnableDictationSettings(),
      {
        ...(patch.speechModelId !== undefined
          ? { speechModelId: patch.speechModelId }
          : {}),
        ...(patch.transcriptionLanguageId !== undefined
          ? { transcriptionLanguageId: patch.transcriptionLanguageId }
          : {}),
        ...(patch.translateDefaultLanguageId !== undefined
          ? { translateDefaultLanguageId: patch.translateDefaultLanguageId }
          : {}),
        ...(patch.translateToEnglish !== undefined
          ? { translateToEnglish: patch.translateToEnglish }
          : {}),
        ...(patch.streamMode !== undefined
          ? { streamMode: patch.streamMode }
          : {}),
      },
      this.dictationAvailability()
    )

    if (outcome.kind === 'refused') {
      log('config', 'transcription settings write refused', {
        targets: outcome.refusedTargets,
        reasons: outcome.announcements.map((a) => a.reason),
      })
      // The patch is dropped, but whatever availability broke underneath it still gets
      // corrected: refusing a write is no reason to leave the config unrunnable.
      await this.healRunnableSettings()
      return false
    }

    if (patch.maxRecordingDuration !== undefined) {
      this.maxRecordingDuration = patch.maxRecordingDuration
    }
    if (patch.streamTranscriptionMode !== undefined) {
      this.streamTranscriptionMode = patch.streamTranscriptionMode
    }
    this.applyRunnableDictationSettings(outcome.settings)
    this.recordHealAnnouncements(outcome.announcements)

    await this.saveMain()
    this.notifyRunnableDictationSettled()
    return true
  }

  public async updateFormattingSettings(
    patch: FormattingSettingsPatch
  ): Promise<boolean> {
    const next = formattingSettingsAfterPatch(this.formatting, patch)
    if (next === null) return false
    if (patch.formatterModelTier !== undefined) {
      next.modelAvailability = {
        fast: this.dependencies.isFormatterModelInstalled('fast'),
        quality: this.dependencies.isFormatterModelInstalled('quality'),
      }
    }
    this.formatting = next
    await this.saveMain()
    return true
  }

  public async updateAudioDuckingSettings(
    patch: AudioDuckingSettingsPatch
  ): Promise<boolean> {
    if (
      patch.level !== undefined &&
      (!Number.isFinite(patch.level) || patch.level < 0 || patch.level > 100)
    ) {
      return false
    }
    this.audioDucking = {
      ...this.audioDucking,
      ...patch,
      ...(patch.level !== undefined ? { level: Math.round(patch.level) } : {}),
    }
    await this.saveMain()
    return true
  }

  public async updateDictionarySettings(
    patch: DictionarySettingsPatch
  ): Promise<boolean> {
    if (patch.entries !== undefined) {
      this.dictionary.entries = this.parseDictionaryEntries(patch.entries)
    }
    if (patch.autoLearn !== undefined) {
      this.dictionary.autoLearn = patch.autoLearn
    }
    if (patch.candidates !== undefined) {
      this.dictionary.candidates = parseDictionaryCandidates(patch.candidates)
    }
    await this.saveDictionary()
    return true
  }

  public getHistoryEnabled(): boolean {
    return this.historyEnabled
  }

  public getHistoryStoragePath(): string {
    return this.historyStoragePath || this.dependencies.paths.defaultHistory
  }

  public getHistorySaveAudio(): boolean {
    return this.historySaveAudio
  }

  public getHistoryMaxEntries(): number {
    return this.historyMaxEntries
  }

  public async updateHistorySettings(
    patch: HistorySettingsPatch
  ): Promise<boolean> {
    if (patch.enabled !== undefined) {
      this.historyEnabled = patch.enabled
    }
    if (patch.storagePath !== undefined) {
      this.historyStoragePath = patch.storagePath
    }
    if (patch.maxEntries !== undefined) {
      this.historyMaxEntries = patch.maxEntries
    }
    if (patch.saveAudio !== undefined) {
      this.historySaveAudio = patch.saveAudio
    }
    await this.saveMain()
    return true
  }

  public getStatsEnabled(): boolean {
    return this.statsEnabled
  }

  public isStatsBackfillDone(): boolean {
    return this.statsBackfillDone
  }

  public async markStatsBackfillDone(): Promise<void> {
    this.statsBackfillDone = true
    await this.saveMain()
  }

  public async updateStatsSettings(
    patch: StatsSettingsPatch
  ): Promise<boolean> {
    if (patch.enabled !== undefined) {
      this.statsEnabled = patch.enabled
    }
    await this.saveMain()
    return true
  }

  public resolveAudioDevice(
    devices: Record<string, string>,
    details?: Record<string, AudioDeviceDetails>
  ): number {
    if (this.audioDeviceId !== null && details !== undefined) {
      const entry = Object.entries(details).find(
        ([, device]) => device.id === this.audioDeviceId
      )
      if (entry) return Number(entry[0])
    }

    if (this.audioDeviceName !== null) {
      const entry = Object.entries(devices).find(
        ([, name]) => name === this.audioDeviceName
      )
      if (entry) return Number(entry[0])
    }
    return this.audioDevice
  }

  public resolveAudioDeviceId(
    devices: Record<string, string>,
    details?: Record<string, AudioDeviceDetails>
  ): string | null {
    const index = this.resolveAudioDevice(devices, details)
    return details?.[index.toString()]?.id ?? this.audioDeviceId
  }

  public async setAudioDevice(
    index: number,
    name?: string,
    id?: string | null
  ) {
    this.audioDevice = index
    if (name !== undefined) this.audioDeviceName = name
    if (id !== undefined) this.audioDeviceId = id
    await this.saveMain()
  }

  public getTranscriptionLanguageId(): string {
    return this.transcriptionLanguageId
  }

  // `getTranscriptionWhisperCode` and `getRuntimeTranscriptionWhisperCode` are gone. They
  // were AppConfig's own copy of "which language does the run actually use", including the
  // translate-from-auto rule, and their one caller was the transcription path. That answer
  // now lives on the Dictation Plan (`languageCode` / `transcriptionLanguageId`), which is
  // also what stats record. ADR-0005: nothing re-derives the run.

  public getShortcutId(): ShortcutId {
    return this.shortcutId
  }

  public getShortcutHoldOnlyId(): ShortcutId | null {
    return this.shortcutHoldOnlyId
  }

  public getFunModeEnabled(): boolean {
    return this.funModeEnabled
  }

  public getSoundEffectsEnabled(): boolean {
    return this.soundEffectsEnabled
  }

  public getMaxRecordingDurationSeconds(): number {
    return this.maxRecordingDuration
  }

  public getSpeechModelId(): string {
    return this.speechModelId
  }

  public getFormattingEnabled(): boolean {
    return this.formatting.enabled
  }

  public getFormattingForceModeId(): FormattingModeId | null {
    return this.formatting.forceModeId
  }

  public getAudioDuckingLevel(): number {
    return this.audioDucking.level
  }

  public getAudioDuckingIncludeHeadphones(): boolean {
    return this.audioDucking.includeHeadphones
  }

  public getAudioDuckingIncludeBuiltInSpeakers(): boolean {
    return this.audioDucking.includeBuiltInSpeakers
  }

  public isParakeetCoreMlReady(): boolean {
    return this.parakeetCoreMlReady
  }

  public async markParakeetCoreMlReady(): Promise<void> {
    if (this.parakeetCoreMlReady) return
    this.parakeetCoreMlReady = true
    await this.saveMain()
  }

  // No `resetParakeetCoreMlReady`: warmup cannot outlive the weights it prepared, so the
  // heal pass clears the flag whenever Parakeet is not installed. Quietly - it is state the
  // user never chose.

  public getStreamMode(): boolean {
    return this.streamMode
  }

  public getStreamTranscriptionMode(): StreamTranscriptionMode {
    return this.streamTranscriptionMode
  }

  public setRecordingIndicatorOnboardingPreview(
    active: boolean,
    mode?: RecordingIndicatorMode
  ): void {
    if (!active) {
      this.recordingIndicatorOnboardingPreviewMode = null
      return
    }
    const resolved =
      mode !== undefined && RECORDING_INDICATOR_MODES.has(mode)
        ? mode
        : this.recordingIndicatorMode
    this.recordingIndicatorOnboardingPreviewMode = resolved
  }

  public getRecordingIndicatorOnboardingPreviewMode(): RecordingIndicatorMode | null {
    return this.recordingIndicatorOnboardingPreviewMode
  }

  public getRecordingIndicatorPosition(): { x: number; y: number } | null {
    return this.recordingIndicatorPosition
  }

  public getDictionaryEntries(): DictionaryEntry[] {
    return this.dictionary.entries.map((entry) => ({ ...entry }))
  }

  private async addDictionaryEntry(
    entry: Omit<DictionaryEntry, 'source'>,
    source: 'manual' | 'auto' = 'manual'
  ): Promise<boolean> {
    const text = entry.text.trim()
    const from = entry.kind === 'replacement' ? entry.from?.trim() : undefined
    if (!text) return false
    if (entry.kind === 'replacement' && !from) return false
    const key = normalizeDictionaryKey(entry.kind, text, from)
    if (
      this.dictionary.entries.some(
        (candidate) =>
          normalizeDictionaryKey(
            candidate.kind,
            candidate.text,
            candidate.from
          ) === key
      )
    ) {
      if (entry.kind === 'replacement') {
        const normalizedFrom = from?.trim().toLowerCase()
        this.dictionary.candidates = this.dictionary.candidates.filter(
          (candidate) =>
            !(
              candidate.from.trim().toLowerCase() === normalizedFrom &&
              candidate.to.trim().toLowerCase() === text.trim().toLowerCase()
            )
        )
        await this.saveDictionary()
      }
      return true
    }
    const nextEntries = [
      ...this.dictionary.entries,
      entry.kind === 'replacement'
        ? { kind: 'replacement' as const, from, text, source }
        : { kind: 'fuzzy' as const, text, source },
    ]
    const nextCandidates =
      entry.kind === 'replacement'
        ? this.dictionary.candidates.filter(
            (candidate) =>
              !(
                candidate.from.trim().toLowerCase() ===
                  from?.trim().toLowerCase() &&
                candidate.to.trim().toLowerCase() === text.trim().toLowerCase()
              )
          )
        : this.dictionary.candidates
    return this.updateDictionarySettings({
      entries: nextEntries,
      candidates: nextCandidates,
    })
  }

  public notifyAppliedEntries(entries: DictionaryEntry[]): void {
    this._recentlyAppliedEntries = entries
  }

  public async acceptPreviouslyAppliedEntries(): Promise<void> {
    if (this._recentlyAppliedEntries.length === 0) return
    let changed = false
    for (const applied of this._recentlyAppliedEntries) {
      if (applied.confidence === undefined) continue
      const idx = this.dictionary.entries.findIndex(
        (e) =>
          e.kind === applied.kind &&
          e.text === applied.text &&
          e.from === applied.from
      )
      if (idx === -1) continue
      const entry = this.dictionary.entries[idx]
      this.dictionary.entries[idx] = {
        ...entry,
        confidence: (entry.confidence ?? 1) + 1,
        timesAccepted: (entry.timesAccepted ?? 0) + 1,
      }
      changed = true
    }
    this._recentlyAppliedEntries = []
    if (changed) await this.saveDictionary()
  }

  private async _decrementEntryConfidence(
    applied: DictionaryEntry
  ): Promise<void> {
    const idx = this.dictionary.entries.findIndex(
      (e) =>
        e.kind === applied.kind &&
        e.text === applied.text &&
        e.from === applied.from
    )
    if (idx === -1) return
    const entry = this.dictionary.entries[idx]
    if (entry.confidence === undefined) return
    const nextConfidence = entry.confidence - 1
    if (nextConfidence <= 0) {
      this.dictionary.entries = this.dictionary.entries.filter(
        (_, i) => i !== idx
      )
    } else {
      this.dictionary.entries[idx] = {
        ...entry,
        confidence: nextConfidence,
        timesReverted: (entry.timesReverted ?? 0) + 1,
      }
    }
    await this.saveDictionary()
  }

  public async stageAutoLearnCorrection(
    original: string,
    corrected: string
  ): Promise<
    'ignored' | 'staged' | 'committed' | 'already-committed' | 'reverted'
  > {
    const revertedEntry = this._recentlyAppliedEntries.find(
      (e) =>
        e.confidence !== undefined &&
        e.text.toLowerCase() === original.toLowerCase() &&
        corrected.toLowerCase() !== original.toLowerCase()
    )
    if (revertedEntry) {
      this._recentlyAppliedEntries = this._recentlyAppliedEntries.filter(
        (e) =>
          !(
            e.kind === revertedEntry.kind &&
            e.text === revertedEntry.text &&
            e.from === revertedEntry.from
          )
      )
      await this._decrementEntryConfidence(revertedEntry)
      return 'reverted'
    }

    const result = stageDictionaryCandidate({
      candidates: this.dictionary.candidates,
      entries: this.dictionary.entries,
      original,
      corrected,
    })

    if (result.outcome === 'ignored') return result.outcome

    if (result.outcome === 'committed' && result.committedEntry) {
      this.dictionary.candidates = result.candidates
      return (await this.addDictionaryEntry(result.committedEntry, 'auto'))
        ? 'committed'
        : 'ignored'
    }

    if (result.outcome === 'staged' || result.outcome === 'already-committed') {
      this.dictionary.candidates = result.candidates
      await this.saveDictionary()
    }

    return result.outcome
  }

  public async invalidateDictionaryCandidatesForText(
    text: string
  ): Promise<DictionaryCandidate[]> {
    const result = getInvalidatedDictionaryCandidatesForText(
      this.dictionary.candidates,
      text
    )
    if (result.removed.length === 0) return []
    this.dictionary.candidates = result.candidates
    await this.saveDictionary()
    return result.removed
  }

  public getDictionaryAutoLearn(): boolean {
    return this.dictionary.autoLearn
  }
}
