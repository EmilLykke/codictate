// Downloads and removes GGUF models used by the cross-platform formatter.
// Supports the two Qwen tiers and S1-mini by Superwhisper.

import {
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  createWriteStream,
} from 'fs'
import { dirname } from 'path'
import { createHash } from 'node:crypto'
import { getFormatterModelConfig } from '../../platform/runtime'
import type { FormatterModelTier } from '../../../shared/types'
import { log } from '../logger'

export type FormatterModelProgressCallback = (
  fraction: number,
  done: boolean,
  error?: string
) => void

export type FormatterModelStatus =
  | { state: 'installed'; path: string; bytes: number }
  | { state: 'missing' }
  | { state: 'downloading'; fraction: number }

function downloadErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'Cancelled'
  if (err instanceof Error) return err.message
  return 'Download failed'
}

class FormatterModelManager {
  private controller: AbortController | null = null
  private currentFraction: number = 0

  isInstalled(tier: FormatterModelTier): boolean {
    return existsSync(getFormatterModelConfig(tier).path)
  }

  getStatus(tier: FormatterModelTier): FormatterModelStatus {
    if (this.controller) {
      return { state: 'downloading', fraction: this.currentFraction }
    }
    const config = getFormatterModelConfig(tier)
    if (this.isInstalled(tier)) {
      const file = Bun.file(config.path)
      return { state: 'installed', path: config.path, bytes: file.size }
    }
    return { state: 'missing' }
  }

  async download(
    tier: FormatterModelTier,
    onProgress: FormatterModelProgressCallback
  ): Promise<void> {
    const config = getFormatterModelConfig(tier)

    if (this.isInstalled(tier)) {
      onProgress(1, true)
      return
    }
    if (this.controller) {
      onProgress(this.currentFraction, false)
      return
    }

    mkdirSync(dirname(config.path), { recursive: true })

    const controller = new AbortController()
    this.controller = controller
    this.currentFraction = 0

    const tempPath = config.path + '.tmp'

    log('formatter-model-manager', 'starting download', {
      tier,
      url: config.url,
      dest: config.path,
    })

    try {
      const response = await fetch(config.url, { signal: controller.signal })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      const contentLength =
        Number(response.headers.get('Content-Length') ?? '0') ||
        config.expectedSizeBytes

      const reader = response.body.getReader()
      const writeStream = createWriteStream(tempPath)
      const hash = createHash('sha256')
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
        hash.update(value)
        received += value.length
        this.currentFraction = Math.min(1, received / contentLength)
        onProgress(this.currentFraction, false)
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end((err?: Error | null) => {
          if (err) reject(err)
          else resolve()
        })
      })

      const digest = hash.digest('hex')
      if (config.sha256 && digest !== config.sha256) {
        throw new Error(
          `Checksum mismatch for ${config.displayName}: expected ${config.sha256}, received ${digest}`
        )
      }

      renameSync(tempPath, config.path)
      log('formatter-model-manager', 'download complete', { path: config.path })
      onProgress(1, true)
    } catch (err) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // best effort
      }
      const message = downloadErrorMessage(err)
      log('formatter-model-manager', 'download failed', { error: message })
      onProgress(0, true, message)
    } finally {
      this.controller = null
      this.currentFraction = 0
    }
  }

  cancel(): void {
    if (this.controller) {
      this.controller.abort()
      log('formatter-model-manager', 'download cancelled')
    }
  }

  delete(tier: FormatterModelTier): boolean {
    const config = getFormatterModelConfig(tier)
    if (!this.isInstalled(tier)) return false
    try {
      unlinkSync(config.path)
      log('formatter-model-manager', 'model deleted', { tier })
      return true
    } catch (err) {
      log('formatter-model-manager', 'delete failed', { error: String(err) })
      return false
    }
  }
}

export const formatterModelManager = new FormatterModelManager()
