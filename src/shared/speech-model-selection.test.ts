import { describe, expect, it } from 'bun:test'
import { speechModelSelectionPatch } from './speech-model-selection'

describe('speechModelSelectionPatch', () => {
  it('selects a compatible model without redundant settings', () => {
    expect(
      speechModelSelectionPatch(
        {
          speechModelId: 'small-q5_1',
          transcriptionLanguageId: 'da',
          streamMode: false,
        },
        'large-v3-q5_0'
      )
    ).toEqual({ speechModelId: 'large-v3-q5_0' })
  })

  it('atomically normalizes language and disables live transcription', () => {
    expect(
      speechModelSelectionPatch(
        {
          speechModelId: 'small-q5_1',
          transcriptionLanguageId: 'da',
          streamMode: true,
        },
        'parakeet-tdt-0.6b-v3'
      )
    ).toEqual({
      speechModelId: 'parakeet-tdt-0.6b-v3',
      transcriptionLanguageId: 'auto',
      streamMode: false,
    })
  })
})
