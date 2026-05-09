import { join, dirname } from 'path'
import {
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  createWriteStream,
  readdirSync,
  rmSync,
} from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'node:stream'
import { downloadFile, listFiles } from '@huggingface/hub'
import {
  SPEECH_MODELS,
  getSpeechModel,
  type SpeechModel,
} from '../../../shared/speech-models'
import { whisperModelDownloadUrl } from '../../../shared/whisper-models'
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

const WINDOWS_PARAKEET_ONNX_REPO_ID = 'istupakov/parakeet-tdt-0.6b-v3-onnx'
const WINDOWS_PARAKEET_ONNX_ARTIFACT_NAME = 'parakeet-tdt-0.6b-v3-onnx'
const WINDOWS_PARAKEET_ONNX_REQUIRED_FILES = [
  'encoder-model.onnx',
  'encoder-model.onnx.data',
  'decoder_joint-model.onnx',
  'vocab.txt',
] as const

const MACOS_PARAKEET_COREML_REQUIRED_DIRS = [
  'Preprocessor.mlmodelc',
  'Encoder.mlmodelc',
  'Decoder.mlmodelc',
  'JointDecision.mlmodelc',
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

function parakeetCoreMlInstallComplete(dir: string): boolean {
  if (!existsSync(dir)) return false
  const vocab =
    existsSync(join(dir, 'parakeet_vocab.json')) ||
    existsSync(join(dir, 'parakeet_v3_vocab.json'))
  if (!vocab) return false
  try {
    return readdirSync(dir).some((name) => name.endsWith('.mlmodelc'))
  } catch {
    return false
  }
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
  return model.artifactName
}

function parakeetRepoId(model: SpeechModel): string | undefined {
  if (getPlatformRuntime() === 'windows') return WINDOWS_PARAKEET_ONNX_REPO_ID
  return model.huggingFaceRepoId
}

class ModelManager {
  private downloads = new Map<string, AbortController>()
  private coreMlCleaned = new Set<string>()

  private modelInfo(modelId: string): SpeechModel | undefined {
    return getSpeechModel(modelId)
  }

  isModelAvailable(modelId: string): boolean {
    const model = this.modelInfo(modelId)
    if (!model) return false
    if (model.bundled) return true
    if (model.engine === 'whisperkit') {
      const dir = this.getParakeetInstallDir(modelId)
      if (!parakeetInstallComplete(dir)) return false
      if (!this.coreMlCleaned.has(dir)) {
        cleanupParakeetCoreMlInstall(dir)
        this.coreMlCleaned.add(dir)
      }
      return true
    }
    return existsSync(join(MODELS_DIR, model.artifactName))
  }

  getModelPath(modelId: string): string {
    const model = this.modelInfo(modelId)
    if (!model) throw new Error(`Unknown speech model: ${modelId}`)
    if (model.engine === 'whisperkit') {
      return this.getParakeetInstallDir(modelId)
    }
    if (model.bundled) return BUNDLED_MODEL_PATH
    return join(MODELS_DIR, model.artifactName)
  }

  /** Directory passed to the platform Parakeet helper (Core ML on macOS, ONNX on Windows). */
  getParakeetInstallDir(modelId: string): string {
    const model = this.modelInfo(modelId)
    if (!model || model.engine !== 'whisperkit') {
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

  private async downloadWhisperCppModel(
    model: SpeechModel,
    _destPath: string,
    tempPath: string,
    controller: AbortController,
    onProgress: ModelProgressCallback
  ): Promise<void> {
    const url = whisperModelDownloadUrl(model.artifactName)
    log('model-manager', 'starting whisper.cpp download', {
      modelId: model.id,
      url,
    })

    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    const contentLength = Number(response.headers.get('Content-Length') ?? '0')
    const reader = response.body.getReader()
    const writeStream = createWriteStream(tempPath)
    let received = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
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
    const entries: { path: string; size: number }[] = []

    for await (const e of listFiles({ repo, recursive: true })) {
      controller.signal.throwIfAborted()
      if (
        e.type === 'file' &&
        e.path !== '.gitattributes' &&
        shouldDownloadParakeetFile(e.path)
      ) {
        const size = e.lfs?.size ?? e.size
        entries.push({ path: e.path, size })
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

    const totalBytes = entries.reduce((s, e) => s + e.size, 0) || 1
    let received = 0

    mkdirSync(tempDir, { recursive: true })

    const CONCURRENCY = 6
    let nextIdx = 0
    const downloadOne = async () => {
      while (nextIdx < entries.length) {
        controller.signal.throwIfAborted()
        const ent = entries[nextIdx++]
        const blob = await downloadFile({ repo, path: ent.path })
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

    if (model.engine === 'whisperkit') {
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
      url: whisperModelDownloadUrl(model.artifactName),
    })

    try {
      await this.downloadWhisperCppModel(
        model,
        destPath,
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
    if (model.engine === 'whisperkit') {
      const dir = join(MODELS_DIR, parakeetArtifactName(model))
      if (!existsSync(dir)) return false
      return this.tryRemoveDownloadedModel(modelId, () =>
        rmSync(dir, { recursive: true, force: true })
      )
    }
    const modelPath = join(MODELS_DIR, model.artifactName)
    if (!existsSync(modelPath)) return false
    return this.tryRemoveDownloadedModel(modelId, () => unlinkSync(modelPath))
  }
}

export const modelManager = new ModelManager()
