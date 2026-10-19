import { describe, expect, test } from 'bun:test'
import {
  mainWindowNavigationRules,
  splitDialogPaths,
  exportStartFolder,
  uniqueExportPath,
  EXPORT_NAME_LIMIT,
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

describe('uniqueExportPath', () => {
  const taken = (...paths: string[]) => {
    const set = new Set(paths)
    return (path: string) => set.has(path)
  }

  test('the plain name when it is free', () => {
    expect(uniqueExportPath('/Users/me/Talks', 'talk.srt', taken())).toBe(
      '/Users/me/Talks/talk.srt'
    )
    expect(uniqueExportPath('/Users/me/Talks/', 'talk.srt', taken())).toBe(
      '/Users/me/Talks/talk.srt'
    )
  })

  test('a number before the extension when it is taken, never a replaced file', () => {
    expect(
      uniqueExportPath(
        '/Users/me/Talks, 2026',
        'board call.srt',
        taken(
          '/Users/me/Talks, 2026/board call.srt',
          '/Users/me/Talks, 2026/board call 2.srt'
        )
      )
    ).toBe('/Users/me/Talks, 2026/board call 3.srt')
  })

  test('only the last extension moves: a.b.srt gives a.b 2.srt', () => {
    expect(uniqueExportPath('/a', 'a.b.srt', taken('/a/a.b.srt'))).toBe(
      '/a/a.b 2.srt'
    )
  })

  test('no extension, or only a leading dot: the number goes at the end', () => {
    expect(uniqueExportPath('/a', 'talk', taken('/a/talk'))).toBe('/a/talk 2')
    expect(uniqueExportPath('/a', '.srt', taken('/a/.srt'))).toBe('/a/.srt 2')
    expect(
      uniqueExportPath('/a', '.notes', taken('/a/.notes', '/a/.notes 2'))
    ).toBe('/a/.notes 3')
  })

  test('a Windows folder is joined with a backslash on any host', () => {
    expect(
      uniqueExportPath(
        'C:\\Users\\me\\Talks',
        'talk.vtt',
        taken('C:\\Users\\me\\Talks\\talk.vtt')
      )
    ).toBe('C:\\Users\\me\\Talks\\talk 2.vtt')
    expect(uniqueExportPath('C:\\', 'talk.vtt', taken())).toBe('C:\\talk.vtt')
    expect(uniqueExportPath('\\\\nas\\share', 'talk.vtt', taken())).toBe(
      '\\\\nas\\share\\talk.vtt'
    )
  })

  test('stops looking after the limit and leaves the refusal to the exclusive write', () => {
    expect(uniqueExportPath('/a', 'talk.txt', () => true)).toBe(
      `/a/talk ${EXPORT_NAME_LIMIT}.txt`
    )
  })
})
