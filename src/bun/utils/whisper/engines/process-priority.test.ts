import { describe, expect, test } from 'bun:test'
import { LOW_PROCESS_PRIORITY, lowerProcessPriority } from './process-priority'

describe('lowerProcessPriority', () => {
  test('asks for nice 10, which Windows maps to BELOW_NORMAL', () => {
    const calls: [number, number][] = []
    expect(
      lowerProcessPriority(4211, 'test', (pid, priority) =>
        calls.push([pid, priority])
      )
    ).toBe(true)
    expect(LOW_PROCESS_PRIORITY).toBe(10)
    expect(calls).toEqual([[4211, 10]])
  })

  test('a refused call is reported, not thrown', () => {
    expect(
      lowerProcessPriority(4211, 'test', () => {
        throw new Error('ESRCH')
      })
    ).toBe(false)
  })
})
