import { describe, expect, test } from 'bun:test'
import {
  ASR_HARNESS_IDS,
  DEFAULT_ASR_HARNESS,
  EKKO_ASR_HARNESS,
  HVISKE_ASR_HARNESS,
  isAsrHarnessId,
} from './asr-harness'

describe('ASR Harnesses', () => {
  test('crispasr and parakeet-cli are the Harnesses, and crispasr stays the default', () => {
    expect(ASR_HARNESS_IDS).toEqual(['crispasr', 'parakeet-cli'])
    expect(DEFAULT_ASR_HARNESS).toBe('crispasr')
    expect(HVISKE_ASR_HARNESS).toBe('crispasr')
  })

  test('ekko runs on parakeet-cli', () => {
    expect(EKKO_ASR_HARNESS).toBe('parakeet-cli')
    expect(isAsrHarnessId('parakeet-cli')).toBe(true)
    expect(isAsrHarnessId('whisper-cli')).toBe(false)
  })
})
