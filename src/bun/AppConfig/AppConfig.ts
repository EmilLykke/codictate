import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { ShortcutId, AppSettings } from '../../shared/types'
import {
  isValidTranscriptionLanguageId,
  whisperCodeForTranscriptionId,
} from '../../shared/transcription-languages'
import {
  DEFAULT_MAX_RECORDING_DURATION_SECONDS,
  isValidMaxRecordingDurationSeconds,
  type RecordingDurationPresetSeconds,
} from '../../shared/recording-duration-presets'
import {
  DEFAULT_MODEL_ID,
  isValidWhisperModelId,
} from '../../shared/whisper-models'
import { enableDebug, disableDebug } from '../utils/logger'

const CONFIG_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'codictate'
)
const CONFIG_PATH = join(CONFIG_DIR, 'app-config.json')

export class AppConfig {
  // Name is the primary key — stable across device list reorders.
  // Index is stored as a fallback for configs that predate name storage.
  private audioDeviceName: string | null
  private audioDevice: number
  private shortcutId: ShortcutId
  // debugMode is never persisted as true — always written as false on disk
  // so logging never silently resumes after a restart.
  private debugMode: boolean
  private transcriptionLanguageId: string
  private maxRecordingDuration: RecordingDurationPresetSeconds
  private whisperModelId: string
  private translateToEnglish: boolean
  private translateDefaultLanguageId: string | null
  private hasCompletedOnboarding: boolean

  constructor() {
    this.audioDeviceName = null
    this.audioDevice = 0
    this.shortcutId = 'option-space'
    this.debugMode = false
    this.transcriptionLanguageId = 'auto'
    this.maxRecordingDuration = DEFAULT_MAX_RECORDING_DURATION_SECONDS
    this.whisperModelId = DEFAULT_MODEL_ID
    this.translateToEnglish = false
    this.translateDefaultLanguageId = null
    this.hasCompletedOnboarding = false
  }

  // --- Persistence ---

  public async load() {
    try {
      const file = Bun.file(CONFIG_PATH)
      const raw = await file.json()
      if (raw.audioDeviceName !== undefined)
        this.audioDeviceName = raw.audioDeviceName
      if (raw.audioDevice !== undefined) this.audioDevice = raw.audioDevice
      if (raw.shortcutId !== undefined) this.shortcutId = raw.shortcutId
      if (
        raw.transcriptionLanguageId !== undefined &&
        isValidTranscriptionLanguageId(raw.transcriptionLanguageId)
      ) {
        this.transcriptionLanguageId = raw.transcriptionLanguageId
      }
      if (
        raw.maxRecordingDuration !== undefined &&
        isValidMaxRecordingDurationSeconds(raw.maxRecordingDuration)
      ) {
        this.maxRecordingDuration = raw.maxRecordingDuration
      }
      if (
        raw.whisperModelId !== undefined &&
        isValidWhisperModelId(raw.whisperModelId)
      ) {
        this.whisperModelId = raw.whisperModelId
      }
      if (raw.translateToEnglish !== undefined) {
        this.translateToEnglish = Boolean(raw.translateToEnglish)
      }
      if (
        raw.translateDefaultLanguageId !== undefined &&
        raw.translateDefaultLanguageId !== null &&
        isValidTranscriptionLanguageId(raw.translateDefaultLanguageId) &&
        raw.translateDefaultLanguageId !== 'auto'
      ) {
        this.translateDefaultLanguageId = raw.translateDefaultLanguageId
      }
      if (raw.hasCompletedOnboarding) {
        this.hasCompletedOnboarding = true
      }
    } catch {
      // No config file yet, defaults will be used
    }
  }

  public async save() {
    mkdirSync(CONFIG_DIR, { recursive: true })
    await Bun.write(CONFIG_PATH, JSON.stringify(this.get(), null, 2))
  }

  // --- Schema ---

  public get() {
    return {
      audioDeviceName: this.audioDeviceName,
      audioDevice: this.audioDevice,
      shortcutId: this.shortcutId,
      transcriptionLanguageId: this.transcriptionLanguageId,
      maxRecordingDuration: this.maxRecordingDuration,
      whisperModelId: this.whisperModelId,
      translateToEnglish: this.translateToEnglish,
      translateDefaultLanguageId: this.translateDefaultLanguageId,
      // Always write false — debug mode must never silently resume after restart
      debugMode: false,
      hasCompletedOnboarding: this.hasCompletedOnboarding,
    }
  }

  // --- Getters / Setters ---

  /**
   * Saves both the device index and its name.
   * The name is the primary key used by resolveAudioDevice().
   */
  public async setAudioDevice(index: number, name?: string) {
    this.audioDevice = index
    if (name !== undefined) this.audioDeviceName = name
    await this.save()
  }

  /**
   * Returns the current device index by looking up the stored name
   * in the live device list. Falls back to the stored index if the
   * name is not found (e.g. device was removed or not yet present).
   */
  public resolveAudioDevice(devices: Record<string, string>): number {
    if (this.audioDeviceName !== null) {
      const entry = Object.entries(devices).find(
        ([, name]) => name === this.audioDeviceName
      )
      if (entry) return Number(entry[0])
    }
    return this.audioDevice
  }

  /** @deprecated Use resolveAudioDevice(devices) instead. */
  public getAudioDevice() {
    return this.audioDevice
  }

  public async setShortcutId(id: ShortcutId) {
    this.shortcutId = id
    await this.save()
  }

  public async setTranscriptionLanguageId(id: string): Promise<boolean> {
    if (!isValidTranscriptionLanguageId(id)) return false
    this.transcriptionLanguageId = id
    await this.save()
    return true
  }

  public getTranscriptionLanguageId(): string {
    return this.transcriptionLanguageId
  }

  /** Whisper `--language` value, or `null` when using auto-detect. */
  public getTranscriptionWhisperCode(): string | null {
    return whisperCodeForTranscriptionId(this.transcriptionLanguageId)
  }

  public getShortcutId(): ShortcutId {
    return this.shortcutId
  }

  public async setDebugMode(enabled: boolean) {
    this.debugMode = enabled
    if (enabled) {
      enableDebug()
    } else {
      disableDebug()
    }
    await this.save()
  }

  public getDebugMode(): boolean {
    return this.debugMode
  }

  public getMaxRecordingDurationSeconds(): number {
    return this.maxRecordingDuration
  }

  public async setMaxRecordingDurationSeconds(
    seconds: number
  ): Promise<boolean> {
    if (!isValidMaxRecordingDurationSeconds(seconds)) return false
    this.maxRecordingDuration = seconds
    await this.save()
    return true
  }

  public getWhisperModelId(): string {
    return this.whisperModelId
  }

  public async setWhisperModelId(id: string): Promise<boolean> {
    if (!isValidWhisperModelId(id)) return false
    this.whisperModelId = id
    await this.save()
    return true
  }

  public getTranslateToEnglish(): boolean {
    return this.translateToEnglish
  }

  public async setTranslateToEnglish(enabled: boolean): Promise<void> {
    this.translateToEnglish = enabled
    await this.save()
  }

  /**
   * Atomically disables translate mode and resets the transcription language to
   * auto-detect in a single save — prevents the window where disk has
   * { translateToEnglish: false, transcriptionLanguageId: "da" }.
   */
  public async setTranslateOff(): Promise<void> {
    this.translateToEnglish = false
    this.transcriptionLanguageId = 'auto'
    await this.save()
  }

  public getTranslateDefaultLanguageId(): string | null {
    return this.translateDefaultLanguageId
  }

  public async setTranslateDefaultLanguageId(
    id: string | null
  ): Promise<boolean> {
    if (id !== null && (!isValidTranscriptionLanguageId(id) || id === 'auto')) {
      return false
    }
    this.translateDefaultLanguageId = id
    await this.save()
    return true
  }

  public getHasCompletedOnboarding(): boolean {
    return this.hasCompletedOnboarding
  }

  public async setHasCompletedOnboarding(): Promise<void> {
    this.hasCompletedOnboarding = true
    await this.save()
  }

  public getSettings(): AppSettings {
    return {
      shortcutId: this.shortcutId,
      maxRecordingDuration: this.maxRecordingDuration,
      debugMode: this.debugMode,
      transcriptionLanguageId: this.transcriptionLanguageId,
      whisperModelId: this.whisperModelId,
      translateToEnglish: this.translateToEnglish,
      translateDefaultLanguageId: this.translateDefaultLanguageId,
    }
  }
}
