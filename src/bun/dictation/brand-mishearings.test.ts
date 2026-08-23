import { describe, expect, it } from 'bun:test'
import { fixBrandMishearings } from './brand-mishearings'

/**
 * The table shipped for years with no test at all, which is part of why it drifted into the
 * benchmark: nothing pinned what it was for. These pin the two halves that matter - it does
 * rewrite the product name, and it does not rewrite anything else.
 */
describe('fixBrandMishearings', () => {
  it('leaves a transcript with no mishearing alone', () => {
    const text = 'Send the report to Anna before Friday.'
    expect(fixBrandMishearings(text)).toBe(text)
  })

  it('leaves the empty string a silent Dictation produces alone', () => {
    expect(fixBrandMishearings('')).toBe('')
  })

  it('joins a split product name', () => {
    expect(fixBrandMishearings('open code dictate please')).toBe(
      'open Codictate please'
    )
    expect(fixBrandMishearings('co-dictate')).toBe('Codictate')
  })

  it('normalises casing of the product name itself', () => {
    expect(fixBrandMishearings('codictate')).toBe('Codictate')
    expect(fixBrandMishearings('KODICTATE')).toBe('Codictate')
  })

  it('rewrites the Danish-shaped mishearings', () => {
    expect(fixBrandMishearings('jeg bruger kodigtede hver dag')).toBe(
      'jeg bruger Codictate hver dag'
    )
    expect(fixBrandMishearings('ko digtet')).toBe('Codictate')
    expect(fixBrandMishearings('kodiktat')).toBe('Codictate')
  })

  it('rewrites the codec-shaped mishearings', () => {
    expect(fixBrandMishearings('Codec Tate')).toBe('Codictate')
    expect(fixBrandMishearings('codec tape')).toBe('Codictate')
    expect(fixBrandMishearings('codec sheet')).toBe('Codictate')
  })

  it('replaces every occurrence in one transcript', () => {
    expect(fixBrandMishearings('codictate and codec tate and kodiktate')).toBe(
      'Codictate and Codictate and Codictate'
    )
  })

  it('respects word boundaries rather than rewriting inside a longer word', () => {
    expect(fixBrandMishearings('codictates')).toBe('codictates')
    expect(fixBrandMishearings('decodictate')).toBe('decodictate')
  })

  it('leaves a plain codec mention that is not the product name alone', () => {
    const text = 'the video codec is broken'
    expect(fixBrandMishearings(text)).toBe(text)
  })
})
