import { describe, expect, test } from 'bun:test'
import {
  buildWhisperHarnessCommand,
  type WhisperHarnessCommandDependencies,
} from './whisper-harness-command'

const dependencies: WhisperHarnessCommandDependencies = {
  resolveBinary: async () => '/test/bin/crispasr',
  threadCount: () => 8,
  resolveVadModel: () => '/test/bin/ggml-silero-v6.2.0.bin',
}

const common = {
  audioPath: '/audio/input.wav',
  jsonOutputBase: '/tmp/run/transcript',
}

describe('buildWhisperHarnessCommand', () => {
  test('a checked stock Whisper Speech Model decodes with timestamps, translating', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'small-q5_1',
        modelPath: '/models/small.bin',
        language: null,
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
        '/models/small.bin',
        '-t',
        '8',
        '--language',
        'auto',
        '-f',
        '/audio/input.wav',
        '--no-prints',
        '-ojf',
        '-of',
        '/tmp/run/transcript',
        '-tr',
      ],
      languageArg: 'auto',
      crispasrBackend: undefined,
      decoding: 'timestamps',
      jsonPath: '/tmp/run/transcript.json',
    })
  })

  test('the bundled turbo model decodes with timestamps and never asks for the VAD', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'large-v3-turbo-q5_0',
        modelPath: '/models/turbo.bin',
        language: 'en',
      },
      {
        ...dependencies,
        resolveVadModel: () => {
          throw new Error('VAD resolved on the timestamps path')
        },
      }
    )
    expect(command.decoding).toBe('timestamps')
    expect(command.argv).not.toContain('-nt')
    expect(command.argv).not.toContain('--vad')
    expect(command.argv.slice(-4)).toEqual([
      '--no-prints',
      '-ojf',
      '-of',
      '/tmp/run/transcript',
    ])
  })

  test('a stock Whisper Speech Model not yet checked takes the -nt and VAD path', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'large-v3',
        modelPath: '/models/large-v3-f16.bin',
        language: 'da',
        translateToEnglish: true,
      },
      dependencies
    )
    expect(command.decoding).toBe('nt-vad')
    expect(command.argv).toEqual([
      '/test/bin/crispasr',
      '--backend',
      'whisper',
      '-m',
      '/models/large-v3-f16.bin',
      '-t',
      '8',
      '--language',
      'da',
      '-f',
      '/audio/input.wav',
      '--no-prints',
      '-nt',
      '--vad',
      '-vm',
      '/test/bin/ggml-silero-v6.2.0.bin',
      '-ojf',
      '-of',
      '/tmp/run/transcript',
      '-tr',
    ])
    expect(command.crispasrBackend).toBeUndefined()
  })

  test('Edda keeps -nt on --backend whisper with the bundled Silero VAD', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'edda-v0.2-q5_0',
        modelPath: '/models/edda.bin',
        language: 'da',
      },
      dependencies
    )
    expect(command.decoding).toBe('nt-vad')
    expect(command.argv).toEqual([
      '/test/bin/crispasr',
      '--backend',
      'whisper',
      '-m',
      '/models/edda.bin',
      '-t',
      '8',
      '--language',
      'da',
      '-f',
      '/audio/input.wav',
      '--no-prints',
      '-nt',
      '--vad',
      '-vm',
      '/test/bin/ggml-silero-v6.2.0.bin',
      '-ojf',
      '-of',
      '/tmp/run/transcript',
    ])
    expect(command.jsonPath).toBe('/tmp/run/transcript.json')
  })

  test('an unknown Speech Model id is unchecked, so it takes the VAD path', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'not-a-model',
        modelPath: '/models/x.bin',
        language: 'en',
      },
      dependencies
    )
    expect(command.decoding).toBe('nt-vad')
  })

  test('hviske pins the cohere backend before the common crispasr arguments', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'hviske-v5-tiny-q5_0',
        modelPath: '/models/hviske.gguf',
        language: 'da',
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
      '-ojf',
      '-of',
      '/tmp/run/transcript',
    ])
    expect(command.crispasrBackend).toBe('cohere')
    expect(command.decoding).toBe('cohere')
  })

  test('a Windows binary and paths pass through unchanged', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        speechModelId: 'edda-v0.2-q8_0',
        modelPath: 'C:\\Users\\A B\\models\\edda.bin',
        language: 'da',
        audioPath: 'C:\\Temp\\in.wav',
        jsonOutputBase: 'C:\\Temp\\codictate-crispasr-x\\transcript',
      },
      {
        resolveBinary: async () =>
          'C:\\Codictate\\native-helpers\\crispasr\\crispasr.exe',
        threadCount: () => 4,
        resolveVadModel: () =>
          'C:\\Codictate\\native-helpers\\crispasr\\ggml-silero-v6.2.0.bin',
      }
    )
    expect(command.argv[0]).toBe(
      'C:\\Codictate\\native-helpers\\crispasr\\crispasr.exe'
    )
    expect(command.argv).toContain(
      'C:\\Codictate\\native-helpers\\crispasr\\ggml-silero-v6.2.0.bin'
    )
    expect(command.jsonPath).toBe(
      'C:\\Temp\\codictate-crispasr-x\\transcript.json'
    )
  })

  test('rejects backend translation before resolving a binary', async () => {
    let resolverCalls = 0
    const rejected = buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'hviske-v5-tiny-q5_0',
        modelPath: '/models/hviske.gguf',
        language: 'da',
        crispasrBackend: 'cohere',
        translateToEnglish: true,
      },
      {
        ...dependencies,
        resolveBinary: async () => {
          resolverCalls++
          return '/test/bin/crispasr'
        },
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
