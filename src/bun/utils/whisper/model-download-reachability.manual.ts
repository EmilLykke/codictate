/**
 * Live-network reachability check for every downloadable Speech Model.
 *
 * This is deliberately outside the default `bun test` run - the `.manual.ts` suffix keeps
 * it out of test discovery. It hits Hugging Face over the network, so it fails on a
 * flaky connection, in an offline CI job and behind a proxy, and it never imports
 * `model-manager.ts`: no bug in `downloadModel` can make it fail. What it does check is
 * real and worth checking on purpose - that the URLs the app builds still resolve and
 * that the hviske Mirror still carries every Quantization.
 *
 * Run it deliberately:
 *
 *   bun run test:manual
 *   bun test ./src/bun/utils/whisper/model-download-reachability.manual.ts
 *
 * The leading `./` matters: without it `bun test` reads the argument as a name filter,
 * finds nothing that matches the default test globs, and exits without running anything.
 *
 * Run it after changing a download URL, a Mirror or the Speech Model list, and before a
 * release.
 */

import { describe, test, expect } from 'bun:test'
import { listFiles, downloadFile } from '@huggingface/hub'
import {
  SPEECH_MODELS,
  hviskeMirrorFileUrl,
} from '../../../shared/speech-models'
import { whisperModelDownloadUrl } from '../../../shared/whisper-models'

const DOWNLOADABLE_MODELS = SPEECH_MODELS.filter((m) => !m.bundled)

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

    // hviske downloads by direct Mirror URL rather than through the whisper.cpp repo, so
    // the exact per-Quantization URL the app builds is what has to be reachable. This also
    // catches a Mirror that lost a Quantization: the repo-level checks below would still
    // pass with four of five files present.
    if (model.engine === 'hviske') {
      test(
        `${model.id}: hviske Mirror download is accessible`,
        async () => {
          const url = hviskeMirrorFileUrl(model.artifactName)
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
