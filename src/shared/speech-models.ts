/**
 * Speech model catalog: whisper.cpp GGML files (stock Whisper and the Danish Edda),
 * Parakeet TDT v3 (Core ML on macOS, ONNX on Windows) and hviske (Danish, crispasr cohere
 * backend).
 * `engine: 'whisperkit'` is the historical Parakeet engine label.
 */

import { TRANSCRIPTION_LANGUAGE_OPTIONS } from './transcription-languages'

/**
 * Speech Engine ids.
 *
 * `hviske` is its own Engine rather than a `whisper_cpp` entry, because the Engine id
 * is what every consumer in the codebase keys download shape, runtime path and UI
 * grouping off:
 *
 * - hviske weights are GGUF files that only crispasr's `cohere` backend can load.
 *   whisper.cpp and llama.cpp cannot read them, so they are not whisper.cpp weights in
 *   any usable sense.
 * - They come from a Mirror repo, not from `ggerganov/whisper.cpp`, so the
 *   `whisperModelDownloadUrl` builder that every `whisper_cpp` model uses would
 *   produce a dead URL.
 * - Every existing `engine === 'whisper_cpp'` filter (TRANSLATE_CAPABLE_MODEL_IDS in
 *   dictation-plan.ts, the Settings model list) would otherwise pick hviske up
 *   silently. A separate id keeps it out of all of them by construction, and the surfaces
 *   that *should* offer hviske name it explicitly instead - see BROWSABLE_SPEECH_MODELS.
 *
 * Reusing `whisperkit` would be worse still: that id routes to the Parakeet native
 * helper. Note that Engine stays distinct from ASR Harness - that hviske has to run
 * under crispasr is a Harness fact, expressed in src/shared/asr-harness.ts and in the
 * transcription path, not in this id.
 */
export type SpeechEngineId = 'whisper_cpp' | 'whisperkit' | 'hviske'

export type SpeechModelModeSupport = 'normal' | 'stream' | 'both'

/**
 * Settings / model row: what is happening while Parakeet prepares itself, shown only while a
 * preparation can actually be under way (Parakeet selected, installed, not yet prepared).
 *
 * The three sentences this replaces all described the old behaviour, where preparation
 * happened inside the user's first Dictation and the app "may look stuck". ADR-0005 makes
 * preparation start on selection instead, so there is nothing to warn about and nothing to
 * ask the user to do - only a fact to state, which disappears on its own when the settings
 * push says the preparation finished.
 */
export const PARAKEET_PREPARING_SETTINGS_HINT =
  'Codictate is preparing Parakeet for this device. It takes a minute or two, runs in the background, and a dictation started before it finishes waits for it.'

/** European-language set aligned with Parakeet TDT v3 multilingual (25 locales we expose in Settings). */
const PARAKEET_V3_TRANSCRIPTION_LANGUAGE_IDS = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'pl',
  'nl',
  'ru',
  'cs',
  'el',
  'fi',
  'sv',
  'da',
  'ro',
  'hu',
  'sk',
  'hr',
  'sl',
  'bg',
  'uk',
  'et',
  'lv',
  'lt',
  'ca',
] as const

/**
 * Mirror repo for the hviske weights. `syvai/hviske-v5-tiny` is `gated: manual`, so the
 * app cannot download from upstream on a user's behalf; this repo is public and ungated,
 * and carries all five Quantizations. Re-mirroring is a maintainer job:
 * `scripts/mirror-hviske.ts`, see docs/HVISKE_MIRROR.md.
 */
export const HVISKE_MIRROR_REPO_ID = 'emillykkegrann/hviske-v5-tiny-GGUF'

/** hviske is Danish-only, so a run pins `--language da` rather than auto-detecting. */
export const HVISKE_TRANSCRIPTION_LANGUAGE_ID = 'da'

/**
 * Mirror repo for the Edda v0.2 GGML weights. `danish-foundation-models/edda-v0.2` ships
 * fp16 safetensors only, which no ASR Harness reads, so Codictate converts them and hosts
 * the result. Re-mirroring is a maintainer job: `scripts/mirror-edda.ts`, see
 * docs/EDDA_MIRROR.md.
 */
export const EDDA_MIRROR_REPO_ID = 'emillykkegrann/edda-v0.2-GGML'

/** Edda v0.2 is a Danish fine-tune, so a run pins `--language da` like hviske. */
export const EDDA_TRANSCRIPTION_LANGUAGE_ID = 'da'

export interface SpeechModel {
  id: string
  engine: SpeechEngineId
  modeSupport: SpeechModelModeSupport
  /** Display / disk artifact — Whisper ggml filename or Parakeet directory name under models root */
  artifactName: string
  downloadSizeMB: number
  peakRamMB: number
  label: string
  description: string
  bundled?: boolean
  /** Always visible in the model picker (not just browse modal). */
  curated?: boolean
  translationSupport: boolean
  /**
   * Hugging Face repo for downloadable models. Unset for the stock whisper.cpp weights,
   * which come from `ggerganov/whisper.cpp`; set on a single-file Speech Model it names the
   * Mirror the file downloads from instead.
   */
  huggingFaceRepoId?: string
  /**
   * Hugging Face commit a multi-file download (Parakeet Core ML) is fetched from, rather than
   * `main`. The commit id names the whole file tree, so it pins a directory of weights the way
   * `sha256` pins a single file: nothing pushed to the repo later can reach a download.
   */
  huggingFaceRevision?: string
  /**
   * Expected sha256 of the downloaded file, lowercase hex, so a download that differs from
   * the pinned bytes is refused rather than installed. Set on Edda, which Codictate
   * produced itself, and on the stock Whisper weights, read from the LFS metadata of
   * `WHISPER_CPP_MODELS_REVISION`.
   */
  sha256?: string
  /** Transcription language ids (from transcription-languages) Parakeet v3 supports; empty = use Whisper rules */
  supportedTranscriptionLanguageIds?: readonly string[]
}

export const SPEECH_MODELS: SpeechModel[] = [
  // ── Curated models (always visible in picker) ──────────────────────
  {
    id: 'parakeet-tdt-0.6b-v3',
    engine: 'whisperkit',
    modeSupport: 'both',
    artifactName: 'parakeet-tdt-0.6b-v3-coreml',
    downloadSizeMB: 500,
    peakRamMB: 80,
    label: 'Parakeet TDT v3',
    description: 'Nvidia model · fastest, 3-10x faster, 80 MB RAM',
    bundled: false,
    curated: true,
    translationSupport: false,
    huggingFaceRepoId: 'FluidInference/parakeet-tdt-0.6b-v3-coreml',
    // 2026-08-19, the head for FluidAudio 0.17.7. It carries `JointDecisionv3.mlmodelc`, which
    // FluidAudio's v3 path has required since 0.14.1; Preprocessor, Encoder, Decoder and
    // the vocabulary are unchanged since 2025-11. macOS only: Windows downloads ONNX weights.
    huggingFaceRevision: '7dd20fe6b1797d35f5e3307e8b1732d9a178edfe',
    supportedTranscriptionLanguageIds: PARAKEET_V3_TRANSCRIPTION_LANGUAGE_IDS,
  },
  {
    id: 'small.en-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.en-q5_1.bin',
    downloadSizeMB: 181,
    peakRamMB: 475,
    label: 'Small English',
    description: 'Whisper model · best lightweight English, 475 MB RAM',
    curated: true,
    translationSupport: false,
    sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30',
  },
  {
    id: 'medium.en-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.en-q5_0.bin',
    downloadSizeMB: 514,
    peakRamMB: 1122,
    label: 'Medium English',
    description: 'Whisper model · best English accuracy, 1.1 GB RAM',
    curated: true,
    translationSupport: false,
    sha256: '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0',
  },
  {
    id: 'small-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small-q5_1.bin',
    downloadSizeMB: 181,
    peakRamMB: 475,
    label: 'Small',
    description: 'Whisper model · lightweight multilingual, 475 MB RAM',
    curated: true,
    translationSupport: true,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  },
  {
    id: 'large-v3-turbo-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-turbo-q5_0.bin',
    downloadSizeMB: 574,
    peakRamMB: 800,
    label: 'Large V3 Turbo',
    description: 'Whisper model · daily driver multilingual, 800 MB RAM',
    bundled: true,
    curated: true,
    translationSupport: false,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
  {
    id: 'large-v3-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-q5_0.bin',
    downloadSizeMB: 1100,
    peakRamMB: 1986,
    label: 'Large V3',
    description: 'Whisper model · highest accuracy, multilingual, 2.0 GB RAM',
    curated: true,
    translationSupport: true,
    sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
  },

  // ── Extended Whisper models (visible via browse modal) ─────────────
  // Tiny
  {
    id: 'tiny',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.bin',
    downloadSizeMB: 75,
    peakRamMB: 224,
    label: 'Tiny',
    description: 'Whisper model · smallest multilingual, 224 MB RAM',
    translationSupport: true,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  },
  {
    id: 'tiny-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny-q5_1.bin',
    downloadSizeMB: 31,
    peakRamMB: 156,
    label: 'Tiny',
    description:
      'Whisper model · smallest multilingual, Q5 quantized, 156 MB RAM',
    translationSupport: true,
    sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7',
  },
  {
    id: 'tiny-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny-q8_0.bin',
    downloadSizeMB: 42,
    peakRamMB: 173,
    label: 'Tiny',
    description:
      'Whisper model · smallest multilingual, Q8 quantized, 173 MB RAM',
    translationSupport: true,
    sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca',
  },
  {
    id: 'tiny.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.en.bin',
    downloadSizeMB: 75,
    peakRamMB: 223,
    label: 'Tiny',
    description: 'Whisper model · smallest English-only, 223 MB RAM',
    translationSupport: false,
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
  },
  {
    id: 'tiny.en-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.en-q5_1.bin',
    downloadSizeMB: 31,
    peakRamMB: 157,
    label: 'Tiny',
    description:
      'Whisper model · smallest English-only, Q5 quantized, 157 MB RAM',
    translationSupport: false,
    sha256: 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b',
  },
  {
    id: 'tiny.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-tiny.en-q8_0.bin',
    downloadSizeMB: 42,
    peakRamMB: 173,
    label: 'Tiny',
    description:
      'Whisper model · smallest English-only, Q8 quantized, 173 MB RAM',
    translationSupport: false,
    sha256: '5bc2b3860aa151a4c6e7bb095e1fcce7cf12c7b020ca08dcec0c6d018bb7dd94',
  },
  // Base
  {
    id: 'base',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.bin',
    downloadSizeMB: 142,
    peakRamMB: 334,
    label: 'Base',
    description: 'Whisper model · lightweight multilingual, 334 MB RAM',
    translationSupport: true,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  },
  {
    id: 'base-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base-q5_1.bin',
    downloadSizeMB: 57,
    peakRamMB: 218,
    label: 'Base',
    description:
      'Whisper model · lightweight multilingual, Q5 quantized, 218 MB RAM',
    translationSupport: true,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  },
  {
    id: 'base-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base-q8_0.bin',
    downloadSizeMB: 78,
    peakRamMB: 247,
    label: 'Base',
    description:
      'Whisper model · lightweight multilingual, Q8 quantized, 247 MB RAM',
    translationSupport: true,
    sha256: 'c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9',
  },
  {
    id: 'base.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.en.bin',
    downloadSizeMB: 142,
    peakRamMB: 333,
    label: 'Base',
    description: 'Whisper model · lightweight English-only, 333 MB RAM',
    translationSupport: false,
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  },
  {
    id: 'base.en-q5_1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.en-q5_1.bin',
    downloadSizeMB: 57,
    peakRamMB: 217,
    label: 'Base',
    description:
      'Whisper model · lightweight English-only, Q5 quantized, 217 MB RAM',
    translationSupport: false,
    sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f',
  },
  {
    id: 'base.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-base.en-q8_0.bin',
    downloadSizeMB: 78,
    peakRamMB: 247,
    label: 'Base',
    description:
      'Whisper model · lightweight English-only, Q8 quantized, 247 MB RAM',
    translationSupport: false,
    sha256: 'a4d4a0768075e13cfd7e19df3ae2dbc4a68d37d36a7dad45e8410c9a34f8c87e',
  },
  // Small (extended variants - curated small-q5_1 is above)
  {
    id: 'small',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.bin',
    downloadSizeMB: 466,
    peakRamMB: 807,
    label: 'Small',
    description: 'Whisper model · good accuracy, full precision, 807 MB RAM',
    translationSupport: true,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  },
  {
    id: 'small-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small-q8_0.bin',
    downloadSizeMB: 252,
    peakRamMB: 558,
    label: 'Small',
    description: 'Whisper model · good accuracy, Q8 quantized, 558 MB RAM',
    translationSupport: true,
    sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f',
  },
  {
    id: 'small.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.en.bin',
    downloadSizeMB: 466,
    peakRamMB: 806,
    label: 'Small',
    description: 'Whisper model · good accuracy English-only, 806 MB RAM',
    translationSupport: false,
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
  },
  {
    id: 'small.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-small.en-q8_0.bin',
    downloadSizeMB: 252,
    peakRamMB: 558,
    label: 'Small',
    description:
      'Whisper model · good accuracy English-only, Q8 quantized, 558 MB RAM',
    translationSupport: false,
    sha256: '67a179f608ea6114bd3fdb9060e762b588a3fb3bd00c4387971be4d177958067',
  },
  // Medium
  {
    id: 'medium',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.bin',
    downloadSizeMB: 1500,
    peakRamMB: 2137,
    label: 'Medium',
    description: 'Whisper model · high accuracy multilingual, 2.1 GB RAM',
    translationSupport: true,
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
  },
  {
    id: 'medium-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium-q5_0.bin',
    downloadSizeMB: 514,
    peakRamMB: 1122,
    label: 'Medium',
    description:
      'Whisper model · high accuracy multilingual, Q5 quantized, 1.1 GB RAM',
    translationSupport: true,
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
  },
  {
    id: 'medium-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium-q8_0.bin',
    downloadSizeMB: 785,
    peakRamMB: 1412,
    label: 'Medium',
    description:
      'Whisper model · high accuracy multilingual, Q8 quantized, 1.4 GB RAM',
    translationSupport: true,
    sha256: '42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502',
  },
  {
    id: 'medium.en',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.en.bin',
    downloadSizeMB: 1500,
    peakRamMB: 2135,
    label: 'Medium',
    description: 'Whisper model · high accuracy English-only, 2.1 GB RAM',
    translationSupport: false,
    sha256: 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356',
  },
  {
    id: 'medium.en-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-medium.en-q8_0.bin',
    downloadSizeMB: 785,
    peakRamMB: 1412,
    label: 'Medium',
    description:
      'Whisper model · high accuracy English-only, Q8 quantized, 1.4 GB RAM',
    translationSupport: false,
    sha256: '43fa2cd084de5a04399a896a9a7a786064e221365c01700cea4666005218f11c',
  },
  // Large V1
  {
    id: 'large-v1',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v1.bin',
    downloadSizeMB: 2900,
    peakRamMB: 3977,
    label: 'Large V1',
    description: 'Whisper model · original large model, 4.0 GB RAM',
    translationSupport: true,
    sha256: '7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d',
  },
  // Large V2
  {
    id: 'large-v2',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v2.bin',
    downloadSizeMB: 2900,
    peakRamMB: 3977,
    label: 'Large V2',
    description: 'Whisper model · improved large model, 4.0 GB RAM',
    translationSupport: true,
    sha256: '9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487',
  },
  {
    id: 'large-v2-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v2-q5_0.bin',
    downloadSizeMB: 1100,
    peakRamMB: 1974,
    label: 'Large V2',
    description: 'Whisper model · improved large, Q5 quantized, 2.0 GB RAM',
    translationSupport: true,
    sha256: '3a214837221e4530dbc1fe8d734f302af393eb30bd0ed046042ebf4baf70f6f2',
  },
  {
    id: 'large-v2-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v2-q8_0.bin',
    downloadSizeMB: 1500,
    peakRamMB: 2546,
    label: 'Large V2',
    description: 'Whisper model · improved large, Q8 quantized, 2.5 GB RAM',
    translationSupport: true,
    sha256: 'fef54e6d898246a65c8285bfa83bd1807e27fadf54d5d4e81754c47634737e8c',
  },
  // Large V3 (extended variants - curated large-v3-q5_0 is above)
  {
    id: 'large-v3',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3.bin',
    downloadSizeMB: 2900,
    peakRamMB: 3983,
    label: 'Large V3',
    description: 'Whisper model · most accurate, full precision, 4.0 GB RAM',
    translationSupport: true,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
  },
  // Large V3 Turbo (extended variants - curated turbo-q5_0 is above)
  {
    id: 'large-v3-turbo',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-turbo.bin',
    downloadSizeMB: 1500,
    peakRamMB: 1878,
    label: 'Large V3 Turbo',
    description:
      'Whisper model · fast and very accurate, full precision, 1.9 GB RAM',
    translationSupport: false,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  },
  {
    id: 'large-v3-turbo-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-large-v3-turbo-q8_0.bin',
    downloadSizeMB: 834,
    peakRamMB: 1107,
    label: 'Large V3 Turbo',
    description:
      'Whisper model · fast and very accurate, Q8 quantized, 1.1 GB RAM',
    translationSupport: false,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
  },

  // ── hviske (Danish) ─────────────────────────────────────────────────
  //
  // One entry per Quantization the Mirror carries, because different Quantizations of
  // the same weights are separate Speech Models with separate Model IDs (GLOSSARY.md).
  // The set is complete so the user picks a size/speed trade-off instead of being handed
  // one.
  //
  // No entry sets `curated`: hviske is a Danish-only model, so it belongs in the browse
  // ("download more") modal rather than in the main Settings list every user scans. q5_0
  // is the Quantization to recommend in prose - lowest measured Danish WER of the five at
  // a third of f16's size - but that recommendation deliberately is not encoded as
  // `curated`. Reaching the browse modal is what BROWSABLE_SPEECH_MODELS is for;
  // `engine: 'hviske'` still keeps these out of the whisper_cpp filters (see
  // SpeechEngineId).
  //
  // `peakRamMB` is the average peak RSS measured by the Benchmark Run
  // `2026-08-18_08-17-28_hviske-vs-main-models` on FLEURS `da_dk`, same as every other
  // entry here. `downloadSizeMB` is the exact Mirror file size in MiB. That run also
  // checked the model card's claim of an identical Danish WER of 10.51 across all five
  // Quantizations: measured WER spans 11.29 (q5_0) to 11.67 (q6_k), a 0.38 point spread
  // over a 3.3x range in file size, which is noise on 197 utterances. So the claim holds
  // and the only real difference between them is size and speed: larger is slower.
  {
    id: 'hviske-v5-tiny-f16',
    engine: 'hviske',
    modeSupport: 'normal',
    artifactName: 'hviske-v5-tiny-f16.gguf',
    downloadSizeMB: 503,
    peakRamMB: 601,
    label: 'Hviske V5 Tiny F16',
    description:
      'Danish model · Danish only, full precision, largest and slowest, 11.5 WER',
    translationSupport: false,
    huggingFaceRepoId: HVISKE_MIRROR_REPO_ID,
    supportedTranscriptionLanguageIds: [HVISKE_TRANSCRIPTION_LANGUAGE_ID],
  },
  {
    id: 'hviske-v5-tiny-q8_0',
    engine: 'hviske',
    modeSupport: 'normal',
    artifactName: 'hviske-v5-tiny-q8_0.gguf',
    downloadSizeMB: 268,
    peakRamMB: 368,
    label: 'Hviske V5 Tiny Q8',
    description:
      'Danish model · Danish only, Q8 quantized, about half the size of F16, 11.5 WER',
    translationSupport: false,
    huggingFaceRepoId: HVISKE_MIRROR_REPO_ID,
    supportedTranscriptionLanguageIds: [HVISKE_TRANSCRIPTION_LANGUAGE_ID],
  },
  {
    id: 'hviske-v5-tiny-q6_k',
    engine: 'hviske',
    modeSupport: 'normal',
    artifactName: 'hviske-v5-tiny-q6_k.gguf',
    downloadSizeMB: 232,
    peakRamMB: 332,
    label: 'Hviske V5 Tiny Q6',
    description:
      'Danish model · Danish only, Q6 quantized, a little smaller than Q8, 11.7 WER',
    translationSupport: false,
    huggingFaceRepoId: HVISKE_MIRROR_REPO_ID,
    supportedTranscriptionLanguageIds: [HVISKE_TRANSCRIPTION_LANGUAGE_ID],
  },
  {
    id: 'hviske-v5-tiny-q5_0',
    engine: 'hviske',
    modeSupport: 'normal',
    artifactName: 'hviske-v5-tiny-q5_0.gguf',
    downloadSizeMB: 181,
    peakRamMB: 282,
    label: 'Hviske V5 Tiny Q5',
    description:
      'Danish model · Danish only, Q5 quantized, smaller than Q6, 11.3 WER',
    translationSupport: false,
    huggingFaceRepoId: HVISKE_MIRROR_REPO_ID,
    supportedTranscriptionLanguageIds: [HVISKE_TRANSCRIPTION_LANGUAGE_ID],
  },
  {
    id: 'hviske-v5-tiny-q4_k',
    engine: 'hviske',
    modeSupport: 'normal',
    artifactName: 'hviske-v5-tiny-q4_k.gguf',
    downloadSizeMB: 153,
    peakRamMB: 253,
    label: 'Hviske V5 Tiny Q4',
    description:
      'Danish model · Danish only, Q4 quantized, smallest and fastest, 11.4 WER',
    translationSupport: false,
    huggingFaceRepoId: HVISKE_MIRROR_REPO_ID,
    supportedTranscriptionLanguageIds: [HVISKE_TRANSCRIPTION_LANGUAGE_ID],
  },

  // ── Edda v0.2 (Danish) ──────────────────────────────────────────────
  //
  // A Danish full fine-tune of large-v3-turbo with the architecture unchanged, so these
  // are ordinary whisper.cpp GGML files on the default crispasr backend: `engine:
  // 'whisper_cpp'`, unlike hviske. What sets them apart from the stock Whisper entries is
  // the Mirror (`huggingFaceRepoId`), the Danish pin (`supportedTranscriptionLanguageIds`,
  // read by `pinnedTranscriptionLanguageId`) and a sha256 per file, because Codictate
  // converted and quantized these itself rather than copying someone else's bytes.
  //
  // Not `curated`, for the same reason as hviske: a Danish-only model belongs in the browse
  // modal, which takes every non-curated whisper_cpp entry already.
  //
  // `peakRamMB` is the average peak RSS from the Benchmark Run
  // `2026-10-08_06-42-10_edda-v0-2-danish` (all 927 FLEURS `da_dk` clips, Apple M4 Max), and
  // `downloadSizeMB` the exact Mirror file size in MiB. That run measured 7.51 / 7.52 / 7.53
  // WER for f16 / q8_0 / q5_0, against 11.31 for hviske q5_0 and 13.89 for large-v3-turbo-q5_0
  // on the same clips: the Quantization does not move accuracy, so size and speed decide.
  {
    id: 'edda-v0.2-f16',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-edda-v0.2-f16.bin',
    downloadSizeMB: 1549,
    peakRamMB: 1884,
    label: 'Edda V0.2 F16',
    description:
      'Danish model · Danish only, full precision, largest and slowest, 7.5 WER',
    translationSupport: false,
    huggingFaceRepoId: EDDA_MIRROR_REPO_ID,
    sha256: '5a2b2ccf98e3bd45b70b7aa46457d910f5788fcb2bc2f0ef643487cc5ce629d9',
    supportedTranscriptionLanguageIds: [EDDA_TRANSCRIPTION_LANGUAGE_ID],
  },
  {
    id: 'edda-v0.2-q8_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-edda-v0.2-q8_0.bin',
    downloadSizeMB: 834,
    peakRamMB: 1098,
    label: 'Edda V0.2 Q8',
    description:
      'Danish model · Danish only, Q8 quantized, about half the size of F16, 7.5 WER',
    translationSupport: false,
    huggingFaceRepoId: EDDA_MIRROR_REPO_ID,
    sha256: '93b2a5650900275fce1a6bb1443623648e504ca6a2583453589b679d8330b716',
    supportedTranscriptionLanguageIds: [EDDA_TRANSCRIPTION_LANGUAGE_ID],
  },
  {
    id: 'edda-v0.2-q5_0',
    engine: 'whisper_cpp',
    modeSupport: 'normal',
    artifactName: 'ggml-edda-v0.2-q5_0.bin',
    downloadSizeMB: 547,
    peakRamMB: 787,
    label: 'Edda V0.2 Q5',
    description:
      'Danish model · Danish only, Q5 quantized, smallest and fastest, 7.5 WER',
    translationSupport: false,
    huggingFaceRepoId: EDDA_MIRROR_REPO_ID,
    sha256: '75bd9abd0d328872cacb0f36e9444775cc46d9976bf64f69443e74265ac0add1',
    supportedTranscriptionLanguageIds: [EDDA_TRANSCRIPTION_LANGUAGE_ID],
  },
]

export const DEFAULT_MODEL_ID = 'large-v3-turbo-q5_0'

/**
 * The large non-turbo model. Named here rather than at its callers because it is a catalog
 * fact, and the one Speech Model a finished download never auto-selects: it is slow enough
 * that landing on it by accident reads as the app breaking.
 */
export const LARGE_V3_Q5_MODEL_ID = 'large-v3-q5_0'

/** Recommended stream engine model (must be installed; not bundled). */
export const DEFAULT_STREAM_CAPABLE_MODEL_ID = 'parakeet-tdt-0.6b-v3'

/**
 * The Parakeet engine id. A misnomer kept for config compatibility - the engine is
 * FluidAudio, not WhisperKit (see SpeechEngineId). Named once so the run path, the warmup
 * routine and the benchmark compare against one constant instead of re-typing the literal.
 *
 * `satisfies` rather than a type annotation, so the constant keeps its literal type: a
 * comparison against it narrows a `SpeechEngineId`, which is what lets the Transcription
 * Request discriminate its two arms on `engineId` without re-typing `'whisperkit'`.
 */
export const PARAKEET_ENGINE_ID = 'whisperkit' satisfies SpeechEngineId

export const SPEECH_MODEL_IDS = SPEECH_MODELS.map((m) => m.id)

export function getSpeechModel(id: string): SpeechModel | undefined {
  return SPEECH_MODELS.find((m) => m.id === id)
}

export function isValidSpeechModelId(id: string): boolean {
  return SPEECH_MODEL_IDS.includes(id)
}

export function supportsStreamMode(model: SpeechModel): boolean {
  return model.modeSupport === 'stream' || model.modeSupport === 'both'
}

/** True for the Danish hviske Speech Models, which run under crispasr `--backend cohere`. */
export function isHviskeSpeechModelId(id: string): boolean {
  return getSpeechModel(id)?.engine === 'hviske'
}

/**
 * The one Transcription Language a Speech Model's weights can produce, which a run pins
 * instead of taking the user's setting, or `null` when the setting decides.
 *
 * hviske and Edda declare Danish alone. Parakeet declares 25, and the stock Whisper entries
 * declare nothing - the English-only ones predate the field and transcribe whatever
 * language they are told, which is why `.en` is not read here.
 */
export function pinnedTranscriptionLanguageId(id: string): string | null {
  const languageIds = getSpeechModel(id)?.supportedTranscriptionLanguageIds
  return languageIds?.length === 1 ? languageIds[0] : null
}

/**
 * The `ggerganov/whisper.cpp` commit the stock Whisper weights download from. Pinned so the
 * bytes behind each entry's `sha256` cannot move; bumping it means re-reading every
 * `sha256` from that commit's LFS metadata.
 */
export const WHISPER_CPP_MODELS_REVISION =
  '5359861c739e955e79d9a303bcbc70fb988958b1'

/** Upstream ggml weights for every stock `whisper_cpp` Speech Model, keyed by `artifactName`. */
export function whisperModelDownloadUrl(artifactName: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_CPP_MODELS_REVISION}/${artifactName}`
}

/**
 * Direct file URL for a single-file Speech Model (whisper.cpp GGML, hviske GGUF).
 *
 * A model naming a Mirror (`huggingFaceRepoId`: hviske, Edda) downloads from it; the stock
 * Whisper weights come from `ggerganov/whisper.cpp`, which has neither.
 */
export function singleFileModelDownloadUrl(model: SpeechModel): string {
  if (model.huggingFaceRepoId) {
    return `https://huggingface.co/${model.huggingFaceRepoId}/resolve/main/${model.artifactName}`
  }
  return whisperModelDownloadUrl(model.artifactName)
}

/** Parakeet (Core ML) has no fixed-language setting; the UI locks transcription language to automatic. */
export function speechModelLocksTranscriptionLanguage(
  speechModelId: string
): boolean {
  return getSpeechModel(speechModelId)?.engine === PARAKEET_ENGINE_ID
}

/** `auto` is always allowed. Whisper models (no `supportedTranscriptionLanguageIds`) allow every picker id. */
export function transcriptionLanguageAllowedForModel(
  speechModelId: string,
  transcriptionLanguageId: string
): boolean {
  if (transcriptionLanguageId === 'auto') return true
  const model = getSpeechModel(speechModelId)
  const list = model?.supportedTranscriptionLanguageIds
  if (!list?.length) return true
  return (list as readonly string[]).includes(transcriptionLanguageId)
}

/**
 * The directory name Parakeet's Core ML weights are installed under on macOS.
 *
 * It is the name FluidAudio 0.13.6 insisted on: `AsrModels.load(from:)` read the *parent* of
 * the directory it was handed and re-appended `Repo.folderName`, which for the v3 repo was the
 * slug with every `-coreml` stripped, and fetched its own 461 MB copy when the names disagreed.
 *
 * Since FluidAudio 0.17.7 the helper calls `AsrModels.loadLocal(from:)`, which reads exactly
 * the directory it is handed and never downloads, so this name is Codictate's own. It stays
 * as it was so existing installs do not move. Do not go back to `load(from:)` without
 * rechecking: 0.17.7's `folderName` for v3 keeps `-coreml`, so it would disagree with this.
 *
 * macOS only. The Windows helper is ONNX and reads the directory it is given.
 */
export function fluidAudioModelFolderName(artifactName: string): string {
  // split/join rather than replaceAll: it matches Swift's replacingOccurrences on every
  // occurrence, and replaceAll is past this project's configured lib target.
  return artifactName.split('-coreml').join('')
}

export function parakeetSupportsTranscriptionLanguageId(id: string): boolean {
  return transcriptionLanguageAllowedForModel(
    DEFAULT_STREAM_CAPABLE_MODEL_ID,
    id
  )
}

/** When switching model, normalize stored transcription language (Parakeet → always auto). */
export function coerceTranscriptionLanguageIdForModel(
  speechModelId: string,
  currentTranscriptionLanguageId: string
): string {
  if (speechModelLocksTranscriptionLanguage(speechModelId)) {
    return 'auto'
  }
  if (
    transcriptionLanguageAllowedForModel(
      speechModelId,
      currentTranscriptionLanguageId
    )
  ) {
    return currentTranscriptionLanguageId
  }
  return 'auto'
}

/** Settings tooltip: Parakeet language names only (no ISO codes), sorted A–Z. */
export function parakeetSupportedLanguagesTooltipText(): string {
  const byId = new Map(
    TRANSCRIPTION_LANGUAGE_OPTIONS.map((o) => [o.id, o.label])
  )
  const labels = PARAKEET_V3_TRANSCRIPTION_LANGUAGE_IDS.map((id) =>
    byId.get(id)
  ).filter((l): l is string => l != null)
  labels.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return (
    `Parakeet supports ${labels.length} languages for live and batch dictation:\n` +
    labels.join(', ') +
    '.'
  )
}

export function formatModelSize(sizeMB: number): string {
  if (sizeMB >= 1000) return `${(sizeMB / 1000).toFixed(1)} GB`
  return `${sizeMB} MB`
}

export function formatRamSize(ramMB: number): string {
  if (ramMB >= 1000) return `${(ramMB / 1000).toFixed(1)} GB RAM`
  return `${ramMB} MB RAM`
}

export const CURATED_SPEECH_MODELS = SPEECH_MODELS.filter((m) => m.curated)

/**
 * Everything the browse ("download more") modal offers: the Speech Models a user has to go
 * looking for rather than the curated few the main Settings list shows.
 *
 * That is every non-curated whisper.cpp Quantization (Edda's included) plus all five hviske
 * Quantizations.
 * hviske is named by engine instead of riding the `!curated` test, because it is not a
 * `whisper_cpp` model and no hviske entry is ever curated - a Danish-only model does not
 * belong in the list every user scans, but it does belong somewhere reachable.
 *
 * Parakeet is absent by design: it has its own section in Settings.
 */
export const BROWSABLE_SPEECH_MODELS = SPEECH_MODELS.filter(
  (m) => (m.engine === 'whisper_cpp' && !m.curated) || m.engine === 'hviske'
)
