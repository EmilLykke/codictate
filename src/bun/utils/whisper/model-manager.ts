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
const WINDOWS_PARAKEET_ONNX_REQUIRED_FILES = [
  'encoder-model.onnx',
  'encoder-model.onnx.data',
  'decoder_joint-model.onnx',
  'vocab.txt',
] as const

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

function shouldDownloadParakeetFile(path: string): boolean {
  if (getPlatformRuntime() === 'windows') {
    return (WINDOWS_PARAKEET_ONNX_REQUIRED_FILES as readonly string[]).includes(
      path
    )
  }
  if (
    (MACOS_PARAKEET_COREML_REQUIRED_FILES as readonly string[]).includes(path)
  )
    return true
  return MACOS_PARAKEET_COREML_REQUIRED_DIRS.some(
    (dir) => path === dir || path.startsWith(dir + '/')
  )
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
 * the download re-verifies each file against the pinned revision anyway). So a 12.6 MB
 * fetch makes them complete, where reading them as missing would cost a 483 MB download and
 * a heal pass that switches the user's Speech Model away.
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
  size: number
  /** Git blob id, for a file stored in the repo itself. */
  gitOid?: string
  /** sha256 of the content, for a file stored in LFS. */
  lfsSha256?: string
}

/**
 * Whether a file already installed is byte-for-byte the one the pinned revision lists, so
 * the download can keep it instead of fetching it again. Checked by content, not size: a
 * re-exported Core ML weight file can keep its size and change every value in it.
 */
async function installedFileMatches(
  path: string,
  file: ParakeetRepoFile
): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size !== file.size) return false
  let hash
  let expected
  if (file.lfsSha256) {
    hash = createHash('sha256')
    expected = file.lfsSha256
  } else if (file.gitOid) {
    hash = createHash('sha1').update(`blob ${file.size}\0`)
    expected = file.gitOid
  } else {
    return false
  }
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex') === expected
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

/** The catalog's pinned commit names a commit in the Core ML repo, so it is macOS only. */
function parakeetRevision(model: SpeechModel): string | undefined {
  if (getPlatformRuntime() === 'windows') return undefined
  return model.huggingFaceRevision
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
        throw new Error(
          'The downloaded file did not match the expected checksum. Try the download again.'
        )
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
    const entries: ParakeetRepoFile[] = []

    for await (const e of listFiles({ repo, revision, recursive: true })) {
      controller.signal.throwIfAborted()
      if (
        e.type === 'file' &&
        e.path !== '.gitattributes' &&
        shouldDownloadParakeetFile(e.path)
      ) {
        entries.push({
          path: e.path,
          size: e.lfs?.size ?? e.size,
          gitOid: e.lfs ? undefined : e.oid,
          lfsSha256: e.lfs?.oid,
        })
      }
    }

    if (getPlatformRuntime() === 'windows') {
      const found = new Set(entries.map((entry) => entry.path))
      for (const required of WINDOWS_PARAKEET_ONNX_REQUIRED_FILES) {
        if (!found.has(required)) {
          throw new Error(
            `Parakeet ONNX repo missing required file: ${required}`
          )
        }
      }
    }

    // Refused here rather than installed: an install missing any of these reads as not
    // installed, so it would only offer the same broken download again.
    if (getPlatformRuntime() !== 'windows') {
      const missing = [
        'parakeet_vocab.json',
        ...MACOS_PARAKEET_COREML_REQUIRED_DIRS,
      ].filter(
        (name) =>
          !entries.some(
            (entry) => entry.path === name || entry.path.startsWith(name + '/')
          )
      )
      if (missing.length > 0) {
        throw new Error(
          `Parakeet Core ML repo ${repoId}@${revision ?? 'main'} is missing: ${missing.join(', ')}`
        )
      }
    }

    const totalBytes = entries.reduce((s, e) => s + e.size, 0) || 1
    let received = 0

    mkdirSync(tempDir, { recursive: true })

    // A file the current install already holds at the pinned revision is linked into the new
    // install instead of fetched, which is what makes a top-up cost only what is missing.
    // macOS only: the Windows ONNX download is left exactly as it was.
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
          const outPath = join(tempDir, ent.path)
          mkdirSync(dirname(outPath), { recursive: true })
          linkSync(installedPath, outPath)
          received += ent.size
          onProgress(Math.min(1, received / totalBytes), false)
          continue
        }
        const blob = await downloadFile({ repo, revision, path: ent.path })
        if (blob === null) continue

        controller.signal.throwIfAborted()
        const outPath = join(tempDir, ent.path)
        mkdirSync(dirname(outPath), { recursive: true })
        const writeStream = createWriteStream(outPath)
        const nodeReadable = Readable.fromWeb(
          blob.stream() as import('stream/web').ReadableStream
        )
        await pipeline(nodeReadable, writeStream, {
          signal: controller.signal,
        })

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
