/**
 * The Speech Model selection surviving the `whisperModelId` -> `speechModelId` rename.
 *
 * Worth its own test because the failure is silent: a config written by an older build whose
 * key is not read leaves the field at its constructor default, and the user's Speech Model
 * changes with no announcement. Every installed copy of the app has a config with the legacy
 * key and none with the current one, so the fallback below is the only path that runs on the
 * first launch after the rename.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
} from '../../shared/speech-models'
import { persistedSpeechModelId } from './persisted-speech-model'

const HVISKE = 'hviske-v5-tiny-f16'

describe('persistedSpeechModelId', () => {
  test('reads the current key', () => {
    expect(persistedSpeechModelId({ speechModelId: DEFAULT_MODEL_ID })).toBe(
      DEFAULT_MODEL_ID
    )
  })

  test('falls back to the pre-rename key, which is what every existing config has', () => {
    expect(persistedSpeechModelId({ whisperModelId: DEFAULT_MODEL_ID })).toBe(
      DEFAULT_MODEL_ID
    )
  })

  test('carries a Parakeet selection across the rename, not just a whisper one', () => {
    expect(
      persistedSpeechModelId({
        whisperModelId: DEFAULT_STREAM_CAPABLE_MODEL_ID,
      })
    ).toBe(DEFAULT_STREAM_CAPABLE_MODEL_ID)
  })

  test('carries an hviske selection across the rename', () => {
    expect(persistedSpeechModelId({ whisperModelId: HVISKE })).toBe(HVISKE)
  })

  test('prefers the current key when a file somehow holds both', () => {
    expect(
      persistedSpeechModelId({
        speechModelId: DEFAULT_STREAM_CAPABLE_MODEL_ID,
        whisperModelId: DEFAULT_MODEL_ID,
      })
    ).toBe(DEFAULT_STREAM_CAPABLE_MODEL_ID)
  })

  test('null when the file names neither key, so the caller keeps its default', () => {
    expect(persistedSpeechModelId({})).toBeNull()
  })

  test('null for an id no longer in the catalog, under either key', () => {
    expect(
      persistedSpeechModelId({ speechModelId: 'retired-model' })
    ).toBeNull()
    expect(
      persistedSpeechModelId({ whisperModelId: 'retired-model' })
    ).toBeNull()
  })

  test('null for a non-string, so a corrupt file cannot install a selection', () => {
    expect(persistedSpeechModelId({ speechModelId: 42 })).toBeNull()
    expect(persistedSpeechModelId({ whisperModelId: null })).toBeNull()
  })
})
