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
  vadImportPath: '/tmp/run/slices.json',
}

const ENGLISH_PROMPT =
  'Hello, this is a dictation. I write in full sentences, with commas where I pause.'
const DANISH_PROMPT =
  'Hej, dette er en diktering. Jeg skriver i hele sætninger, med kommaer hvor jeg holder pause.'

/** The `--prompt` value, or `null` when the argv has none. */
function promptOf(argv: readonly string[]): string | null {
  const at = argv.indexOf('--prompt')
  return at === -1 ? null : argv[at + 1]
}

async function timestampsCommand(
  language: string | null,
  translateToEnglish = false
) {
  return buildWhisperHarnessCommand(
    {
      ...common,
      speechModelId: 'small-q5_1',
      modelPath: '/models/small.bin',
      language,
      translateToEnglish,
    },
    dependencies
  )
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
        '--vad',
        '-vm',
        '/test/bin/ggml-silero-v6.2.0.bin',
        '-vt',
        '0.25',
        '-bs',
        '5',
        '--prompt',
        ENGLISH_PROMPT,
        '-ojf',
        '-of',
        '/tmp/run/transcript',
        '-tr',
      ],
      languageArg: 'auto',
      crispasrBackend: undefined,
      decoding: 'timestamps',
      jsonPath: '/tmp/run/transcript.json',
      vadImportPath: null,
    })
  })

  test('the bundled turbo model decodes with timestamps, the VAD, beam search and a prompt, on no backend', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'large-v3-turbo-q5_0',
        modelPath: '/models/turbo.bin',
        language: 'en',
      },
      dependencies
    )
    expect(command.decoding).toBe('timestamps')
    expect(command.argv).toEqual([
      '/test/bin/crispasr',
      '-m',
      '/models/turbo.bin',
      '-t',
      '8',
      '--language',
      'en',
      '-f',
      '/audio/input.wav',
      '--no-prints',
      '--vad',
      '-vm',
      '/test/bin/ggml-silero-v6.2.0.bin',
      '-vt',
      '0.25',
      '-bs',
      '5',
      '--prompt',
      ENGLISH_PROMPT,
      '-ojf',
      '-of',
      '/tmp/run/transcript',
    ])
  })

  test('the timestamps path fails like nt-vad when the bundled VAD weights are missing', async () => {
    const rejected = buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'large-v3-turbo-q5_0',
        modelPath: '/models/turbo.bin',
        language: 'en',
      },
      {
        ...dependencies,
        resolveVadModel: () => {
          throw new Error('silero-vad is not bundled')
        },
      }
    )
    expect(
      await rejected.then(
        () => '',
        (error) => String(error)
      )
    ).toContain('silero-vad is not bundled')
  })

  test('the prompt follows the Transcription Language: Danish gets the Danish one', async () => {
    expect(promptOf((await timestampsCommand('da')).argv)).toBe(DANISH_PROMPT)
  })

  test('English, auto-detect and Translate to English get the English prompt', async () => {
    expect(promptOf((await timestampsCommand('en')).argv)).toBe(ENGLISH_PROMPT)
    expect(promptOf((await timestampsCommand(null)).argv)).toBe(ENGLISH_PROMPT)
    expect(promptOf((await timestampsCommand('da', true)).argv)).toBe(
      ENGLISH_PROMPT
    )
    expect(promptOf((await timestampsCommand('de', true)).argv)).toBe(
      ENGLISH_PROMPT
    )
  })

  test('any other pinned language gets no prompt, and keeps the VAD and beam search', async () => {
    const command = await timestampsCommand('de')
    expect(command.argv).not.toContain('--prompt')
    expect(command.argv).toContain('--vad')
    expect(command.argv).toContain('-bs')
  })

  test('a stock Whisper Speech Model that failed the long-audio check takes the -nt path on its own cuts', async () => {
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
      '--vad-import',
      '/tmp/run/slices.json',
      '-sns',
      '-bs',
      '5',
      '-ojf',
      '-of',
      '/tmp/run/transcript',
      '-tr',
    ])
    expect(command.crispasrBackend).toBeUndefined()
    expect(command.vadImportPath).toBe('/tmp/run/slices.json')
    expect(command.argv).not.toContain('--prompt')
  })

  test('nt-vad runs no Silero VAD: --vad-import replaces it, so the weights are never asked for', async () => {
    let vadLookups = 0
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'edda-v0.2-q5_0',
        modelPath: '/models/edda.bin',
        language: 'da',
      },
      {
        ...dependencies,
        resolveVadModel: () => {
          vadLookups++
          return '/test/bin/ggml-silero-v6.2.0.bin'
        },
      }
    )
    expect(command.argv).not.toContain('--vad')
    expect(command.argv).not.toContain('-vm')
    expect(command.argv).not.toContain('-vt')
    expect(vadLookups).toBe(0)
  })

  test('nt-vad without a slices file is refused', async () => {
    const rejected = buildWhisperHarnessCommand(
      {
        ...common,
        vadImportPath: undefined,
        speechModelId: 'edda-v0.2-q5_0',
        modelPath: '/models/edda.bin',
        language: 'da',
      },
      dependencies
    )
    expect(
      await rejected.then(
        () => '',
        (error) => String(error)
      )
    ).toContain('needs a --vad-import slices file')
  })

  test('nt-vad decodes greedily when the long-audio check turns beam search off', async () => {
    const command = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'edda-v0.2-q5_0',
        modelPath: '/models/edda.bin',
        language: 'da',
        ntVadBeamSearch: false,
      },
      dependencies
    )
    expect(command.argv).toContain('-sns')
    expect(command.argv).not.toContain('-bs')
  })

  test('the slices file is ignored off nt-vad', async () => {
    const timestamps = await timestampsCommand('en')
    expect(timestamps.argv).not.toContain('--vad-import')
    expect(timestamps.argv).not.toContain('-sns')
    expect(timestamps.vadImportPath).toBeNull()
    const hviske = await buildWhisperHarnessCommand(
      {
        ...common,
        speechModelId: 'hviske-v5-tiny-q5_0',
        modelPath: '/models/hviske.gguf',
        language: 'da',
        crispasrBackend: 'cohere',
      },
      dependencies
    )
    expect(hviske.argv).not.toContain('--vad-import')
    expect(hviske.vadImportPath).toBeNull()
  })

  test("Edda keeps -nt on --backend whisper and decodes Codictate's slices", async () => {
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
      '--vad-import',
      '/tmp/run/slices.json',
      '-sns',
      '-bs',
      '5',
      '-ojf',
      '-of',
      '/tmp/run/transcript',
    ])
    expect(command.jsonPath).toBe('/tmp/run/transcript.json')
  })

  test('an unknown Speech Model id is unchecked, so it takes the nt-vad path', async () => {
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
        vadImportPath: 'C:\\Temp\\codictate-crispasr-x\\slices.json',
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
      'C:\\Temp\\codictate-crispasr-x\\slices.json'
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
