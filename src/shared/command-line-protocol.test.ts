import { describe, expect, test } from 'bun:test'
import {
  CONTRACT_VERSION,
  EXIT_CODE_BY_ERROR,
  encodeLine,
  isErrorCode,
  parseControlLine,
  parseRequestLine,
  publicEngineName,
  type CommandRequest,
  type DictateResult,
  type ErrorEvent,
  type LanguagesListResult,
  type LanguagesUseResult,
  type ModelsListResult,
  type ProgressLikeEvent,
  type SpeechModelIdResult,
  type StatusResult,
  type StopResult,
  type TranscribeResult,
} from './command-line-protocol'

function request(command: string, args: unknown, extra: object = {}) {
  return JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    command,
    args,
    ...extra,
  })
}

function expectUsage(line: string) {
  const parsed = parseRequestLine(line)
  expect(parsed.ok).toBe(false)
  if (!parsed.ok) expect(parsed.error.code).toBe('usage')
}

describe('parseRequestLine', () => {
  test('reads the docs/CLI.md transcribe request', () => {
    const line =
      '{"contractVersion":1,"command":"transcribe","args":{"file":"/abs/path/memo.m4a","speechModelId":null,"languageId":null,"translate":null,"format":null},"caller":{"name":"Terminal","pid":4211}}'
    const expected: CommandRequest = {
      contractVersion: 1,
      command: 'transcribe',
      args: {
        file: '/abs/path/memo.m4a',
        speechModelId: null,
        languageId: null,
        translate: null,
        format: null,
      },
      caller: { name: 'Terminal', pid: 4211 },
    }
    expect(parseRequestLine(line)).toEqual({ ok: true, request: expected })
  })

  test('optional transcribe args may be absent or set', () => {
    const parsed = parseRequestLine(
      request('transcribe', {
        file: '/a.wav',
        speechModelId: 'large-v3-q5_0',
      })
    )
    expect(parsed).toEqual({
      ok: true,
      request: {
        contractVersion: 1,
        command: 'transcribe',
        args: {
          file: '/a.wav',
          speechModelId: 'large-v3-q5_0',
          languageId: null,
          translate: null,
          format: null,
        },
        caller: null,
      },
    })
  })

  test('a request from a client that predates translate and format reads both as null', () => {
    const parsed = parseRequestLine(
      '{"contractVersion":1,"command":"transcribe","args":{"file":"/a.wav","speechModelId":null,"languageId":null}}'
    )
    expect(parsed.ok && parsed.request.args).toEqual({
      file: '/a.wav',
      speechModelId: null,
      languageId: null,
      translate: null,
      format: null,
    })
  })

  test('translate and format, when sent', () => {
    for (const translate of [true, false]) {
      for (const format of ['txt', 'srt', 'vtt', 'json'] as const) {
        const parsed = parseRequestLine(
          request('transcribe', { file: '/a.wav', translate, format })
        )
        expect(parsed.ok && parsed.request.args).toMatchObject({
          translate,
          format,
        })
      }
    }
  })

  test('reads every command with its args', () => {
    const cases: [string, unknown, unknown][] = [
      [
        'dictate',
        { output: 'cursor', raw: true, until: 'silence', maxSeconds: 30 },
        {
          output: 'cursor',
          raw: true,
          until: 'silence',
          maxSeconds: 30,
          speechModelId: null,
          languageId: null,
          formattingModeId: null,
        },
      ],
      ['stop', {}, {}],
      ['status', {}, {}],
      ['models.list', { all: true }, { all: true }],
      ['models.use', { id: 'x' }, { id: 'x' }],
      ['models.download', { id: 'x' }, { id: 'x' }],
      ['models.remove', { id: 'x' }, { id: 'x' }],
      ['languages.list', {}, {}],
      ['languages.use', { id: 'da' }, { id: 'da' }],
      ['app.show', {}, {}],
    ]
    for (const [command, args, expected] of cases) {
      const parsed = parseRequestLine(request(command, args))
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.request.command).toBe(
          command as CommandRequest['command']
        )
        expect(parsed.request.args).toEqual(expected as never)
      }
    }
  })

  test('commands without args may omit them', () => {
    const parsed = parseRequestLine(
      JSON.stringify({ contractVersion: 1, command: 'status' })
    )
    expect(parsed.ok).toBe(true)
  })

  test('ignores unknown fields at every level', () => {
    const parsed = parseRequestLine(
      request(
        'models.list',
        { all: false, future: 1 },
        { future: { x: 1 }, caller: { name: 'zsh', pid: 1, tty: 'x' } }
      )
    )
    expect(parsed).toEqual({
      ok: true,
      request: {
        contractVersion: 1,
        command: 'models.list',
        args: { all: false },
        caller: { name: 'zsh', pid: 1 },
      },
    })
  })

  test('a malformed caller reads as null rather than failing', () => {
    const parsed = parseRequestLine(request('status', {}, { caller: 'x' }))
    expect(parsed.ok && parsed.request.caller).toBe(null)
  })

  test('malformed requests are usage errors', () => {
    expectUsage('not json')
    expectUsage('[]')
    expectUsage('null')
    expectUsage(JSON.stringify({ command: 'status', args: {} }))
    expectUsage(JSON.stringify({ contractVersion: '1', command: 'status' }))
    expectUsage(request('nope', {}))
    expectUsage(JSON.stringify({ contractVersion: 1, args: {} }))
    expectUsage(request('status', []))
    expectUsage(request('transcribe', {}))
    expectUsage(request('transcribe', { file: '' }))
    expectUsage(request('transcribe', { file: '/a', speechModelId: 3 }))
    expectUsage(request('transcribe', { file: '/a', translate: 'yes' }))
    expectUsage(request('transcribe', { file: '/a', translate: 1 }))
    expectUsage(request('transcribe', { file: '/a', format: 'docx' }))
    expectUsage(request('transcribe', { file: '/a', format: 'SRT' }))
    expectUsage(request('models.list', {}))
    expectUsage(request('models.use', { id: 1 }))
    expectUsage(
      request('dictate', { output: 'paper', raw: false, until: 'enter' })
    )
    expectUsage(
      request('dictate', {
        output: 'stdout',
        raw: false,
        until: 'enter',
        maxSeconds: -1,
      })
    )
  })

  test('a different contract version is contract_mismatch, even for an unknown command', () => {
    for (const line of [
      JSON.stringify({ contractVersion: 2, command: 'status', args: {} }),
      JSON.stringify({ contractVersion: 2, command: 'future', args: {} }),
      JSON.stringify({ contractVersion: 0, command: 'status', args: {} }),
    ]) {
      const parsed = parseRequestLine(line)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error.code).toBe('contract_mismatch')
    }
  })
})

describe('parseControlLine', () => {
  test('reads stop and cancel, ignores the rest', () => {
    expect(parseControlLine('{"type":"stop"}')).toEqual({ type: 'stop' })
    expect(parseControlLine('{"type":"cancel","why":"x"}')).toEqual({
      type: 'cancel',
    })
    expect(parseControlLine('{"type":"pause"}')).toBe(null)
    expect(parseControlLine('nope')).toBe(null)
    expect(parseControlLine('[]')).toBe(null)
  })
})

describe('error codes', () => {
  test('match the exit code table in docs/CLI.md', () => {
    expect(EXIT_CODE_BY_ERROR).toEqual({
      internal: 1,
      usage: 2,
      unknown_model: 2,
      unknown_language: 2,
      language_not_allowed: 2,
      unknown_formatting_mode: 2,
      model_bundled: 2,
      cannot_translate: 2,
      captions_unavailable: 2,
      input_unreadable: 3,
      no_audio: 3,
      model_not_installed: 4,
      engine_failed: 5,
      app_unavailable: 6,
      command_line_control_off: 7,
      busy: 8,
      not_ready: 9,
      download_failed: 10,
      contract_mismatch: 11,
      cancelled: 130,
    })
  })

  test('isErrorCode', () => {
    expect(isErrorCode('busy')).toBe(true)
    expect(isErrorCode('toString')).toBe(false)
    expect(isErrorCode(2)).toBe(false)
  })
})

test('public engine names', () => {
  expect(publicEngineName('whisper_cpp')).toBe('whisper')
  expect(publicEngineName('whisperkit')).toBe('parakeet')
  expect(publicEngineName('hviske')).toBe('hviske')
})

test('encodeLine is one JSON object and a newline', () => {
  expect(encodeLine({ type: 'queued', position: 2 })).toBe(
    '{"type":"queued","position":2}\n'
  )
})

/**
 * Every JSON example in docs/CLI.md "Events" and "Results", parsed and compared against a
 * literal of the protocol type. A field renamed on either side fails here: the literal stops
 * compiling, or stops matching the document.
 */
describe('docs/CLI.md examples fit the protocol types', () => {
  const roundTrips = <T>(json: string, typed: T) => {
    expect(JSON.parse(json)).toEqual(typed)
    expect(JSON.parse(JSON.stringify(typed))).toEqual(typed)
  }

  test('events', () => {
    const events: [string, ProgressLikeEvent | ErrorEvent][] = [
      ['{"type":"queued","position":2}', { type: 'queued', position: 2 }],
      [
        '{"type":"progress","stage":"decoding","elapsedSeconds":0.4,"audioSeconds":null}',
        {
          type: 'progress',
          stage: 'decoding',
          elapsedSeconds: 0.4,
          audioSeconds: null,
        },
      ],
      [
        '{"type":"progress","stage":"transcribing","elapsedSeconds":12.0,"audioSeconds":3121.5}',
        {
          type: 'progress',
          stage: 'transcribing',
          elapsedSeconds: 12,
          audioSeconds: 3121.5,
        },
      ],
      ['{"type":"recording"}', { type: 'recording' }],
      ['{"type":"transcribing"}', { type: 'transcribing' }],
      [
        '{"type":"download","fraction":0.42}',
        { type: 'download', fraction: 0.42 },
      ],
      [
        '{"type":"error","code":"model_not_installed","message":"Speech Model large-v3-q5_0 is not installed"}',
        {
          type: 'error',
          code: 'model_not_installed',
          message: 'Speech Model large-v3-q5_0 is not installed',
        },
      ],
    ]
    for (const [json, typed] of events) roundTrips(json, typed)
  })

  test('transcribe result', () => {
    const typed: TranscribeResult = {
      type: 'result',
      file: '/abs/path/memo.m4a',
      text: '…',
      language: 'da',
      speechModelId: 'hviske-v5-tiny-q5_0',
      engine: 'hviske',
      audioSeconds: 61.2,
      processingSeconds: 4.8,
      translated: false,
    }
    roundTrips(
      `{"type":"result","file":"/abs/path/memo.m4a","text":"…","language":"da","speechModelId":"hviske-v5-tiny-q5_0",
 "engine":"hviske","audioSeconds":61.2,"processingSeconds":4.8,"translated":false}`,
      typed
    )
  })

  test('transcribe result with --format', () => {
    const typed: TranscribeResult = {
      type: 'result',
      file: '/abs/path/memo.m4a',
      text: 'Hej.',
      language: 'da',
      speechModelId: 'hviske-v5-tiny-q5_0',
      engine: 'hviske',
      audioSeconds: 61.2,
      processingSeconds: 4.8,
      translated: false,
      formatted: '1\n00:00:00,000 --> 00:00:01,200\nHej.\n\n',
    }
    roundTrips(
      `{"type":"result","file":"/abs/path/memo.m4a","text":"Hej.","language":"da","speechModelId":"hviske-v5-tiny-q5_0",
 "engine":"hviske","audioSeconds":61.2,"processingSeconds":4.8,"translated":false,
 "formatted":"1\\n00:00:00,000 --> 00:00:01,200\\nHej.\\n\\n"}`,
      typed
    )
  })

  test('dictate result', () => {
    const typed: DictateResult = {
      type: 'result',
      text: '…',
      rawText: '…',
      formattingMode: 'email',
      pasted: false,
      live: false,
      language: null,
      speechModelId: 'parakeet-tdt-0.6b-v3',
      engine: 'parakeet',
      audioSeconds: 8.4,
    }
    roundTrips(
      `{"type":"result","text":"…","rawText":"…","formattingMode":"email","pasted":false,"live":false,
 "language":null,"speechModelId":"parakeet-tdt-0.6b-v3","engine":"parakeet","audioSeconds":8.4}`,
      typed
    )
  })

  test('stop result', () => {
    const typed: StopResult = { type: 'result', stopped: true }
    roundTrips('{"type":"result","stopped":true}', typed)
  })

  test('status result', () => {
    const typed: StatusResult = {
      type: 'result',
      contractVersion: 1,
      app: {
        version: '0.0.62',
        channel: 'stable',
        identifier: 'app.codictate',
      },
      onboardingCompleted: true,
      microphone: 'granted',
      commandLineControl: false,
      dictation: { active: false, startedBy: null },
      speechModel: {
        id: 'large-v3-turbo-q5_0',
        label: 'Large V3 Turbo',
        engine: 'whisper',
        installed: true,
      },
      transcriptionLanguage: { id: 'auto', label: 'Automatic' },
      fileTranscriptions: { running: 0, queued: 0 },
    }
    roundTrips(
      `{"type":"result","contractVersion":1,
 "app":{"version":"0.0.62","channel":"stable","identifier":"app.codictate"},
 "onboardingCompleted":true,"microphone":"granted","commandLineControl":false,
 "dictation":{"active":false,"startedBy":null},
 "speechModel":{"id":"large-v3-turbo-q5_0","label":"Large V3 Turbo","engine":"whisper","installed":true},
 "transcriptionLanguage":{"id":"auto","label":"Automatic"},
 "fileTranscriptions":{"running":0,"queued":0}}`,
      typed
    )
  })

  test('models list result', () => {
    const typed: ModelsListResult = {
      type: 'result',
      models: [
        {
          id: 'large-v3-turbo-q5_0',
          label: 'Large V3 Turbo',
          engine: 'whisper',
          downloadSizeMB: 574,
          installed: true,
          selected: true,
          curated: true,
          bundled: true,
        },
      ],
    }
    roundTrips(
      `{"type":"result","models":[{"id":"large-v3-turbo-q5_0","label":"Large V3 Turbo","engine":"whisper",
  "downloadSizeMB":574,"installed":true,"selected":true,"curated":true,"bundled":true}]}`,
      typed
    )
  })

  test('models use / download / remove result', () => {
    const typed: SpeechModelIdResult = {
      type: 'result',
      speechModelId: 'parakeet-tdt-0.6b-v3',
    }
    roundTrips(
      '{"type":"result","speechModelId":"parakeet-tdt-0.6b-v3"}',
      typed
    )
  })

  test('languages list result', () => {
    const typed: LanguagesListResult = {
      type: 'result',
      languages: [
        { id: 'auto', label: 'Automatic', selected: true, allowed: true },
      ],
    }
    roundTrips(
      '{"type":"result","languages":[{"id":"auto","label":"Automatic","selected":true,"allowed":true}]}',
      typed
    )
  })

  test('languages use result', () => {
    const typed: LanguagesUseResult = {
      type: 'result',
      transcriptionLanguageId: 'da',
    }
    roundTrips('{"type":"result","transcriptionLanguageId":"da"}', typed)
  })
})
