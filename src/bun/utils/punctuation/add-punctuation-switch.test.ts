import { describe, expect, test } from 'bun:test'
import type { PunctuationModelDownloadProgress } from '../../../shared/types'
import {
  createAddPunctuationSwitch,
  type PunctuationModelInstall,
} from './add-punctuation-switch'

/** An install that only moves when the test says so. */
function controllableInstall() {
  const calls: { signal: AbortSignal; onProgress: (f: number) => void }[] = []
  let finish: (() => void) | null = null
  let fail: ((err: unknown) => void) | null = null
  const install: PunctuationModelInstall = ({ signal, onProgress }) => {
    calls.push({ signal, onProgress })
    return new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.')
        err.name = 'AbortError'
        reject(err)
      })
    })
  }
  return {
    install,
    calls,
    finish: () => finish!(),
    fail: (err: unknown) => fail!(err),
  }
}

function setup(options: { installed: boolean }) {
  const disk = { installed: options.installed }
  const fake = controllableInstall()
  const pushed: PunctuationModelDownloadProgress[] = []
  const events: string[] = []
  const toggle = createAddPunctuationSwitch({
    isInstalled: () => disk.installed,
    install: (args) => {
      events.push('install')
      return fake.install(args)
    },
    enable: async () => {
      events.push(`enable (installed: ${disk.installed})`)
      return disk.installed
    },
    pushProgress: (p) => {
      pushed.push(p)
      if (p.done) events.push(`done${p.error ? `: ${p.error}` : ''}`)
    },
    log: () => {},
  })
  return { disk, fake, pushed, events, toggle }
}

describe('turning Add punctuation on', () => {
  test('with the Punctuation Model already installed, turns on at once with no download', async () => {
    const { toggle, events } = setup({ installed: true })
    await toggle.turnOn()
    expect(events).toEqual(['enable (installed: true)', 'done'])
  })

  test('without it, downloads first and turns on only after the verified install', async () => {
    const { toggle, fake, disk, events, pushed } = setup({ installed: false })
    const finished = toggle.turnOn()
    await Promise.resolve()
    fake.calls[0].onProgress(0.5)
    expect(events).toEqual(['install'])
    expect(pushed).toEqual([
      { progressFraction: 0, done: false },
      { progressFraction: 0.5, done: false },
    ])

    disk.installed = true
    fake.finish()
    await finished
    expect(events).toEqual(['install', 'enable (installed: true)', 'done'])
  })

  test('a failed download leaves it off and reports the download error', async () => {
    const { toggle, fake, events, pushed } = setup({ installed: false })
    const finished = toggle.turnOn()
    await Promise.resolve()
    fake.fail(new Error('HTTP 404 for https://example'))
    await finished
    expect(events).toEqual(['install', 'done: HTTP 404 for https://example'])
    expect(pushed[pushed.length - 1]).toEqual({
      progressFraction: 0,
      done: true,
      error: 'HTTP 404 for https://example',
    })
  })

  test('a second press while it downloads joins the download', async () => {
    const { toggle, fake, disk, events } = setup({ installed: false })
    const first = toggle.turnOn()
    const second = toggle.turnOn()
    await Promise.resolve()
    disk.installed = true
    fake.finish()
    await Promise.all([first, second])
    expect(fake.calls).toHaveLength(1)
    expect(events).toEqual(['install', 'enable (installed: true)', 'done'])
  })

  test('Cancel stops the download and leaves it off', async () => {
    const { toggle, events } = setup({ installed: false })
    const finished = toggle.turnOn()
    await Promise.resolve()
    toggle.cancel()
    await finished
    expect(events).toEqual(['install', 'done: Cancelled'])
  })

  test('after a failure, pressing again starts a new download', async () => {
    const { toggle, fake, disk, events } = setup({ installed: false })
    const first = toggle.turnOn()
    await Promise.resolve()
    fake.fail(new Error('offline'))
    await first
    const second = toggle.turnOn()
    await Promise.resolve()
    disk.installed = true
    fake.finish()
    await second
    expect(fake.calls).toHaveLength(2)
    expect(events[events.length - 1]).toBe('done')
  })

  test('an install the settings then refuse leaves it off with a reason', async () => {
    const { toggle, fake, events } = setup({ installed: false })
    const finished = toggle.turnOn()
    await Promise.resolve()
    fake.finish()
    await finished
    expect(events).toEqual([
      'install',
      'enable (installed: false)',
      'done: The Danish punctuation model did not install. Try again.',
    ])
  })
})
