import { describe, expect, it } from 'bun:test'
import {
  BROWSABLE_SPEECH_MODELS,
  DEFAULT_MODEL_ID,
  RECOMMENDED_DANISH_SPEECH_MODEL_ID,
  SPEECH_MODELS,
  fluidAudioModelFolderName,
  getSpeechModel,
} from './speech-models'

/**
 * The folder name Parakeet's weights are installed under.
 *
 * FluidAudio 0.13.6 read the parent of the directory it was handed and re-appended its own
 * `Repo.folderName`, so a name that disagreed by one suffix made an installed 461 MB model
 * invisible. The helper now loads the exact directory (`AsrModels.loadLocal`), so the name
 * is pinned here to keep existing installs where they are.
 */
describe('fluidAudioModelFolderName', () => {
  it('strips the -coreml suffix FluidAudio strips', () => {
    expect(fluidAudioModelFolderName('parakeet-tdt-0.6b-v3-coreml')).toBe(
      'parakeet-tdt-0.6b-v3'
    )
  })

  it('leaves a name with no -coreml suffix alone', () => {
    expect(fluidAudioModelFolderName('parakeet-tdt-0.6b-v3')).toBe(
      'parakeet-tdt-0.6b-v3'
    )
  })

  it('strips every occurrence, as replacingOccurrences does', () => {
    expect(fluidAudioModelFolderName('a-coreml-b-coreml')).toBe('a-b')
  })

  it('maps the catalog Parakeet entry to its install folder', () => {
    const parakeet = getSpeechModel('parakeet-tdt-0.6b-v3')
    expect(parakeet?.engine).toBe('whisperkit')
    // The Hugging Face repo slug keeps -coreml; the local folder must not.
    expect(parakeet?.artifactName).toBe('parakeet-tdt-0.6b-v3-coreml')
    expect(fluidAudioModelFolderName(parakeet!.artifactName)).toBe(
      'parakeet-tdt-0.6b-v3'
    )
  })

  it('is a no-op for every non-Parakeet artifact name', () => {
    for (const model of SPEECH_MODELS) {
      if (model.engine === 'whisperkit') continue
      expect(fluidAudioModelFolderName(model.artifactName)).toBe(
        model.artifactName
      )
    }
  })
})

/**
 * The browse modal lists best first: Whisper by family (large-v3 down to tiny), a size's
 * multilingual entries before its `.en` ones, full precision before q8 before q5; then the
 * Danish-only models by accuracy, Edda before hviske.
 */
describe('BROWSABLE_SPEECH_MODELS', () => {
  it('lists the best models first', () => {
    expect(BROWSABLE_SPEECH_MODELS.map((m) => m.id)).toEqual([
      'large-v3',
      'large-v3-q5_0',
      'large-v3-turbo',
      'large-v3-turbo-q8_0',
      'large-v2',
      'large-v2-q8_0',
      'large-v2-q5_0',
      'large-v1',
      'medium',
      'medium-q8_0',
      'medium-q5_0',
      'medium.en',
      'medium.en-q8_0',
      'small',
      'small-q8_0',
      'small.en',
      'small.en-q8_0',
      'base',
      'base-q8_0',
      'base-q5_1',
      'base.en',
      'base.en-q8_0',
      'base.en-q5_1',
      'tiny',
      'tiny-q8_0',
      'tiny-q5_1',
      'tiny.en',
      'tiny.en-q8_0',
      'tiny.en-q5_1',
      'edda-v0.2-f16',
      'edda-v0.2-q8_0',
      'edda-v0.2-q5_0',
      'hviske-v5-tiny-f16',
      'hviske-v5-tiny-q8_0',
      'hviske-v5-tiny-q6_k',
      'hviske-v5-tiny-q5_0',
      'hviske-v5-tiny-q4_k',
    ])
  })

  it('leaves the catalog order of SPEECH_MODELS alone', () => {
    expect(SPEECH_MODELS[0].id).toBe('parakeet-tdt-0.6b-v3')
    expect(SPEECH_MODELS.findIndex((m) => m.id === 'tiny')).toBeLessThan(
      SPEECH_MODELS.findIndex((m) => m.id === 'large-v3')
    )
  })
})

/**
 * The browse modal marks one Speech Model "Recommended for Danish" (#86, #99): Edda q5_0,
 * the most accurate Danish model at the smallest Edda size. It is a marker only, so the
 * model stays out of the curated list and the bundled default does not move.
 */
describe('RECOMMENDED_DANISH_SPEECH_MODEL_ID', () => {
  it('is Edda q5_0', () => {
    expect(RECOMMENDED_DANISH_SPEECH_MODEL_ID).toBe('edda-v0.2-q5_0')
  })

  it('names a browsable, uncurated, Danish-only model', () => {
    const model = getSpeechModel(RECOMMENDED_DANISH_SPEECH_MODEL_ID)
    expect(model?.curated).toBeUndefined()
    expect(model?.supportedTranscriptionLanguageIds).toEqual(['da'])
    expect(
      BROWSABLE_SPEECH_MODELS.some(
        (m) => m.id === RECOMMENDED_DANISH_SPEECH_MODEL_ID
      )
    ).toBe(true)
  })

  it('says why in the description', () => {
    expect(
      getSpeechModel(RECOMMENDED_DANISH_SPEECH_MODEL_ID)?.description
    ).toBe(
      'Danish model · Danish only, most accurate Danish model, Q5 quantized, smallest and fastest, 7.5 WER'
    )
  })

  it('leaves the bundled default alone', () => {
    expect(DEFAULT_MODEL_ID).toBe('large-v3-turbo-q5_0')
  })
})
