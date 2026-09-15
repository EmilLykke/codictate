import { describe, expect, test } from 'bun:test'
import {
  buildWhisperHarnessCommand,
  type WhisperHarnessCommandDependencies,
} from './whisper-harness-command'

const dependencies: WhisperHarnessCommandDependencies = {
  resolveBinary: async () => '/test/bin/crispasr',
  threadCount: () => 8,
}

describe('buildWhisperHarnessCommand', () => {
  test('builds exact argv for automatic-language translation', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        modelPath: '/models/large-v3.bin',
        language: null,
        audioPath: '/audio/input.wav',
        translateToEnglish: true,
      },
      dependencies
    )

    expect(command).toEqual({
      harness: 'crispasr',
      binary: '/test/bin/crispasr',
      argv: [
        '/test/bin/crispasr',
        '-m',
        '/models/large-v3.bin',
        '-t',
        '8',
        '--language',
        'auto',
        '-f',
        '/audio/input.wav',
        '--no-prints',
        '-nt',
        '-tr',
      ],
      languageArg: 'auto',
      crispasrBackend: undefined,
    })
  })

  test('pins the backend before the common crispasr arguments', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        modelPath: '/models/hviske.gguf',
        language: 'da',
        audioPath: '/audio/input.wav',
        crispasrBackend: 'cohere',
      },
      dependencies
    )

    expect(command.argv).toEqual([
      '/test/bin/crispasr',
      '--backend',
      'cohere',
      '-m',
      '/models/hviske.gguf',
      '-t',
      '8',
      '--language',
      'da',
      '-f',
      '/audio/input.wav',
      '--no-prints',
      '-nt',
    ])
    expect(command.crispasrBackend).toBe('cohere')
  })

  test('rejects backend translation before resolving a binary', async () => {
    let resolverCalls = 0
    const rejected = buildWhisperHarnessCommand(
      {
        modelPath: '/models/hviske.gguf',
        language: 'da',
        audioPath: '/audio/input.wav',
        crispasrBackend: 'cohere',
        translateToEnglish: true,
      },
      {
        resolveBinary: async () => {
          resolverCalls++
          return '/test/bin/crispasr'
        },
        threadCount: () => 8,
      }
    )

    expect(
      await rejected.then(
        () => '',
        (error) => String(error)
      )
    ).toContain(
      'translate to English is not available on the crispasr cohere backend'
    )
    expect(resolverCalls).toBe(0)
  })
})
