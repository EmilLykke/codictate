import { describe, expect, test } from 'bun:test'
import type { ModelDownloadProgress } from '../shared/types'
import {
  createModelOperations,
  type SpeechModelStore,
} from './model-operations'

type Progress = (fraction: number, done: boolean, error?: string) => void

/** A weights store whose downloads only move when the test says so. */
class FakeStore implements SpeechModelStore {
  starts: string[] = []
  cancels: string[] = []
  deletes: string[] = []
  deleteAnswer = true
  readonly callbacks = new Map<string, Progress>()

  downloadModel(modelId: string, onProgress: Progress) {
    this.starts.push(modelId)
    this.callbacks.set(modelId, onProgress)
    return Promise.resolve()
  }
  cancelDownload(modelId: string) {
    this.cancels.push(modelId)
    this.callbacks.get(modelId)?.(0, true, 'Cancelled')
  }
  deleteModel(modelId: string) {
    this.deletes.push(modelId)
    return this.deleteAnswer
  }
  report(modelId: string, fraction: number, done = false, error?: string) {
    this.callbacks.get(modelId)!(fraction, done, error)
  }
}

function setup() {
  const store = new FakeStore()
  const pushed: ModelDownloadProgress[] = []
  const availability: { modelId: string; available: boolean }[] = []
  let heals = 0
  const operations = createModelOperations({
    store,
    pushProgress: (p) => pushed.push(p),
    pushAvailability: (a) => availability.push(a),
    onAvailabilityChanged: async () => {
      heals += 1
    },
    log: () => {},
  })
  return {
    store,
    pushed,
    availability,
    operations,
    get heals() {
      return heals
    },
  }
}

describe('createModelOperations', () => {
  test('a second request joins the running download', async () => {
    const s = setup()
    const fromCommandLine = s.operations.download('m', 'command-line')
    const fractions: number[] = []
    fromCommandLine.onProgress((f) => fractions.push(f))
    s.store.report('m', 0.1)
    expect(s.pushed[s.pushed.length - 1]).toMatchObject({
      requestedByWindow: false,
    })

    s.operations.download('m', 'window')
    expect(s.store.starts).toEqual(['m'])
    s.store.report('m', 0.5)
    expect(s.pushed[s.pushed.length - 1]).toMatchObject({
      modelId: 'm',
      progressFraction: 0.5,
      done: false,
      requestedByWindow: true,
    })
    expect(fractions).toEqual([0.1, 0.5])

    s.store.report('m', 1, true)
    expect(await fromCommandLine.result).toEqual({ status: 'installed' })
    expect(s.heals).toBe(1)
  })

  test('the heal pass runs before a finished download settles', async () => {
    const s = setup()
    const download = s.operations.download('m', 'command-line')
    s.store.report('m', 1, true)
    let healsAtSettle = -1
    await download.result.then(() => {
      healsAtSettle = s.heals
    })
    expect(healsAtSettle).toBe(1)
  })

  test('released by its only requester, the download stops', async () => {
    const s = setup()
    const download = s.operations.download('m', 'command-line')
    download.release()
    download.release()
    expect(s.store.cancels).toEqual(['m'])
    expect(await download.result).toEqual({ status: 'cancelled' })
    expect(s.heals).toBe(0)
  })

  test('a window that asked for it keeps it running', () => {
    const s = setup()
    s.operations.download('m', 'window')
    const download = s.operations.download('m', 'command-line')
    download.release()
    expect(s.store.cancels).toEqual([])
  })

  test("the window's Cancel stops it for the command line too", async () => {
    const s = setup()
    const download = s.operations.download('m', 'command-line')
    s.operations.cancelDownload('m')
    expect(await download.result).toEqual({ status: 'cancelled' })
  })

  test('a failure carries its message, and the next request starts afresh', async () => {
    const s = setup()
    const download = s.operations.download('m', 'command-line')
    s.store.report('m', 0, true, 'HTTP 404')
    expect(await download.result).toEqual({
      status: 'failed',
      message: 'HTTP 404',
    })
    s.operations.download('m', 'command-line')
    expect(s.store.starts).toEqual(['m', 'm'])
  })

  describe('a request right after Cancel', () => {
    /**
     * Like `modelManager`: a cancel only aborts, and the download reports and returns later,
     * after it has removed its temp file.
     */
    class SlowCancelStore extends FakeStore {
      readonly returns = new Map<string, (() => void)[]>()
      override downloadModel(modelId: string, onProgress: Progress) {
        this.starts.push(modelId)
        this.callbacks.set(modelId, onProgress)
        return new Promise<void>((resolve) => {
          const list = this.returns.get(modelId) ?? []
          list.push(resolve)
          this.returns.set(modelId, list)
        })
      }
      override cancelDownload(modelId: string) {
        this.cancels.push(modelId)
      }
      /** The oldest download of `modelId` reports `done` and returns. */
      windDown(modelId: string, error?: string) {
        this.callbacks.get(modelId)!(0, true, error)
        this.returns.get(modelId)!.shift()!()
      }
    }

    function slowSetup() {
      const store = new SlowCancelStore()
      const pushed: ModelDownloadProgress[] = []
      const operations = createModelOperations({
        store,
        pushProgress: (p) => pushed.push(p),
        pushAvailability: () => {},
        onAvailabilityChanged: async () => {},
        log: () => {},
      })
      return { store, pushed, operations }
    }

    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }

    test('does not join the cancelled download, and starts once it has wound down', async () => {
      const s = slowSetup()
      const first = s.operations.download('m', 'window')
      s.operations.cancelDownload('m')
      const second = s.operations.download('m', 'window')
      await flush()
      // The cancelled one still holds the store's temp file: nothing new yet.
      expect(s.store.starts).toEqual(['m'])

      s.store.windDown('m', 'Cancelled')
      expect(await first.result).toEqual({ status: 'cancelled' })
      await flush()
      expect(s.store.starts).toEqual(['m', 'm'])

      // A third request joins the fresh download, not the old one.
      const third = s.operations.download('m', 'command-line')
      await flush()
      expect(s.store.starts).toEqual(['m', 'm'])

      s.store.callbacks.get('m')!(1, true)
      expect(await second.result).toEqual({ status: 'installed' })
      expect(await third.result).toEqual({ status: 'installed' })
    })

    test('cancelled again before it began, it never reaches the store', async () => {
      const s = slowSetup()
      s.operations.download('m', 'window')
      s.operations.cancelDownload('m')
      const second = s.operations.download('m', 'window')
      s.operations.cancelDownload('m')
      s.store.windDown('m', 'Cancelled')
      expect(await second.result).toEqual({ status: 'cancelled' })
      await flush()
      expect(s.store.starts).toEqual(['m'])
      expect(s.pushed[s.pushed.length - 1]).toMatchObject({
        modelId: 'm',
        done: true,
      })
    })
  })

  test('remove pushes availability and heals; nothing to delete does neither', async () => {
    const s = setup()
    expect(await s.operations.remove('m')).toBe(true)
    expect(s.availability).toEqual([{ modelId: 'm', available: false }])
    expect(s.heals).toBe(1)
    s.store.deleteAnswer = false
    expect(await s.operations.remove('m')).toBe(false)
    expect(s.heals).toBe(1)
  })
})
