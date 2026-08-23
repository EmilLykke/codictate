import { describe, expect, it } from 'bun:test'
import { stderrTail } from './drain-stream'

describe('stderrTail', () => {
  it('returns short stderr whole, trimmed', () => {
    expect(stderrTail('  could not load model\n')).toBe('could not load model')
  })

  it('keeps the end, not the beginning', () => {
    // Model-load chatter first, the reason last. Taking the head would report the chatter.
    const noise = 'loading weights\n'.repeat(200)
    const tail = stderrTail(`${noise}fatal: no such device`)
    expect(tail).toContain('fatal: no such device')
    expect(tail.startsWith('...')).toBe(true)
  })

  it('caps the length it hands to a console', () => {
    expect(stderrTail('x'.repeat(5000)).length).toBe(603)
  })

  it('is empty when the engine said nothing, so a caller can fall back', () => {
    expect(stderrTail('   \n  ')).toBe('')
  })
})
