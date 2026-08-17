import { describe, test, expect } from 'bun:test'
import { listFiles, downloadFile } from '@huggingface/hub'
import { SPEECH_MODELS } from '../../../shared/speech-models'
import { whisperModelDownloadUrl } from '../../../shared/whisper-models'

/**
 * hviske is prep-only and its Mirror repo has not been created yet (a maintainer has to
 * run `scripts/mirror-hviske.ts` first - see docs/HVISKE_MIRROR.md), so asserting the
 * repo is reachable would assert something that is deliberately not true yet. Drop the
 * `engine !== 'hviske'` filter once the Mirror exists.
 */
const DOWNLOADABLE_MODELS = SPEECH_MODELS.filter(
  (m) => !m.bundled && m.engine !== 'hviske'
)

describe('model downloads', () => {
  for (const model of DOWNLOADABLE_MODELS) {
    if (model.engine === 'whisper_cpp') {
      test(
        `${model.id}: whisper.cpp download is accessible`,
        async () => {
          const url = whisperModelDownloadUrl(model.artifactName)
          const res = await fetch(url, { method: 'HEAD' })
          expect(res.status).toBe(200)
          const size = Number(res.headers.get('Content-Length') ?? '0')
          expect(size).toBeGreaterThan(0)
        },
        { timeout: 15_000 }
      )
    }

    if (model.huggingFaceRepoId) {
      const repoId = model.huggingFaceRepoId

      test(
        `${model.id}: HuggingFace repo is accessible and has files`,
        async () => {
          const repo = { type: 'model' as const, name: repoId }
          const files: string[] = []
          for await (const entry of listFiles({ repo, recursive: true })) {
            if (entry.type === 'file' && entry.path !== '.gitattributes') {
              files.push(entry.path)
            }
            if (files.length >= 3) break
          }
          expect(files.length).toBeGreaterThan(0)
        },
        { timeout: 15_000 }
      )

      test(
        `${model.id}: downloadFile returns a readable Blob`,
        async () => {
          const repo = { type: 'model' as const, name: repoId }
          let firstFile: string | null = null
          for await (const entry of listFiles({ repo, recursive: true })) {
            if (
              entry.type === 'file' &&
              entry.path !== '.gitattributes' &&
              (entry.lfs?.size ?? entry.size) < 1_000_000
            ) {
              firstFile = entry.path
              break
            }
          }
          expect(firstFile).not.toBeNull()

          const blob = await downloadFile({ repo, path: firstFile! })
          expect(blob).not.toBeNull()
          expect(blob).toBeInstanceOf(Blob)
          expect(blob!.size).toBeGreaterThan(0)

          const stream = blob!.stream()
          expect(stream).toBeDefined()
          const reader = stream.getReader()
          const { done, value } = await reader.read()
          expect(done).toBe(false)
          expect(value?.length).toBeGreaterThan(0)
          reader.releaseLock()
        },
        { timeout: 30_000 }
      )
    }
  }
})
