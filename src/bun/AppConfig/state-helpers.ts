import type {
  DictionaryEntry,
  FormattingSettings,
  FormattingSettingsPatch,
} from '../../shared/types'
import {
  isValidDocumentStructure,
  isValidDocumentTone,
  isValidEmailClosingStyle,
  isValidEmailGreetingStyle,
  isValidFormattingModeId,
  isValidImessageTone,
  isValidSlackTone,
} from '../../shared/formatting-modes'

export const BUILTIN_DICTIONARY_ENTRIES: readonly DictionaryEntry[] = [
  { kind: 'fuzzy', text: 'Codictate', source: 'manual' },
]

/** Return a detached entry list containing every missing built-in. */
export function withBuiltinDictionaryEntries(
  entries: readonly DictionaryEntry[]
): DictionaryEntry[] {
  const next = entries.map((entry) => ({ ...entry }))
  for (const builtin of BUILTIN_DICTIONARY_ENTRIES) {
    const exists = next.some(
      (entry) =>
        entry.kind === builtin.kind &&
        entry.text.trim().toLowerCase() === builtin.text.toLowerCase()
    )
    if (!exists) next.push({ ...builtin })
  }
  return next
}

/**
 * Validate a formatting patch as a whole and build its result without touching the input.
 * A null result means the caller must leave both its in-memory and persisted state alone.
 */
export function formattingSettingsAfterPatch(
  current: FormattingSettings,
  patch: FormattingSettingsPatch
): FormattingSettings | null {
  if (
    patch.forceModeId !== undefined &&
    patch.forceModeId !== null &&
    !isValidFormattingModeId(patch.forceModeId)
  ) {
    return null
  }
  if (
    patch.formatterModelTier !== undefined &&
    patch.formatterModelTier !== 'fast' &&
    patch.formatterModelTier !== 'quality'
  ) {
    return null
  }
  if (
    patch.email?.greetingStyle !== undefined &&
    !isValidEmailGreetingStyle(patch.email.greetingStyle)
  ) {
    return null
  }
  if (
    patch.email?.closingStyle !== undefined &&
    !isValidEmailClosingStyle(patch.email.closingStyle)
  ) {
    return null
  }
  if (
    patch.imessage?.tone !== undefined &&
    !isValidImessageTone(patch.imessage.tone)
  ) {
    return null
  }
  if (patch.slack?.tone !== undefined && !isValidSlackTone(patch.slack.tone)) {
    return null
  }
  if (
    patch.document?.tone !== undefined &&
    !isValidDocumentTone(patch.document.tone)
  ) {
    return null
  }
  if (
    patch.document?.structure !== undefined &&
    !isValidDocumentStructure(patch.document.structure)
  ) {
    return null
  }

  const next: FormattingSettings = {
    ...current,
    enabledModes: { ...current.enabledModes },
    modelAvailability: { ...current.modelAvailability },
    email: { ...current.email },
    imessage: { ...current.imessage },
    slack: { ...current.slack },
    document: { ...current.document },
  }

  if (patch.enabled !== undefined) next.enabled = patch.enabled
  if (patch.enabledModes !== undefined) {
    next.enabledModes = {
      ...next.enabledModes,
      ...Object.fromEntries(
        Object.entries(patch.enabledModes).filter(
          ([, value]) => typeof value === 'boolean'
        )
      ),
    }
  }
  if (patch.forceModeId !== undefined) next.forceModeId = patch.forceModeId
  if (patch.formatterModelTier !== undefined) {
    next.formatterModelTier = patch.formatterModelTier
  }
  if (patch.email !== undefined) next.email = { ...next.email, ...patch.email }
  if (patch.imessage !== undefined) {
    next.imessage = { ...next.imessage, ...patch.imessage }
  }
  if (patch.slack !== undefined) next.slack = { ...next.slack, ...patch.slack }
  if (patch.document !== undefined) {
    next.document = { ...next.document, ...patch.document }
  }

  return next
}

export interface LegacyMigrationPlan {
  main: boolean
  dictionary: boolean
}

/** Only a missing split file may be populated from the retained legacy file. */
export function legacyMigrationPlan(
  hasMain: boolean,
  hasDictionary: boolean,
  hasLegacy: boolean
): LegacyMigrationPlan {
  return {
    main: hasLegacy && !hasMain,
    dictionary: hasLegacy && !hasDictionary,
  }
}

/**
 * Serialize immutable snapshots in call order. A failed write does not poison later writes.
 */
export class SerializedSnapshotWriter<T> {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly persist: (snapshot: T) => Promise<void>) {}

  write(snapshot: T): Promise<void> {
    const result = this.queue.then(
      () => this.persist(snapshot),
      () => this.persist(snapshot)
    )
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
