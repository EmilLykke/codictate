import { describe, expect, test } from 'bun:test'
import {
  CONTRACT_VERSION,
  errorEvent,
  type ServerEvent,
} from '../../shared/command-line-protocol'
import {
  createCommandLineSession,
  type CommandHandlers,
  type HandlerContext,
} from './session'

const notUsed = () => errorEvent('internal', 'not used')

function handlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  return {
    transcribe: notUsed,
    dictate: notUsed,
    stop: notUsed,
    status: notUsed,
    'models.list': notUsed,
    'models.use': notUsed,
    'models.download': notUsed,
    'models.remove': notUsed,
    'languages.list': notUsed,
    'languages.use': notUsed,
    'app.show': () => ({ type: 'result' }),
    ...overrides,
  }
}

function harness(h: CommandHandlers) {
  const sent: ServerEvent[] = []
  let ends = 0
  const errors: unknown[] = []
  const session = createCommandLineSession(
    h,
    {
      send: (event) => sent.push(event),
      end: () => {
        ends += 1
      },
    },
    (_command, err) => errors.push(err)
  )
  return {
    session,
    sent,
    errors,
    get ends() {
      return ends
    },
  }
}

const line = (command: string, args: object = {}) =>
  JSON.stringify({ contractVersion: CONTRACT_VERSION, command, args })

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A handler that stays running until the test lets it go. */
function pending() {
  let context!: HandlerContext
  let finish!: () => void
  // Typed `never` so it can stand in for any command's handler; what it resolves to is
  // never sent in these tests.
  const handler = (_request: unknown, ctx: HandlerContext): Promise<never> => {
    context = ctx
    return new Promise<never>((resolve) => {
      finish = () => resolve({ type: 'result' } as never)
    })
  }
  return {
    handler,
    get context() {
      return context
    },
    finish: () => finish(),
  }
}

describe('command-line session', () => {
  test('a malformed first line is a usage error, then the end', () => {
    const h = harness(handlers())
    h.session.receiveLine('{nope')
    expect(h.sent).toEqual([
      {
        type: 'error',
        code: 'usage',
        message: 'The request is not valid JSON',
      },
    ])
    expect(h.ends).toBe(1)
  })

  test('a different contract version is contract_mismatch', () => {
    const h = harness(handlers())
    h.session.receiveLine(
      JSON.stringify({ contractVersion: 9, command: 'status' })
    )
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({
      type: 'error',
      code: 'contract_mismatch',
    })
    expect(h.ends).toBe(1)
  })

  test('dispatches by command and ends with its result', async () => {
    const h = harness(handlers())
    h.session.receiveLine(line('app.show'))
    await tick()
    expect(h.sent).toEqual([{ type: 'result' }])
    expect(h.ends).toBe(1)
  })

  test('events before the result, nothing after it', async () => {
    let context!: HandlerContext
    const h = harness(
      handlers({
        'app.show': (_request, ctx) => {
          context = ctx
          ctx.emit({ type: 'queued', position: 1 })
          return { type: 'result' }
        },
      })
    )
    h.session.receiveLine(line('app.show'))
    await tick()
    context.emit({ type: 'queued', position: 2 })
    h.session.receiveLine(line('app.show'))
    expect(h.sent).toEqual([
      { type: 'queued', position: 1 },
      { type: 'result' },
    ])
    expect(h.ends).toBe(1)
  })

  test('a handler that throws is internal', async () => {
    const h = harness(
      handlers({
        status: () => {
          throw new Error('boom')
        },
      })
    )
    h.session.receiveLine(line('status'))
    await tick()
    expect(h.sent).toEqual([
      { type: 'error', code: 'internal', message: 'status failed' },
    ])
    expect(h.errors).toHaveLength(1)
  })

  test('a cancel line aborts the handler and ends with cancelled, once', async () => {
    const p = pending()
    const h = harness(handlers({ transcribe: p.handler }))
    h.session.receiveLine(line('transcribe', { file: '/a.wav' }))
    await tick()
    expect(p.context.signal.aborted).toBe(false)
    h.session.receiveLine('{"type":"cancel"}')
    expect(p.context.signal.aborted).toBe(true)
    p.finish()
    await tick()
    expect(h.sent).toEqual([
      { type: 'error', code: 'cancelled', message: 'Cancelled' },
    ])
    expect(h.ends).toBe(1)
  })

  test('disconnecting aborts the handler and sends nothing', async () => {
    const p = pending()
    const h = harness(handlers({ transcribe: p.handler }))
    h.session.receiveLine(line('transcribe', { file: '/a.wav' }))
    await tick()
    h.session.disconnected()
    expect(p.context.signal.aborted).toBe(true)
    p.finish()
    await tick()
    expect(h.sent).toEqual([])
  })

  test('stop lines reach dictate only', async () => {
    const dictate = pending()
    const h = harness(handlers({ dictate: dictate.handler }))
    h.session.receiveLine(
      line('dictate', { output: 'stdout', raw: false, until: 'enter' })
    )
    await tick()
    let stops = 0
    dictate.context.onStop(() => (stops += 1))
    h.session.receiveLine('{"type":"stop"}')
    h.session.receiveLine('garbage')
    expect(stops).toBe(1)

    const other = pending()
    const h2 = harness(handlers({ transcribe: other.handler }))
    h2.session.receiveLine(line('transcribe', { file: '/a.wav' }))
    await tick()
    let otherStops = 0
    other.context.onStop(() => (otherStops += 1))
    h2.session.receiveLine('{"type":"stop"}')
    expect(otherStops).toBe(0)
    expect(other.context.signal.aborted).toBe(false)
  })

  test('a stop that arrives before dictate listens is delivered when it does', async () => {
    const dictate = pending()
    const h = harness(handlers({ dictate: dictate.handler }))
    h.session.receiveLine(
      line('dictate', { output: 'stdout', raw: false, until: 'enter' })
    )
    h.session.receiveLine('{"type":"stop"}')
    await tick()
    let stops = 0
    dictate.context.onStop(() => (stops += 1))
    expect(stops).toBe(1)
  })

  test('fail ends a running command with the error', async () => {
    const p = pending()
    const h = harness(handlers({ transcribe: p.handler }))
    h.session.receiveLine(line('transcribe', { file: '/a.wav' }))
    await tick()
    h.session.fail(errorEvent('usage', 'too long'))
    expect(p.context.signal.aborted).toBe(true)
    expect(h.sent).toEqual([
      { type: 'error', code: 'usage', message: 'too long' },
    ])
    expect(h.ends).toBe(1)
  })
})
