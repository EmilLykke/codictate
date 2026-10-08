import { describe, expect, it } from 'bun:test'
import {
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
