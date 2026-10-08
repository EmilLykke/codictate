import { join, dirname } from 'path'
import {
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  createWriteStream,
  readdirSync,
  rmSync,
  linkSync,
  createReadStream,
  statSync,
} from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { downloadFile, listFiles } from '@huggingface/hub'
import {
  PARAKEET_ENGINE_ID,
  SPEECH_MODELS,
  getSpeechModel,
  singleFileModelDownloadUrl,
  fluidAudioModelFolderName,
  type SpeechModel,
} from '../../../shared/speech-models'
import { log } from '../logger'
import { MODELS_DIR, getPlatformRuntime } from '../../platform/runtime'

const BUNDLED_MODEL_PATH = join(
  import.meta.dir,
  '../native-helpers/ggml-large-v3-turbo-q5_0.bin'
)

export type ModelProgressCallback = (
  fraction: number,
  done: boolean,
  error?: string
) => void

function downloadErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'Cancelled'
  if (err instanceof Error) return err.message
  return 'Download failed'
}

/**
 * A failed model download, in words the user can act on.
 *
 * hviske and Edda downloads come from a Mirror rather than from `ggerganov/whisper.cpp`, so
 * a refusal names the repo: it is the one detail that distinguishes "this download is
 * broken" from "your network is broken" when the Mirror itself is the problem. See
 * docs/HVISKE_MIRROR.md and docs/EDDA_MIRROR.md.
 */
function httpDownloadErrorMessage(
  model: SpeechModel,
  url: string,
  status: number,
  statusText: string
): string {
  if (model.huggingFaceRepoId && [401, 403, 404].includes(status)) {
    return (
      `Could not download this model from ${model.huggingFaceRepoId} ` +
      `(HTTP ${status} for ${url}). Check your connection and try again.`
    )
  }
  return `HTTP ${status} ${statusText}`
}

const WINDOWS_PARAKEET_ONNX_REPO_ID = 'istupakov/parakeet-tdt-0.6b-v3-onnx'
const WINDOWS_PARAKEET_ONNX_ARTIFACT_NAME = 'parakeet-tdt-0.6b-v3-onnx'

/**
 * The commit of the ONNX repo a Windows install downloads, not `main`, so an upstream
 * re-upload cannot change the weights under a helper built and checked against these ones.
 * Move it on purpose, together with the hashes below.
 */
const WINDOWS_PARAKEET_ONNX_REVISION =
  '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce'

/**
 * sha256 of each required file at `WINDOWS_PARAKEET_ONNX_REVISION`, checked while it
 * streams to disk, and the download list, as `MACOS_PARAKEET_COREML_SHA256` is on macOS.
 * The LFS hashes are the ones Hugging Face lists at that commit; `vocab.txt` is a plain
 * git file, hashed from a download whose git blob id matched.
 */
const WINDOWS_PARAKEET_ONNX_SHA256: Record<string, string> = {
  'encoder-model.onnx':
    '98a74b21b4cc0017c1e7030319a4a96f4a9506e50f0708f3a516d02a77c96bb1',
  'encoder-model.onnx.data':
    '9a22d372c51455c34f13405da2520baefb7125bd16981397561423ed32d24f36',
  'decoder_joint-model.onnx':
    'e978ddf6688527182c10fde2eb4b83068421648985ef23f7a86be732be8706c1',
  'vocab.txt':
    'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
}

const CHECKSUM_MISMATCH_MESSAGE =
  'The downloaded file did not match the expected checksum. Try the download again.'

/**
 * What `CodictateParakeetHelper` loads for v3 (FluidAudio 0.17.7,
 * `ModelNames.ASR.requiredModelsV3()` at the default `.int8` precision). It reads this exact
 * directory and downloads nothing, so every entry has to be here.
 */
const MACOS_PARAKEET_COREML_REQUIRED_DIRS = [
  'Preprocessor.mlmodelc',
  'Encoder.mlmodelc',
  'Decoder.mlmodelc',
  'JointDecisionv3.mlmodelc',
] as const

const MACOS_PARAKEET_COREML_REQUIRED_FILES = [
  'parakeet_vocab.json',
  'parakeet_v3_vocab.json',
] as const

/**
 * sha256 of every file a macOS install downloads, at the catalog's Core ML
 * `huggingFaceRevision` (`7dd20fe6`), checked while each one streams to disk. It is also the
 * download list: a file it does not name is not fetched, so nothing read from the repo at
 * run time decides what is trusted. The twelve `coremldata.bin` and `weight.bin` hashes are
 * the LFS ones Hugging Face lists at that commit; the ten plain git files (`metadata.json`,
 * `model.mil`, the two vocabularies) were hashed from downloads whose git blob ids matched.
 * Moving the revision means rebuilding this table from the new commit's tree.
 */
const MACOS_PARAKEET_COREML_SHA256: Record<string, string> = {
  'Preprocessor.mlmodelc/analytics/coremldata.bin':
    'c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d',
  'Preprocessor.mlmodelc/coremldata.bin':
    'dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d',
  'Preprocessor.mlmodelc/metadata.json':
    '2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf',
  'Preprocessor.mlmodelc/model.mil':
    '4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93',
  'Preprocessor.mlmodelc/weights/weight.bin':
    '129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea',
  'Encoder.mlmodelc/analytics/coremldata.bin':
    '42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105',
  'Encoder.mlmodelc/coremldata.bin':
    'd48034a167a82e88fc3df64f60af963ab3983538271175b8319e7d5720a0fb86',
  'Encoder.mlmodelc/metadata.json':
    'da24da9cca943fb29d7fa8e376d57fca7cb3aa08ca51b956b0b0e56813f087e9',
  'Encoder.mlmodelc/model.mil':
    'ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808',
  'Encoder.mlmodelc/weights/weight.bin':
    'e2020f323703477a5b21d7c2d282c403e371afb5962e79877e3033e73ba6f421',
  'Decoder.mlmodelc/analytics/coremldata.bin':
    '4238c4e81ecd0dc94bd7dfbb60f7e2cc824107c1ffe0387b8607b72833dba350',
  'Decoder.mlmodelc/coremldata.bin':
    '18647af085d87bd8f3121c8a9b4d4564c1ede038dab63d295b4e745cf2d7fb99',
  'Decoder.mlmodelc/metadata.json':
    'a39e93cd8371b8ded92635c7804fcd0590f0d1dd9415c6d19a0484be073077d9',
  'Decoder.mlmodelc/model.mil':
    'ef2a0a281695398a62fde86ac269c68f73d5b578d7ed3b31f2ba91a2d1ea1f35',
  'Decoder.mlmodelc/weights/weight.bin':
    '48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41',
  'JointDecisionv3.mlmodelc/analytics/coremldata.bin':
    '26def4bf73dd56d29dee21c8ef97cb8969e62f6120ed1adc91e46828e2737b6c',
  'JointDecisionv3.mlmodelc/coremldata.bin':
    'f5fc08b741400f0088492c9e839418b1e18522f19cba28d361dd030c5f398342',
  'JointDecisionv3.mlmodelc/metadata.json':
    'd9307211b9a37e0f0ac260c7660b1571a3de25841035cfdf9b58fd40425f890f',
  'JointDecisionv3.mlmodelc/model.mil':
    'be60732943389a047175111a83f8839f3eb39d4803adafa828a0871b2f39818d',
  'JointDecisionv3.mlmodelc/weights/weight.bin':
    '4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e',
  'parakeet_vocab.json':
    '7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735',
  'parakeet_v3_vocab.json':
    '7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735',
}

function isRequiredCoreMlEntry(name: string): boolean {
  return (
    (MACOS_PARAKEET_COREML_REQUIRED_FILES as readonly string[]).includes(
      name
    ) || MACOS_PARAKEET_COREML_REQUIRED_DIRS.some((dir) => name === dir)
  )
}

function cleanupParakeetCoreMlInstall(dir: string): void {
  if (getPlatformRuntime() === 'windows') return
  try {
    for (const entry of readdirSync(dir)) {
      if (!isRequiredCoreMlEntry(entry)) {
        const fullPath = join(dir, entry)
        rmSync(fullPath, { recursive: true, force: true })
      }
    }
  } catch {
    // non-critical — stale files just waste disk space
  }
}

/**
 * Directories a Parakeet install can be missing and still be completed by fetching only
 * them, at boot, without the user doing anything.
 *
 * `JointDecisionv3.mlmodelc` is what FluidAudio 0.14.1 added to v3. Every install Codictate
 * made before the 0.17.7 upgrade lacks it, and everything else those installs hold is
 * byte-identical to the pinned revision (Preprocessor, Encoder, Decoder and
 * `parakeet_vocab.json` have the same tree ids at every repo revision since 2025-09-25, and
 * the download re-checks each kept file against `MACOS_PARAKEET_COREML_SHA256` anyway). So
 * a 12.6 MB fetch makes them complete, where reading them as missing would cost a 483 MB
 * download and a heal pass that switches the user's Speech Model away.
 */
const MACOS_PARAKEET_COREML_TOP_UP_DIRS = ['JointDecisionv3.mlmodelc'] as const

/** An install that `parakeetCoreMlInstallComplete` refuses only for want of a top-up. */
function parakeetCoreMlNeedsTopUp(dir: string): boolean {
  if (!existsSync(join(dir, 'parakeet_vocab.json'))) return false
  const missing = MACOS_PARAKEET_COREML_REQUIRED_DIRS.filter(
    (name) => !existsSync(join(dir, name))
  )
  return (
    missing.length > 0 &&
    missing.every((name) =>
      (MACOS_PARAKEET_COREML_TOP_UP_DIRS as readonly string[]).includes(name)
    )
  )
}

interface ParakeetRepoFile {
  path: string
  /** From the repo listing, for progress only. */
  size: number
  /** From the checked-in table, never from the listing. */
  sha256: string
}

/**
 * Whether a file already installed is byte-for-byte the pinned one, so the download can keep
 * it instead of fetching it again. Checked by content against the same sha256 a fetched file
 * has to match, not by size: a re-exported Core ML weight file can keep its size and change
 * every value in it.
 */
async function installedFileMatches(
  path: string,
  file: ParakeetRepoFile
): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size !== file.size) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex') === file.sha256
}

/**
 * Every directory the helper loads, not just any `.mlmodelc`: an install made before FluidAudio
 * 0.14.1 has no `JointDecisionv3.mlmodelc`, and reading that as complete would let every
 * Parakeet Dictation fail at load instead of offering the download.
 */
function parakeetCoreMlInstallComplete(dir: string): boolean {
  if (!existsSync(dir)) return false
  if (!existsSync(join(dir, 'parakeet_vocab.json'))) return false
  return MACOS_PARAKEET_COREML_REQUIRED_DIRS.every((name) =>
    existsSync(join(dir, name))
  )
}

function parakeetOnnxInstallComplete(dir: string): boolean {
  if (!existsSync(dir)) return false
  const hasFullPrecision =
    existsSync(join(dir, 'encoder-model.onnx')) &&
    existsSync(join(dir, 'encoder-model.onnx.data')) &&
    existsSync(join(dir, 'decoder_joint-model.onnx'))
  const hasInt8 =
    existsSync(join(dir, 'encoder-model.int8.onnx')) &&
    existsSync(join(dir, 'decoder_joint-model.int8.onnx'))
  return existsSync(join(dir, 'vocab.txt')) && (hasFullPrecision || hasInt8)
}

function parakeetInstallComplete(dir: string): boolean {
  if (getPlatformRuntime() === 'windows')
    return parakeetOnnxInstallComplete(dir)
  return parakeetCoreMlInstallComplete(dir)
}

function parakeetArtifactName(model: SpeechModel): string {
  if (getPlatformRuntime() === 'windows')
    return WINDOWS_PARAKEET_ONNX_ARTIFACT_NAME
  return fluidAudioModelFolderName(model.artifactName)
}

/**
 * Where Parakeet's weights used to be installed: under the Hugging Face repo slug, which
 * is one `-coreml` away from the only name FluidAudio ever looks at. Returns null when
 * the two names agree and there is nothing to migrate.
 */
function legacyParakeetInstallDir(model: SpeechModel): string | null {
  if (getPlatformRuntime() === 'windows') return null
  const legacy = join(MODELS_DIR, model.artifactName)
  const current = join(MODELS_DIR, parakeetArtifactName(model))
  return legacy === current ? null : legacy
}

/**
 * Move a pre-existing install to the name FluidAudio reads, so the fix costs no download.
 *
 * Deliberately conservative about the delete: it only clears the target when the target is
 * incomplete *and* the legacy install is complete, which is exactly the wreckage a
 * mismatched load leaves behind - FluidAudio's own partial fetch of weights that were
 * already on disk under the other name.
 */
function migrateLegacyParakeetInstall(model: SpeechModel): void {
  const legacyDir = legacyParakeetInstallDir(model)
  if (legacyDir === null) return
  const targetDir = join(MODELS_DIR, parakeetArtifactName(model))
  if (!parakeetCoreMlInstallComplete(legacyDir)) return
  if (parakeetCoreMlInstallComplete(targetDir)) return
  try {
    if (existsSync(targetDir))
      rmSync(targetDir, { recursive: true, force: true })
    renameSync(legacyDir, targetDir)
    log(
      'model-manager',
      'migrated Parakeet install to the FluidAudio folder name',
      {
        from: legacyDir,
        to: targetDir,
      }
    )
  } catch (err) {
    log('model-manager', 'could not migrate Parakeet install', {
      from: legacyDir,
      to: targetDir,
      err: String(err),
    })
  }
}

function parakeetRepoId(model: SpeechModel): string | undefined {
  if (getPlatformRuntime() === 'windows') return WINDOWS_PARAKEET_ONNX_REPO_ID
  return model.huggingFaceRepoId
}

/**
 * The pinned commit to download from: the ONNX repo's on Windows, the catalog's Core ML
 * commit on macOS. Neither falls back to `main`.
 */
function parakeetRevision(model: SpeechModel): string | undefined {
  if (getPlatformRuntime() === 'windows') return WINDOWS_PARAKEET_ONNX_REVISION
  return model.huggingFaceRevision
}

/** Every file the platform's Parakeet install downloads, with the sha256 it must match. */
function parakeetPinnedFiles(): Map<string, string> {
  return new Map(
    Object.entries(
      getPlatformRuntime() === 'windows'
        ? WINDOWS_PARAKEET_ONNX_SHA256
        : MACOS_PARAKEET_COREML_SHA256
    )
  )
}

class ModelManager {
  private downloads = new Map<string, AbortController>()
  private coreMlCleaned = new Set<string>()
  private legacyMigrated = new Set<string>()

  private modelInfo(modelId: string): SpeechModel | undefined {
    return getSpeechModel(modelId)
  }

  /**
   * Is this Speech Model's weights on disk, ready to load?
   *
   * A question, and only a question: it stats and reads directories and changes nothing.
   * It used to migrate a legacy Parakeet install and delete stale Core ML files on the way
   * to its answer, which made every asker a writer - and this predicate is asked 2-4 times
   * per Dictation Plan build, once per model inside every `getSettings()`, and from the
   * pre-spawn check on the Dictation hot path. `reconcileInstalls()` below does that work,
   * at the two moments that should be doing it.
   */
  isModelAvailable(modelId: string): boolean {
    const model = this.modelInfo(modelId)
    if (!model) return false
    if (model.bundled) return true
    if (model.engine === PARAKEET_ENGINE_ID) {
      return parakeetInstallComplete(this.getParakeetInstallDir(modelId))
    }
    return existsSync(join(MODELS_DIR, model.artifactName))
  }

  /**
   * Bring the Parakeet install directories into the shape `isModelAvailable` expects, and
   * reclaim what a download left behind.
   *
   * Two jobs, both writes, neither of which belongs inside a predicate:
   *
   * - **Migrate.** An install under the old Hugging Face repo slug is the same weights one
   *   `-coreml` away from the only name FluidAudio reads. It has to move before the first
   *   availability read, because reporting it missing offers the user a download they
   *   already have - and now that the heal pass acts on availability, it would also switch
   *   their Speech Model away from weights that are sitting right there.
   * - **Tidy.** A finished Core ML download leaves entries FluidAudio never loads. Stale
   *   files only waste disk, so this is best-effort and failure is not reported.
   *
   * Idempotent, and remembers what it has already done this session, so calling it at boot
   * and after every download costs one `readdir` per directory. Call it before availability
   * is first read, and after a download completes. Nothing else needs it.
   */
  reconcileInstalls(): void {
    for (const model of SPEECH_MODELS) {
      if (model.engine !== PARAKEET_ENGINE_ID) continue
      const dir = join(MODELS_DIR, parakeetArtifactName(model))
      if (!this.legacyMigrated.has(dir)) {
        migrateLegacyParakeetInstall(model)
        this.legacyMigrated.add(dir)
      }
      if (!parakeetInstallComplete(dir)) continue
      if (this.coreMlCleaned.has(dir)) continue
      cleanupParakeetCoreMlInstall(dir)
      this.coreMlCleaned.add(dir)
    }
  }

  getModelPath(modelId: string): string {
    const model = this.modelInfo(modelId)
    if (!model) throw new Error(`Unknown speech model: ${modelId}`)
    if (model.engine === PARAKEET_ENGINE_ID) {
      return this.getParakeetInstallDir(modelId)
    }
    if (model.bundled) return BUNDLED_MODEL_PATH
    return join(MODELS_DIR, model.artifactName)
  }

  /** Directory passed to the platform Parakeet helper (Core ML on macOS, ONNX on Windows). */
  getParakeetInstallDir(modelId: string): string {
    const model = this.modelInfo(modelId)
    if (!model || model.engine !== PARAKEET_ENGINE_ID) {
      throw new Error(`Not a Parakeet / WhisperKit model: ${modelId}`)
    }
    return join(MODELS_DIR, parakeetArtifactName(model))
  }

  getAvailabilityMap(): Record<string, boolean> {
    return Object.fromEntries(
      SPEECH_MODELS.map((m) => [m.id, this.isModelAvailable(m.id)])
    )
  }

  /** Installed Parakeet weights + helper binary present (for stream). */
  isStreamModelInstalled(): boolean {
    return this.isModelAvailable('parakeet-tdt-0.6b-v3')
  }

  private async downloadSingleFileModel(
    model: SpeechModel,
    tempPath: string,
    controller: AbortController,
    onProgress: ModelProgressCallback
  ): Promise<void> {
    const url = singleFileModelDownloadUrl(model)
    log('model-manager', 'starting single-file model download', {
      modelId: model.id,
      engine: model.engine,
      url,
    })

    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new Error(
        httpDownloadErrorMessage(
          model,
          url,
          response.status,
          response.statusText
        )
      )
    }

    const contentLength = Number(response.headers.get('Content-Length') ?? '0')
    const reader = response.body.getReader()
    const writeStream = createWriteStream(tempPath)
    // Hashed while it streams, so checking a 1.5 GB file costs no second read.
    const hash = model.sha256 ? createHash('sha256') : null
    let received = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hash?.update(value)
      await new Promise<void>((resolve, reject) => {
        writeStream.write(value, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      received += value.length
      if (contentLength > 0) {
        onProgress(received / contentLength, false)
      }
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Thrown before the rename, so the caller deletes the temp file and nothing that
    // differs from what was mirrored is ever installed.
    if (hash && model.sha256) {
      const actual = hash.digest('hex')
      if (actual !== model.sha256) {
        log('model-manager', 'sha256 mismatch', {
          modelId: model.id,
          expected: model.sha256,
          actual,
        })
        throw new Error(CHECKSUM_MISMATCH_MESSAGE)
      }
    }
  }

  private async downloadParakeetModel(
    model: SpeechModel,
    destDir: string,
    tempDir: string,
    controller: AbortController,
    onProgress: ModelProgressCallback
  ): Promise<void> {
    const repoId = parakeetRepoId(model)
    if (!repoId) throw new Error('Parakeet model missing huggingFaceRepoId')

    const repo = { type: 'model' as const, name: repoId }
    const revision = parakeetRevision(model)
    const pinned = parakeetPinnedFiles()
    const entries: ParakeetRepoFile[] = []

    // The listing supplies sizes for progress and nothing else: what is fetched, and the
    // sha256 it has to match, come from the checked-in table.
    for await (const e of listFiles({ repo, revision, recursive: true })) {
      controller.signal.throwIfAborted()
      const sha256 = e.type === 'file' ? pinned.get(e.path) : undefined
      if (sha256) {
        entries.push({ path: e.path, size: e.lfs?.size ?? e.size, sha256 })
      }
    }

    // Refused here rather than installed: an install missing any of these reads as not
    // installed, or fails at load, so it would only offer the same broken download again.
    const listed = new Set(entries.map((entry) => entry.path))
    const missing = [...pinned.keys()].filter((path) => !listed.has(path))
    if (missing.length > 0) {
      throw new Error(
        `Parakeet repo ${repoId}@${revision ?? 'main'} is missing: ${missing.join(', ')}`
      )
    }
    if (getPlatformRuntime() !== 'windows') {
      const uncovered = [
        ...MACOS_PARAKEET_COREML_REQUIRED_FILES,
        ...MACOS_PARAKEET_COREML_REQUIRED_DIRS,
      ].filter(
        (name) =>
          !entries.some(
            (entry) => entry.path === name || entry.path.startsWith(name + '/')
          )
      )
      if (uncovered.length > 0) {
        throw new Error(
          `Parakeet Core ML checksums pin nothing for: ${uncovered.join(', ')}`
        )
      }
    }

    const totalBytes = entries.reduce((s, e) => s + e.size, 0) || 1
    let received = 0

    mkdirSync(tempDir, { recursive: true })

    // A file the current install already holds, matching its pinned sha256, is linked into
    // the new install instead of fetched, which is what makes a top-up cost only what is
    // missing. macOS only: the top-up exists for pre-0.17.7 Core ML installs, and on Windows
    // every ONNX file is fetched.
    const reuseInstalled =
      getPlatformRuntime() !== 'windows' && existsSync(destDir)

    const CONCURRENCY = 6
    let nextIdx = 0
    const downloadOne = async () => {
      while (nextIdx < entries.length) {
        controller.signal.throwIfAborted()
        const ent = entries[nextIdx++]
        const installedPath = join(destDir, ent.path)
        if (
          reuseInstalled &&
          (await installedFileMatches(installedPath, ent))
        ) {
          controller.signal.throwIfAborted()
          const outPath = join(tempDir, ent.path)
          mkdirSync(dirname(outPath), { recursive: true })
          linkSync(installedPath, outPath)
          received += ent.size
          onProgress(Math.min(1, received / totalBytes), false)
          continue
        }
        const blob = await downloadFile({ repo, revision, path: ent.path })
        if (blob === null) {
          throw new Error(
            `Parakeet repo ${repoId}@${revision ?? 'main'} has no ${ent.path}`
          )
        }

        controller.signal.throwIfAborted()
        const outPath = join(tempDir, ent.path)
        mkdirSync(dirname(outPath), { recursive: true })
        const writeStream = createWriteStream(outPath)
        const nodeReadable = Readable.fromWeb(
          blob.stream() as import('stream/web').ReadableStream
        )
        // Hashed while it streams, as in `downloadSingleFileModel`. A mismatch throws before
        // the temp directory is renamed, so the caller deletes it and nothing is installed.
        const hash = createHash('sha256')
        await pipeline(
          nodeReadable,
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              hash.update(chunk)
              yield chunk
            }
          },
          writeStream,
          { signal: controller.signal }
        )
        const actual = hash.digest('hex')
        if (actual !== ent.sha256) {
          log('model-manager', 'sha256 mismatch', {
            modelId: model.id,
            path: ent.path,
            expected: ent.sha256,
            actual,
          })
          throw new Error(CHECKSUM_MISMATCH_MESSAGE)
        }

        received += ent.size
        onProgress(Math.min(1, received / totalBytes), false)
      }
    }
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, entries.length) },
      () => downloadOne()
    )
    await Promise.all(workers)

    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true })
    }
    renameSync(tempDir, destDir)
  }

  /**
   * Complete, at boot, a Parakeet install that is only missing what a FluidAudio upgrade
   * added (`MACOS_PARAKEET_COREML_TOP_UP_DIRS`), before anything reads availability.
   *
   * It has to run there, between `reconcileInstalls()` and `AppConfig.load()`: the heal pass
   * in `load()` switches the Speech Model away from anything that reads as not installed, so
   * fetching later - on the next Parakeet use, or from the install check, which is a
   * question and never a write - would land after the switch it exists to avoid. Boot waits
   * for it, bounded by `timeoutMs`, and it is the ordinary `downloadModel` underneath, so a
   * failure is logged and handled exactly like any other failed download: the install stays
   * incomplete, the heal pass switches and announces as it does for missing weights, and
   * Download in Settings retries the same top-up.
   */
  async topUpInstalls(timeoutMs: number): Promise<void> {
    if (getPlatformRuntime() === 'windows') return
    for (const model of SPEECH_MODELS) {
      if (model.engine !== PARAKEET_ENGINE_ID) continue
      const dir = this.getParakeetInstallDir(model.id)
      if (!parakeetCoreMlNeedsTopUp(dir)) continue
      log('model-manager', 'topping up Parakeet install', {
        modelId: model.id,
        dir,
        revision: model.huggingFaceRevision,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const finished = new Promise<void>((resolve) => {
        void this.downloadModel(model.id, (_fraction, done) => {
          if (done) resolve()
        })
      })
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log('model-manager', 'Parakeet top-up timed out', {
            modelId: model.id,
            timeoutMs,
          })
          this.cancelDownload(model.id)
          resolve()
        }, timeoutMs)
      })
      await Promise.race([finished, timedOut])
      clearTimeout(timer)
    }
  }

  async downloadModel(
    modelId: string,
    onProgress: ModelProgressCallback
  ): Promise<void> {
    const model = this.modelInfo(modelId)
    if (!model || model.bundled) {
      onProgress(1, true)
      return
    }

    if (this.isModelAvailable(modelId)) {
      onProgress(1, true)
      return
    }

    mkdirSync(MODELS_DIR, { recursive: true })

    const controller = new AbortController()
    this.downloads.set(modelId, controller)

    if (model.engine === PARAKEET_ENGINE_ID) {
      const destDir = join(MODELS_DIR, parakeetArtifactName(model))
      const tempDir = destDir + '.tmp'
      try {
        if (existsSync(tempDir))
          rmSync(tempDir, { recursive: true, force: true })
        await this.downloadParakeetModel(
          model,
          destDir,
          tempDir,
          controller,
          onProgress
        )
        this.downloads.delete(modelId)
        // A finished download is one of the two moments that owns the write work
        // `isModelAvailable` no longer does. The session memo has to be forgotten first:
        // boot already reconciled this directory, and the files worth reclaiming are the
        // ones that just landed in it.
        this.coreMlCleaned.delete(destDir)
        this.legacyMigrated.delete(destDir)
        this.reconcileInstalls()
        log('model-manager', 'download complete', { modelId })
        onProgress(1, true)
      } catch (err) {
        this.downloads.delete(modelId)
        // One failed file, a checksum mismatch included, stops the other workers too, so
        // none of them writes into the temp directory after it is deleted.
        controller.abort()
        try {
          if (existsSync(tempDir))
            rmSync(tempDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
        const message = downloadErrorMessage(err)
        log('model-manager', 'download failed', { modelId, error: message })
        onProgress(0, true, message)
      }
      return
    }

    const destPath = join(MODELS_DIR, model.artifactName)
    const tempPath = destPath + '.tmp'

    log('model-manager', 'starting download', {
      modelId,
      url: singleFileModelDownloadUrl(model),
    })

    try {
      await this.downloadSingleFileModel(
        model,
        tempPath,
        controller,
        onProgress
      )
      renameSync(tempPath, destPath)
      this.downloads.delete(modelId)
      log('model-manager', 'download complete', { modelId })
      onProgress(1, true)
    } catch (err) {
      this.downloads.delete(modelId)
      try {
        unlinkSync(tempPath)
      } catch {
        // ignore
      }
      const message = downloadErrorMessage(err)
      log('model-manager', 'download failed', { modelId, error: message })
      onProgress(0, true, message)
    }
  }

  cancelDownload(modelId: string): void {
    const controller = this.downloads.get(modelId)
    if (controller) {
      controller.abort()
      this.downloads.delete(modelId)
      log('model-manager', 'download cancelled', { modelId })
    }
  }

  private tryRemoveDownloadedModel(
    modelId: string,
    remove: () => void
  ): boolean {
    try {
      remove()
      log('model-manager', 'model deleted', { modelId })
      return true
    } catch (err) {
      log('model-manager', 'delete failed', { modelId, error: String(err) })
      return false
    }
  }

  deleteModel(modelId: string): boolean {
    const model = this.modelInfo(modelId)
    if (!model || model.bundled) return false
    if (model.engine === PARAKEET_ENGINE_ID) {
      const dir = join(MODELS_DIR, parakeetArtifactName(model))
      // A copy under the old name is the same weights taking the same disk space, so a
      // delete that left it behind would not free what the user asked to free.
      const legacyDir = legacyParakeetInstallDir(model)
      const stale =
        legacyDir !== null && existsSync(legacyDir) ? legacyDir : null
      if (!existsSync(dir) && stale === null) return false
      return this.tryRemoveDownloadedModel(modelId, () => {
        rmSync(dir, { recursive: true, force: true })
        if (stale !== null) rmSync(stale, { recursive: true, force: true })
      })
    }
    const modelPath = join(MODELS_DIR, model.artifactName)
    if (!existsSync(modelPath)) return false
    return this.tryRemoveDownloadedModel(modelId, () => unlinkSync(modelPath))
  }
}

export const modelManager = new ModelManager()
