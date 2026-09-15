import { describe, expect, test } from 'bun:test'
import type { FormattingSettings } from '../../shared/types'
import {
  SerializedSnapshotWriter,
  formattingSettingsAfterPatch,
  legacyMigrationPlan,
  withBuiltinDictionaryEntries,
} from './state-helpers'

function formattingSettings(): FormattingSettings {
  return {
    enabled: false,
    enabledModes: {
      email: false,
      imessage: false,
      slack: false,
      document: false,
    },
    forceModeId: null,
    formatterModelTier: 'fast',
    available: true,
    modelAvailability: { fast: true, quality: false },
    email: {
      includeSenderName: false,
      greetingStyle: 'auto',
      closingStyle: 'auto',
      customGreeting: '',
      customClosing: '',
    },
    imessage: { tone: 'neutral', allowEmoji: false, lightweight: false },
    slack: {
      tone: 'professional',
      allowEmoji: false,
      useMarkdown: true,
      lightweight: false,
    },
    document: { tone: 'neutral', structure: 'prose', lightweight: false },
  }
}

describe('formattingSettingsAfterPatch', () => {
  test('an invalid mixed patch changes no part of the current settings', () => {
    const current = formattingSettings()
    const before = structuredClone(current)

    const result = formattingSettingsAfterPatch(current, {
      enabled: true,
      forceModeId: 'not-a-mode' as never,
    })

    expect(result).toBeNull()
    expect(current).toEqual(before)
  })

  test('a valid patch returns a detached complete next value', () => {
    const current = formattingSettings()
    const result = formattingSettingsAfterPatch(current, {
      enabled: true,
      enabledModes: { email: true },
      email: { customGreeting: 'Hello' },
    })

    expect(result?.enabled).toBe(true)
    expect(result?.enabledModes.email).toBe(true)
    expect(result?.email.customGreeting).toBe('Hello')
    expect(current.enabled).toBe(false)
    expect(current.enabledModes.email).toBe(false)
    expect(current.email.customGreeting).toBe('')
  })
})

describe('SerializedSnapshotWriter', () => {
  test('persists concurrent snapshots in call order, leaving the latest value', async () => {
    const started: number[] = []
    let persisted = 0
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const writer = new SerializedSnapshotWriter<number>(async (snapshot) => {
      started.push(snapshot)
      if (snapshot === 1) await firstBlocked
      persisted = snapshot
    })

    const first = writer.write(1)
    const second = writer.write(2)
    await Promise.resolve()

    expect(started).toEqual([1])
    releaseFirst()
    await Promise.all([first, second])
    expect(started).toEqual([1, 2])
    expect(persisted).toBe(2)
  })

  test('a failed snapshot does not prevent the next one from persisting', async () => {
    const persisted: number[] = []
    const writer = new SerializedSnapshotWriter<number>(async (snapshot) => {
      if (snapshot === 1) throw new Error('write failed')
      persisted.push(snapshot)
    })

    const failed = writer.write(1)
    const recovered = writer.write(2)
    expect(
      await failed.then(
        () => false,
        () => true
      )
    ).toBe(true)
    await recovered
    expect(persisted).toEqual([2])
  })
})

describe('withBuiltinDictionaryEntries', () => {
  test('restores Codictate after a dictionary write removes it', () => {
    expect(
      withBuiltinDictionaryEntries([
        { kind: 'fuzzy', text: 'Electrobun', source: 'manual' },
      ])
    ).toEqual([
      { kind: 'fuzzy', text: 'Electrobun', source: 'manual' },
      { kind: 'fuzzy', text: 'Codictate', source: 'manual' },
    ])
  })

  test('keeps one case-insensitive copy of the built-in', () => {
    const entries = withBuiltinDictionaryEntries([
      { kind: 'fuzzy', text: 'codictate', source: 'manual' },
    ])
    expect(entries).toHaveLength(1)
  })
})

describe('legacyMigrationPlan', () => {
  test('a missing dictionary cannot reapply legacy main settings', () => {
    expect(legacyMigrationPlan(true, false, true)).toEqual({
      main: false,
      dictionary: true,
    })
  })

  test('a missing main config cannot replace the current dictionary', () => {
    expect(legacyMigrationPlan(false, true, true)).toEqual({
      main: true,
      dictionary: false,
    })
  })

  test('both missing files migrate, and no legacy file means no migration', () => {
    expect(legacyMigrationPlan(false, false, true)).toEqual({
      main: true,
      dictionary: true,
    })
    expect(legacyMigrationPlan(false, false, false)).toEqual({
      main: false,
      dictionary: false,
    })
  })
})
