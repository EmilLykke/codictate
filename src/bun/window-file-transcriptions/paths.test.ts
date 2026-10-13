import { describe, expect, test } from 'bun:test'
import {
  mainWindowNavigationRules,
  splitDialogPaths,
  exportStartFolder,
  parseSaveDialogAnswer,
  saveDialogArgs,
} from './paths'

describe('splitDialogPaths', () => {
  const files = new Set([
    '/a/one.m4a',
    '/a/notes, part 2.m4a',
    '/a/two.wav',
    'C:\\Users\\me\\talk, final.mp3',
  ])
  const isFile = (path: string) => files.has(path)

  test('nothing chosen', () => {
    expect(splitDialogPaths('', isFile)).toEqual([])
  })

  test('rejoins a file name that contains a comma', () => {
    expect(
      splitDialogPaths('/a/one.m4a,/a/notes, part 2.m4a,/a/two.wav', isFile)
    ).toEqual(['/a/one.m4a', '/a/notes, part 2.m4a', '/a/two.wav'])
    expect(splitDialogPaths('C:\\Users\\me\\talk, final.mp3', isFile)).toEqual([
      'C:\\Users\\me\\talk, final.mp3',
    ])
  })

  test('keeps a tail that names no file, so the queue can report it', () => {
    expect(splitDialogPaths('/a/one.m4a,/a/gone.wav', isFile)).toEqual([
      '/a/one.m4a',
      '/a/gone.wav',
    ])
  })
})

describe('mainWindowNavigationRules', () => {
  /** Electrobun's evaluation: `^` blocks, the last matching rule wins, no match allows. */
  function allowed(rules: string[], url: string): boolean {
    let result = true
    for (const rule of rules) {
      const block = rule.startsWith('^')
      const pattern = block ? rule.slice(1) : rule
      const regex = new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
      )
      if (regex.test(url)) result = !block
    }
    return result
  }

  test('a bundled build allows only views://', () => {
    const rules = mainWindowNavigationRules('views://mainview/index.html')
    expect(allowed(rules, 'views://mainview/index.html')).toBe(true)
    expect(allowed(rules, 'file:///Users/me/a.m4a')).toBe(false)
    expect(allowed(rules, 'https://example.com/')).toBe(false)
    expect(allowed(rules, 'http://localhost:5173/')).toBe(false)
    expect(allowed(rules, 'about:blank')).toBe(false)
  })

  test('HMR dev also allows the dev server it was pointed at', () => {
    const rules = mainWindowNavigationRules('http://localhost:5173')
    expect(allowed(rules, 'http://localhost:5173')).toBe(true)
    expect(allowed(rules, 'http://localhost:5173/')).toBe(true)
    expect(allowed(rules, 'http://localhost:5173/src/main.tsx')).toBe(true)
    expect(allowed(rules, 'views://mainview/index.html')).toBe(true)
    expect(allowed(rules, 'http://localhost:5174/')).toBe(false)
    expect(allowed(rules, 'file:///tmp/a.wav')).toBe(false)
  })

  test('a remote view URL is never allowlisted', () => {
    expect(mainWindowNavigationRules('https://example.com/')).toEqual([
      '^*',
      'views://*',
    ])
  })
})

describe('exportStartFolder', () => {
  const folders = new Set(['/Users/me', '/Users/me/Exports', '/Users/me/Talks'])
  const isDirectory = (path: string) => folders.has(path)

  test('the last export folder first', () => {
    expect(
      exportStartFolder({
        lastExportFolder: '/Users/me/Exports',
        sourceFolder: '/Users/me/Talks',
        homeFolder: '/Users/me',
        isDirectory,
      })
    ).toBe('/Users/me/Exports')
  })

  test("then the file's own folder, then home", () => {
    expect(
      exportStartFolder({
        lastExportFolder: '/Volumes/Gone',
        sourceFolder: '/Users/me/Talks',
        homeFolder: '/Users/me',
        isDirectory,
      })
    ).toBe('/Users/me/Talks')
    expect(
      exportStartFolder({
        lastExportFolder: null,
        sourceFolder: '/Volumes/Card',
        homeFolder: '/Users/me',
        isDirectory,
      })
    ).toBe('/Users/me')
    expect(
      exportStartFolder({
        lastExportFolder: null,
        sourceFolder: null,
        homeFolder: '/Users/me',
        isDirectory,
      })
    ).toBe('/Users/me')
  })

  test('a dropped file has no folder of its own: the last export folder, else home', () => {
    expect(
      exportStartFolder({
        lastExportFolder: '/Users/me/Exports',
        sourceFolder: null,
        homeFolder: '/Users/me',
        isDirectory,
      })
    ).toBe('/Users/me/Exports')
    expect(
      exportStartFolder({
        lastExportFolder: '/Volumes/Gone',
        sourceFolder: null,
        homeFolder: '/Users/me',
        isDirectory,
      })
    ).toBe('/Users/me')
  })
})

describe('the Save dialog helper', () => {
  test('the same flags on both platforms, spaces and all', () => {
    expect(
      saveDialogArgs({
        defaultName: 'board call.srt',
        directory: 'C:\\Users\\me\\Talks, 2026',
        extension: 'srt',
      })
    ).toEqual([
      'save-dialog',
      '--name',
      'board call.srt',
      '--directory',
      'C:\\Users\\me\\Talks, 2026',
      '--extension',
      'srt',
      '--title',
      'Save Transcript',
    ])
  })

  test('a path is the choice and a cancel is null', () => {
    expect(
      parseSaveDialogAnswer('{"path":"/Users/me/Talks, 2026/board call.srt"}\n')
    ).toBe('/Users/me/Talks, 2026/board call.srt')
    expect(
      parseSaveDialogAnswer('{"path":"C:\\\\Users\\\\me\\\\talk.vtt"}')
    ).toBe('C:\\Users\\me\\talk.vtt')
    expect(parseSaveDialogAnswer('{"cancelled":true}\n')).toBeNull()
  })

  test('anything else is an error, never a quiet cancel', () => {
    for (const stdout of [
      '',
      'not json',
      '{}',
      '{"cancelled":false}',
      '{"path":""}',
      '{"path":42}',
      'null',
    ]) {
      expect(() => parseSaveDialogAnswer(stdout)).toThrow(
        'The Save dialog gave no answer'
      )
    }
  })
})
