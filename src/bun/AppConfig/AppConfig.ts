import { mkdirSync } from 'fs'
import {
  DEFAULT_MAX_RECORDING_DURATION_SECONDS,
  isValidMaxRecordingDurationSeconds,
  type RecordingDurationPresetSeconds,
} from '../../shared/recording-duration-presets'
import { SHORTCUT_OPTIONS } from '../../shared/shortcut-options'
import {
  isValidTranscriptionLanguageId,
  whisperCodeForTranscriptionId,
} from '../../shared/transcription-languages'
import type {
  AppSettings,
  AudioDeviceDetails,
  AudioDuckingSettings,
  AudioDuckingSettingsPatch,
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
  ShortcutId,
  StreamTranscriptionMode,
  TranscriptionSettingsPatch,
} from '../../shared/types'
import {
  DEFAULT_MODEL_ID,
  getStreamModeReadiness,
  isValidWhisperModelId,
} from '../../shared/whisper-models'
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
import { modelManager } from '../utils/whisper/model-manager'
import {
  detectFormattingAvailable,
  isFormatterModelInstalled,
} from '../utils/formatting/formatting-availability'
import { disableDebug, enableDebug, log } from '../utils/logger'
import {
  invalidateDictionaryCandidatesForText as getInvalidatedDictionaryCandidatesForText,
  parseDictionaryCandidates,
  stageDictionaryCandidate,
} from '../utils/dictionary/auto-learn-candidates'
import {
  APP_DATA_DIR,
  DEFAULT_HISTORY_DIR,
  DICTIONARY_CONFIG_PATH,
  LEGACY_CONFIG_PATH,
  MAIN_CONFIG_PATH,
  getPlatformCapabilities,
} from '../platform/runtime'

const CONFIG_DIR = APP_DATA_DIR

const VALID_SHORTCUT_IDS = new Set<ShortcutId>(
  SHORTCUT_OPTIONS.map((o) => o.id)
)

function isValidShortcutId(id: unknown): id is ShortcutId {
  return typeof id === 'string' && VALID_SHORTCUT_IDS.has(id as ShortcutId)
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
    entries: [],
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
  transcriptionLanguageId: string
  maxRecordingDuration: RecordingDurationPresetSeconds
  whisperModelId: string
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
  debugMode: false
}

export class AppConfig {
  private audioDeviceName: string | null
  private audioDeviceId: string | null
  private audioDevice: number
  private shortcutId: ShortcutId
  private shortcutHoldOnlyId: ShortcutId | null
  private debugMode: boolean
  private funModeEnabled: boolean
  private transcriptionLanguageId: string
  private maxRecordingDuration: RecordingDurationPresetSeconds
  private whisperModelId: string
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
  private _recentlyAppliedEntries: DictionaryEntry[] = []
  private recordingIndicatorOnboardingPreviewMode: RecordingIndicatorMode | null =
    null

  constructor() {
    this.audioDeviceName = null
    this.audioDeviceId = null
    this.audioDevice = 0
    this.shortcutId = 'option-space'
    this.shortcutHoldOnlyId = null
    this.debugMode = false
    this.funModeEnabled = false
    this.transcriptionLanguageId = 'auto'
    this.maxRecordingDuration = DEFAULT_MAX_RECORDING_DURATION_SECONDS
    this.whisperModelId = DEFAULT_MODEL_ID
    this.translateToEnglish = false
    this.translateDefaultLanguageId = 'auto'
    this.onboardingCompleted = false
    this.recordingIndicatorMode = 'always'
    this.recordingIndicatorPosition = null
    this.streamMode = false
    this.parakeetCoreMlReady = false
    this.streamTranscriptionMode = 'vad'
    this.userDisplayName = ''
    this.formatting = defaultFormattingSettings(detectFormattingAvailable(), {
      fast: isFormatterModelInstalled('fast'),
      quality: isFormatterModelInstalled('quality'),
    })
    this.audioDucking = defaultAudioDuckingSettings()
    this.dictionary = defaultDictionarySettings()
    this.historyEnabled = false
    this.historyStoragePath = ''
    this.historyMaxEntries = 250
    this.historySaveAudio = false
  }

  private getPersistedMainSettings(): PersistedMainSettings {
    return {
      audioDeviceName: this.audioDeviceName,
      audioDeviceId: this.audioDeviceId,
      audioDevice: this.audioDevice,
      shortcutId: this.shortcutId,
      shortcutHoldOnlyId: this.shortcutHoldOnlyId,
      funModeEnabled: this.funModeEnabled,
      transcriptionLanguageId: this.transcriptionLanguageId,
      maxRecordingDuration: this.maxRecordingDuration,
      whisperModelId: this.whisperModelId,
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
      debugMode: false,
    }
  }

  private async saveMain(): Promise<void> {
    mkdirSync(CONFIG_DIR, { recursive: true })
    await Bun.write(
      MAIN_CONFIG_PATH,
      JSON.stringify(this.getPersistedMainSettings(), null, 2)
    )
  }

  private async saveDictionary(): Promise<void> {
    mkdirSync(CONFIG_DIR, { recursive: true })
    await Bun.write(
      DICTIONARY_CONFIG_PATH,
      JSON.stringify(
        {
          entries: this.dictionary.entries,
          autoLearn: this.dictionary.autoLearn,
          candidates: this.dictionary.candidates,
        },
        null,
        2
      )
    )
  }

  private async saveAll(): Promise<void> {
    await Promise.all([this.saveMain(), this.saveDictionary()])
  }

  private applyPersistedMain(raw: Record<string, unknown>): void {
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
    if (isValidShortcutId(raw.shortcutId)) this.shortcutId = raw.shortcutId
    if (
      raw.shortcutHoldOnlyId !== undefined &&
      raw.shortcutHoldOnlyId !== null &&
      isValidShortcutId(raw.shortcutHoldOnlyId)
    ) {
      this.shortcutHoldOnlyId = raw.shortcutHoldOnlyId
    } else if (raw.shortcutHoldOnlyId === null) {
      this.shortcutHoldOnlyId = null
    }
    if (typeof raw.funModeEnabled === 'boolean') {
      this.funModeEnabled = raw.funModeEnabled
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
    if (
      typeof raw.whisperModelId === 'string' &&
      isValidWhisperModelId(raw.whisperModelId)
    ) {
      this.whisperModelId = raw.whisperModelId
    }
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
      this.parakeetCoreMlReady = modelManager.isModelAvailable(
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
  }

  private applyLegacySettings(raw: Record<string, unknown>): void {
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
    if (Array.isArray(raw.dictionaryEntries)) {
      this.dictionary.entries = this.parseDictionaryEntries(
        raw.dictionaryEntries
      )
    }
    if (typeof raw.dictionaryAutoLearn === 'boolean') {
      this.dictionary.autoLearn = raw.dictionaryAutoLearn
    }
  }

  public async load() {
    try {
      const [hasMain, hasDictionary, hasLegacy] = await Promise.all([
        Bun.file(MAIN_CONFIG_PATH).exists(),
        Bun.file(DICTIONARY_CONFIG_PATH).exists(),
        Bun.file(LEGACY_CONFIG_PATH).exists(),
      ])

      let migrated = false

      if (hasMain) {
        const raw = (await Bun.file(MAIN_CONFIG_PATH).json()) as Record<
          string,
          unknown
        >
        this.applyPersistedMain(raw)
      }
      if (hasDictionary) {
        const raw = (await Bun.file(DICTIONARY_CONFIG_PATH).json()) as Record<
          string,
          unknown
        >
        this.applyDictionarySettings(raw)
      }

      if (hasLegacy && (!hasMain || !hasDictionary)) {
        const raw = (await Bun.file(LEGACY_CONFIG_PATH).json()) as Record<
          string,
          unknown
        >
        this.applyLegacySettings(raw)
        migrated = true
      }

      if (!hasMain && !hasDictionary && !hasLegacy) {
        log('config', 'using default app config', {
          shortcutId: this.shortcutId,
          streamMode: this.streamMode,
          streamTranscriptionMode: this.streamTranscriptionMode,
        })
        return
      }

      if (migrated) {
        await this.saveAll()
      }

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
      capabilities: getPlatformCapabilities(),
      shortcutId: this.shortcutId,
      shortcutHoldOnlyId: this.shortcutHoldOnlyId,
      maxRecordingDuration: this.maxRecordingDuration,
      debugMode: this.debugMode,
      funModeEnabled: this.funModeEnabled,
      transcriptionLanguageId: this.transcriptionLanguageId,
      whisperModelId: this.whisperModelId,
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
        storagePath: this.historyStoragePath || DEFAULT_HISTORY_DIR,
        maxEntries: this.historyMaxEntries,
        saveAudio: this.historySaveAudio,
      },
      modelAvailability: modelManager.getAvailabilityMap(),
    }
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
      fast: isFormatterModelInstalled('fast'),
      quality: isFormatterModelInstalled('quality'),
    }
  }

  public async updateGeneralSettings(
    patch: GeneralSettingsPatch
  ): Promise<boolean> {
    if (
      patch.shortcutId !== undefined &&
      !VALID_SHORTCUT_IDS.has(patch.shortcutId)
    ) {
      return false
    }
    if (patch.shortcutHoldOnlyId !== undefined) {
      if (
        patch.shortcutHoldOnlyId !== null &&
        !VALID_SHORTCUT_IDS.has(patch.shortcutHoldOnlyId)
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
    await this.saveMain()
    return true
  }

  public async updateTranscriptionSettings(
    patch: TranscriptionSettingsPatch
  ): Promise<boolean> {
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
      patch.whisperModelId !== undefined &&
      !isValidWhisperModelId(patch.whisperModelId)
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

    if (patch.transcriptionLanguageId !== undefined) {
      this.transcriptionLanguageId = patch.transcriptionLanguageId
    }
    if (patch.maxRecordingDuration !== undefined) {
      this.maxRecordingDuration = patch.maxRecordingDuration
    }
    if (patch.whisperModelId !== undefined) {
      this.whisperModelId = patch.whisperModelId
    }
    if (patch.translateDefaultLanguageId !== undefined) {
      this.translateDefaultLanguageId = patch.translateDefaultLanguageId
    }
    if (patch.translateToEnglish !== undefined) {
      this.translateToEnglish = patch.translateToEnglish
    }
    if (patch.streamTranscriptionMode !== undefined) {
      this.streamTranscriptionMode = patch.streamTranscriptionMode
    }
    if (patch.streamMode !== undefined) {
      if (patch.streamMode) {
        const readiness = getStreamModeReadiness(
          this.whisperModelId,
          this.transcriptionLanguageId,
          (id) => modelManager.isModelAvailable(id),
          this.parakeetCoreMlReady
        )
        if (readiness.kind !== 'ready') {
          log('config', 'stream mode blocked', {
            reason: readiness.kind,
            whisperModelId: this.whisperModelId,
            transcriptionLanguageId: this.transcriptionLanguageId,
          })
          return false
        }
      }
      this.streamMode = patch.streamMode
    }

    await this.saveMain()
    return true
  }

  public async updateFormattingSettings(
    patch: FormattingSettingsPatch
  ): Promise<boolean> {
    if (patch.enabled !== undefined) this.formatting.enabled = patch.enabled
    if (patch.enabledModes !== undefined) {
      this.formatting.enabledModes = {
        ...this.formatting.enabledModes,
        ...Object.fromEntries(
          Object.entries(patch.enabledModes).filter(
            ([, value]) => typeof value === 'boolean'
          )
        ),
      }
    }
    if (patch.forceModeId !== undefined) {
      if (
        patch.forceModeId !== null &&
        !isValidFormattingModeId(patch.forceModeId)
      ) {
        return false
      }
      this.formatting.forceModeId = patch.forceModeId
    }
    if (patch.formatterModelTier !== undefined) {
      const validTiers: FormatterModelTier[] = ['fast', 'quality']
      if (!validTiers.includes(patch.formatterModelTier)) return false
      this.formatting.formatterModelTier = patch.formatterModelTier
      this.refreshFormatterModelInstalled()
    }
    if (patch.email !== undefined) {
      if (
        patch.email.greetingStyle !== undefined &&
        !isValidEmailGreetingStyle(patch.email.greetingStyle)
      ) {
        return false
      }
      if (
        patch.email.closingStyle !== undefined &&
        !isValidEmailClosingStyle(patch.email.closingStyle)
      ) {
        return false
      }
      this.formatting.email = {
        ...this.formatting.email,
        ...patch.email,
      }
    }
    if (patch.imessage !== undefined) {
      if (
        patch.imessage.tone !== undefined &&
        !isValidImessageTone(patch.imessage.tone)
      ) {
        return false
      }
      this.formatting.imessage = {
        ...this.formatting.imessage,
        ...patch.imessage,
      }
    }
    if (patch.slack !== undefined) {
      if (
        patch.slack.tone !== undefined &&
        !isValidSlackTone(patch.slack.tone)
      ) {
        return false
      }
      this.formatting.slack = {
        ...this.formatting.slack,
        ...patch.slack,
      }
    }
    if (patch.document !== undefined) {
      if (
        patch.document.tone !== undefined &&
        !isValidDocumentTone(patch.document.tone)
      ) {
        return false
      }
      if (
        patch.document.structure !== undefined &&
        !isValidDocumentStructure(patch.document.structure)
      ) {
        return false
      }
      this.formatting.document = {
        ...this.formatting.document,
        ...patch.document,
      }
    }
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
    return this.historyStoragePath || DEFAULT_HISTORY_DIR
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

  public getAudioDevice() {
    return this.audioDevice
  }

  public async setShortcutId(id: ShortcutId): Promise<boolean> {
    return this.updateGeneralSettings({ shortcutId: id })
  }

  public async setShortcutHoldOnlyId(id: ShortcutId | null): Promise<boolean> {
    return this.updateGeneralSettings({ shortcutHoldOnlyId: id })
  }

  public async setTranscriptionLanguageId(id: string): Promise<boolean> {
    return this.updateTranscriptionSettings({ transcriptionLanguageId: id })
  }

  public getTranscriptionLanguageId(): string {
    return this.transcriptionLanguageId
  }

  public getTranscriptionWhisperCode(): string | null {
    return whisperCodeForTranscriptionId(this.transcriptionLanguageId)
  }

  public getRuntimeTranscriptionWhisperCode(): string | null {
    if (!this.translateToEnglish) {
      return this.getTranscriptionWhisperCode()
    }

    const sourceLanguageId =
      this.transcriptionLanguageId !== 'auto'
        ? this.transcriptionLanguageId
        : this.translateDefaultLanguageId

    return whisperCodeForTranscriptionId(sourceLanguageId)
  }

  public getShortcutId(): ShortcutId {
    return this.shortcutId
  }

  public getShortcutHoldOnlyId(): ShortcutId | null {
    return this.shortcutHoldOnlyId
  }

  public async setDebugMode(enabled: boolean) {
    await this.updateGeneralSettings({ debugMode: enabled })
  }

  public getDebugMode(): boolean {
    return this.debugMode
  }

  public getFunModeEnabled(): boolean {
    return this.funModeEnabled
  }

  public async setFunModeEnabled(enabled: boolean): Promise<boolean> {
    return this.updateGeneralSettings({ funModeEnabled: enabled })
  }

  public getMaxRecordingDurationSeconds(): number {
    return this.maxRecordingDuration
  }

  public async setMaxRecordingDurationSeconds(
    seconds: number
  ): Promise<boolean> {
    return this.updateTranscriptionSettings({ maxRecordingDuration: seconds })
  }

  public getWhisperModelId(): string {
    return this.whisperModelId
  }

  public async setWhisperModelId(id: string): Promise<boolean> {
    return this.updateTranscriptionSettings({ whisperModelId: id })
  }

  public getTranslateToEnglish(): boolean {
    return this.translateToEnglish
  }

  public async setTranslateToEnglish(enabled: boolean): Promise<void> {
    await this.updateTranscriptionSettings({ translateToEnglish: enabled })
  }

  public async setTranslateOn(sourceLanguageId: string): Promise<boolean> {
    if (
      !isValidTranscriptionLanguageId(sourceLanguageId) ||
      sourceLanguageId === 'auto'
    ) {
      return false
    }
    this.transcriptionLanguageId = sourceLanguageId
    this.translateToEnglish = true
    await this.saveMain()
    return true
  }

  public async setTranslateOff(): Promise<void> {
    this.translateToEnglish = false
    this.transcriptionLanguageId = 'auto'
    await this.saveMain()
  }

  public getTranslateDefaultLanguageId(): string {
    return this.translateDefaultLanguageId
  }

  public async setTranslateDefaultLanguageId(id: string): Promise<boolean> {
    return this.updateTranscriptionSettings({ translateDefaultLanguageId: id })
  }

  public getUserDisplayName(): string {
    return this.userDisplayName
  }

  public async setUserDisplayName(userDisplayName: string): Promise<boolean> {
    return this.updateGeneralSettings({ userDisplayName })
  }

  public getFormattingEnabled(): boolean {
    return this.formatting.enabled
  }

  public async setFormattingEnabled(enabled: boolean): Promise<boolean> {
    return this.updateFormattingSettings({ enabled })
  }

  public getFormattingEnabledModes(): FormattingSettings['enabledModes'] {
    return { ...this.formatting.enabledModes }
  }

  public async setFormattingModeEnabled(
    modeId: FormattingModeId,
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({
      enabledModes: { [modeId]: enabled },
    })
  }

  public getFormattingForceModeId(): FormattingModeId | null {
    return this.formatting.forceModeId
  }

  public async setFormattingForceModeId(
    modeId: FormattingModeId | null
  ): Promise<boolean> {
    return this.updateFormattingSettings({ forceModeId: modeId })
  }

  public getFormattingEmailIncludeSenderName(): boolean {
    return this.formatting.email.includeSenderName
  }

  public async setFormattingEmailIncludeSenderName(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({
      email: { includeSenderName: enabled },
    })
  }

  public getFormattingEmailGreetingStyle() {
    return this.formatting.email.greetingStyle
  }

  public async setFormattingEmailGreetingStyle(
    style: FormattingSettings['email']['greetingStyle']
  ): Promise<boolean> {
    return this.updateFormattingSettings({ email: { greetingStyle: style } })
  }

  public getFormattingEmailClosingStyle() {
    return this.formatting.email.closingStyle
  }

  public async setFormattingEmailClosingStyle(
    style: FormattingSettings['email']['closingStyle']
  ): Promise<boolean> {
    return this.updateFormattingSettings({ email: { closingStyle: style } })
  }

  public getFormattingEmailCustomGreeting(): string {
    return this.formatting.email.customGreeting
  }

  public async setFormattingEmailCustomGreeting(
    text: string
  ): Promise<boolean> {
    return this.updateFormattingSettings({ email: { customGreeting: text } })
  }

  public getFormattingEmailCustomClosing(): string {
    return this.formatting.email.customClosing
  }

  public async setFormattingEmailCustomClosing(text: string): Promise<boolean> {
    return this.updateFormattingSettings({ email: { customClosing: text } })
  }

  public async setFormattingImessageTone(
    tone: FormattingSettings['imessage']['tone']
  ): Promise<boolean> {
    return this.updateFormattingSettings({ imessage: { tone } })
  }

  public async setFormattingImessageAllowEmoji(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({ imessage: { allowEmoji: enabled } })
  }

  public async setFormattingImessageLightweight(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({
      imessage: { lightweight: enabled },
    })
  }

  public async setFormattingSlackTone(
    tone: FormattingSettings['slack']['tone']
  ): Promise<boolean> {
    return this.updateFormattingSettings({ slack: { tone } })
  }

  public async setFormattingSlackAllowEmoji(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({ slack: { allowEmoji: enabled } })
  }

  public async setFormattingSlackUseMarkdown(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({ slack: { useMarkdown: enabled } })
  }

  public async setFormattingSlackLightweight(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({ slack: { lightweight: enabled } })
  }

  public async setFormattingDocumentTone(
    tone: FormattingSettings['document']['tone']
  ): Promise<boolean> {
    return this.updateFormattingSettings({ document: { tone } })
  }

  public async setFormattingDocumentStructure(
    structure: FormattingSettings['document']['structure']
  ): Promise<boolean> {
    return this.updateFormattingSettings({ document: { structure } })
  }

  public async setFormattingDocumentLightweight(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateFormattingSettings({
      document: { lightweight: enabled },
    })
  }

  public getAudioDuckingLevel(): number {
    return this.audioDucking.level
  }

  public async setAudioDuckingLevel(level: number): Promise<boolean> {
    return this.updateAudioDuckingSettings({ level })
  }

  public getAudioDuckingIncludeHeadphones(): boolean {
    return this.audioDucking.includeHeadphones
  }

  public async setAudioDuckingIncludeHeadphones(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateAudioDuckingSettings({ includeHeadphones: enabled })
  }

  public getAudioDuckingIncludeBuiltInSpeakers(): boolean {
    return this.audioDucking.includeBuiltInSpeakers
  }

  public async setAudioDuckingIncludeBuiltInSpeakers(
    enabled: boolean
  ): Promise<boolean> {
    return this.updateAudioDuckingSettings({ includeBuiltInSpeakers: enabled })
  }

  public getFormattingAvailable(): boolean {
    return this.formatting.available
  }

  public isParakeetCoreMlReady(): boolean {
    return this.parakeetCoreMlReady
  }

  public async markParakeetCoreMlReady(): Promise<void> {
    if (this.parakeetCoreMlReady) return
    this.parakeetCoreMlReady = true
    await this.saveMain()
  }

  public async resetParakeetCoreMlReady(): Promise<void> {
    if (!this.parakeetCoreMlReady) return
    this.parakeetCoreMlReady = false
    await this.saveMain()
  }

  public getStreamMode(): boolean {
    return this.streamMode
  }

  public async setStreamMode(enabled: boolean): Promise<boolean> {
    log('config', 'set stream mode', {
      previous: this.streamMode,
      next: enabled,
    })
    return this.updateTranscriptionSettings({ streamMode: enabled })
  }

  public getStreamTranscriptionMode(): StreamTranscriptionMode {
    return this.streamTranscriptionMode
  }

  public async setStreamTranscriptionMode(
    mode: StreamTranscriptionMode
  ): Promise<void> {
    await this.updateTranscriptionSettings({ streamTranscriptionMode: mode })
  }

  public async setOnboardingCompleted(completed: boolean): Promise<void> {
    await this.updateGeneralSettings({ onboardingCompleted: completed })
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

  public getRecordingIndicatorMode(): RecordingIndicatorMode {
    return this.recordingIndicatorMode
  }

  public async setRecordingIndicatorMode(
    mode: RecordingIndicatorMode
  ): Promise<boolean> {
    return this.updateGeneralSettings({ recordingIndicatorMode: mode })
  }

  public getRecordingIndicatorPosition(): { x: number; y: number } | null {
    return this.recordingIndicatorPosition
  }

  public async setRecordingIndicatorPosition(
    x: number,
    y: number
  ): Promise<void> {
    await this.updateGeneralSettings({ recordingIndicatorPosition: { x, y } })
  }

  public getDictionaryEntries(): DictionaryEntry[] {
    return this.dictionary.entries.map((entry) => ({ ...entry }))
  }

  public getDictionaryCandidates(): DictionaryCandidate[] {
    return this.dictionary.candidates.map((candidate) => ({ ...candidate }))
  }

  public getDictionaryWords(): string[] {
    return this.dictionary.entries.map((entry) => entry.text)
  }

  public async addDictionaryEntry(
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

  public async removeDictionaryEntry(
    entry: Pick<DictionaryEntry, 'kind' | 'text' | 'from'>
  ): Promise<boolean> {
    const key = normalizeDictionaryKey(
      entry.kind,
      entry.text,
      entry.kind === 'replacement' ? entry.from : undefined
    )
    const nextEntries = this.dictionary.entries.filter(
      (candidate) =>
        normalizeDictionaryKey(
          candidate.kind,
          candidate.text,
          candidate.from
        ) !== key
    )
    if (nextEntries.length === this.dictionary.entries.length) return false
    return this.updateDictionarySettings({ entries: nextEntries })
  }

  public async removeDictionaryCandidate(
    candidate: Pick<DictionaryCandidate, 'from' | 'to'>
  ): Promise<boolean> {
    const from = candidate.from.trim().toLowerCase()
    const to = candidate.to.trim().toLowerCase()
    const nextCandidates = this.dictionary.candidates.filter(
      (entry) =>
        !(
          entry.from.trim().toLowerCase() === from &&
          entry.to.trim().toLowerCase() === to
        )
    )
    if (nextCandidates.length === this.dictionary.candidates.length) {
      return false
    }
    return this.updateDictionarySettings({ candidates: nextCandidates })
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

  public async setDictionaryAutoLearn(enabled: boolean): Promise<boolean> {
    return this.updateDictionarySettings({ autoLearn: enabled })
  }
}
