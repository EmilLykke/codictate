import { describe, expect, test } from 'bun:test'
import {
  appendDirToWindowsPath,
  classifyLink,
  clientCandidates,
  decideInstall,
  decideRemove,
  decideUserPathWrite,
  encodePowerShellCommand,
  isTransientAppLocation,
  looksLikeCodictateClient,
  parseMarkedShellOutput,
  parseUserPathRead,
  pathListsDir,
  pathSetupFor,
  SHELL_PATH_MARKER,
  tildify,
  userPathWriteEnv,
} from './command-line-install'

const CLIENT =
  '/Applications/Codictate.app/Contents/Resources/app/bin/codictate'

describe('clientCandidates', () => {
  test('bundle first, then a cargo release build per checkout root', () => {
    expect(
      clientCandidates('macos', '/App/Contents/Resources/app', ['/repo'])
    ).toEqual([
      '/App/Contents/Resources/app/bin/codictate',
      '/repo/native/codictate-cli/target/release/codictate',
    ])
  })

  test('Windows looks for codictate.exe', () => {
    expect(clientCandidates('windows', '/app', [])[0]).toEndWith(
      'codictate.exe'
    )
  })
})

describe('classifyLink', () => {
  test('nothing there', () => {
    expect(classifyLink({ kind: 'missing' }, CLIENT)).toBe('not-installed')
  })

  test('a symlink to this app is installed', () => {
    expect(classifyLink({ kind: 'symlink', target: CLIENT }, CLIENT)).toBe(
      'installed'
    )
  })

  test('a symlink to another Codictate can be replaced', () => {
    const canary =
      '/Applications/Codictate Canary.app/Contents/Resources/app/bin/codictate'
    expect(classifyLink({ kind: 'symlink', target: canary }, CLIENT)).toBe(
      'other-codictate'
    )
    expect(
      classifyLink(
        {
          kind: 'symlink',
          target: '/src/codictate/native/codictate-cli/target/debug/codictate',
        },
        CLIENT
      )
    ).toBe('other-codictate')
  })

  test('a symlink elsewhere or a regular file is foreign', () => {
    expect(
      classifyLink(
        { kind: 'symlink', target: '/usr/local/bin/codictate' },
        CLIENT
      )
    ).toBe('foreign')
    expect(classifyLink({ kind: 'other' }, CLIENT)).toBe('foreign')
  })

  test('without a client of our own, a Codictate symlink is another one', () => {
    expect(classifyLink({ kind: 'symlink', target: CLIENT }, null)).toBe(
      'other-codictate'
    )
  })
})

describe('looksLikeCodictateClient', () => {
  test('matches bundled and cargo-built clients, on both platforms', () => {
    expect(looksLikeCodictateClient(CLIENT)).toBe(true)
    expect(
      looksLikeCodictateClient(
        'C:\\Users\\a\\AppData\\Local\\app.codictate\\stable\\app\\Resources\\app\\bin\\codictate.exe'
      )
    ).toBe(true)
    expect(looksLikeCodictateClient('/opt/homebrew/bin/codictate')).toBe(false)
  })
})

describe('decideInstall', () => {
  test('creates when nothing is there', () => {
    expect(decideInstall('not-installed', CLIENT, false)).toBe('create')
  })

  test('asks before replacing another Codictate, then replaces', () => {
    expect(decideInstall('other-codictate', CLIENT, false)).toBe(
      'confirm-replace'
    )
    expect(decideInstall('other-codictate', CLIENT, true)).toBe('replace')
  })

  test('never overwrites a foreign file, even when asked to replace', () => {
    expect(decideInstall('foreign', CLIENT, true)).toBe('refuse-foreign')
  })

  test('is a no-op when already installed', () => {
    expect(decideInstall('installed', CLIENT, false)).toBe('already-installed')
  })

  test('needs a client to link to', () => {
    expect(decideInstall('not-installed', null, false)).toBe('no-client')
  })

  test('refuses to link to a translocated or disk-image app', () => {
    const translocated =
      '/private/var/folders/xy/T/AppTranslocation/ABC/d/Codictate.app/Contents/Resources/app/bin/codictate'
    expect(decideInstall('not-installed', translocated, false)).toBe(
      'move-to-applications'
    )
    expect(
      decideInstall(
        'other-codictate',
        '/Volumes/Codictate/Codictate.app/Contents/Resources/app/bin/codictate',
        true
      )
    ).toBe('move-to-applications')
  })
})

describe('decideRemove', () => {
  test('only removes our own symlink', () => {
    expect(decideRemove('installed')).toBe(true)
    expect(decideRemove('other-codictate')).toBe(false)
    expect(decideRemove('foreign')).toBe(false)
    expect(decideRemove('not-installed')).toBe(false)
  })
})

describe('parseMarkedShellOutput', () => {
  test('reads the PATH between markers, ignoring banners around it', () => {
    const out = `Welcome!\n${SHELL_PATH_MARKER}/a:/b${SHELL_PATH_MARKER}\nbye`
    expect(parseMarkedShellOutput(out)).toBe('/a:/b')
  })

  test('null until both markers are there', () => {
    expect(parseMarkedShellOutput('nothing')).toBeNull()
    expect(parseMarkedShellOutput(`${SHELL_PATH_MARKER}/a:/b`)).toBeNull()
  })

  test('an empty PATH is a PATH', () => {
    expect(
      parseMarkedShellOutput(`${SHELL_PATH_MARKER}${SHELL_PATH_MARKER}`)
    ).toBe('')
  })
})

describe('pathListsDir', () => {
  test('POSIX: exact entry, trailing slash tolerated', () => {
    const home = '/Users/me'
    expect(
      pathListsDir('/usr/bin:/Users/me/.local/bin/', `${home}/.local/bin`, {
        windows: false,
      })
    ).toBe(true)
    expect(
      pathListsDir('/usr/bin:/Users/me/.local/binx', `${home}/.local/bin`, {
        windows: false,
      })
    ).toBe(false)
  })

  test('Windows: case-insensitive, expands %VAR%, ignores trailing backslash', () => {
    const dir =
      'C:\\Users\\Me\\AppData\\Local\\app.codictate\\stable\\app\\Resources\\app\\bin'
    expect(
      pathListsDir(
        '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%LOCALAPPDATA%\\APP.CODICTATE\\stable\\app\\Resources\\app\\bin\\',
        dir,
        {
          windows: true,
          env: { LOCALAPPDATA: 'C:\\Users\\Me\\AppData\\Local' },
        }
      )
    ).toBe(true)
    expect(pathListsDir('C:\\Windows', dir, { windows: true })).toBe(false)
  })
})

describe('pathSetupFor', () => {
  test('zsh and bash get the export line in their rc file', () => {
    expect(pathSetupFor('/bin/zsh')).toEqual({
      line: 'export PATH="$HOME/.local/bin:$PATH"',
      where: 'Add this line to ~/.zshrc',
    })
    expect(pathSetupFor('/opt/homebrew/bin/bash').where).toBe(
      'Add this line to ~/.bash_profile'
    )
  })

  test('fish gets fish_add_path', () => {
    expect(pathSetupFor('/opt/homebrew/bin/fish').line).toBe(
      'fish_add_path ~/.local/bin'
    )
  })

  test('no SHELL falls back to zsh, the macOS default', () => {
    expect(pathSetupFor(undefined).where).toBe('Add this line to ~/.zshrc')
  })
})

describe('parseUserPathRead', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

  test('decodes a non-ASCII value without touching the console code page', () => {
    const value = '%USERPROFILE%\\bin;C:\\Users\\Søren\\Tools;C:\\Ünïcødé'
    expect(parseUserPathRead(`1\r\nExpandString\r\n${b64(value)}\r\n`)).toEqual(
      { exists: true, kind: 'ExpandString', value }
    )
  })

  test('an empty value is an empty Path', () => {
    expect(parseUserPathRead('1\nString\n\n')).toEqual({
      exists: true,
      kind: 'String',
      value: '',
    })
  })

  test('a missing value is reported as missing', () => {
    expect(parseUserPathRead('0\n\n\n')).toEqual({ exists: false })
  })

  test('null for anything else, so a garbled read never becomes a write', () => {
    expect(parseUserPathRead('')).toBeNull()
    expect(parseUserPathRead('ERROR: something')).toBeNull()
    expect(parseUserPathRead('1\nExpandString\nnot base64!\n')).toBeNull()
    expect(parseUserPathRead('1\n')).toBeNull()
  })
})

describe('decideUserPathWrite', () => {
  const DIR = 'C:\\Users\\Søren\\AppData\\Local\\app.codictate\\bin'

  test('appends to a Path with non-ASCII entries and keeps them intact', () => {
    expect(
      decideUserPathWrite(
        {
          exists: true,
          kind: 'ExpandString',
          value: 'C:\\Users\\Søren\\Tools;',
        },
        DIR
      )
    ).toEqual({
      action: 'write',
      value: `C:\\Users\\Søren\\Tools;${DIR}`,
      kind: 'ExpandString',
    })
  })

  test('keeps a REG_SZ Path as REG_SZ', () => {
    const decision = decideUserPathWrite(
      { exists: true, kind: 'String', value: 'C:\\a' },
      DIR
    )
    expect(decision).toEqual({
      action: 'write',
      value: `C:\\a;${DIR}`,
      kind: 'String',
    })
  })

  test('nothing to do when listed, case-insensitively and with a trailing backslash', () => {
    expect(
      decideUserPathWrite(
        {
          exists: true,
          kind: 'ExpandString',
          value: `C:\\a;${DIR.toUpperCase()}\\`,
        },
        DIR
      )
    ).toEqual({ action: 'already-listed' })
  })

  test('creates a missing Path as ExpandString', () => {
    expect(decideUserPathWrite({ exists: false }, DIR)).toEqual({
      action: 'write',
      value: DIR,
      kind: 'ExpandString',
    })
  })

  test('never overwrites a Path of another kind', () => {
    for (const kind of ['MultiString', 'Binary', 'DWord', 'Unknown']) {
      expect(
        decideUserPathWrite({ exists: true, kind, value: '' }, DIR)
      ).toEqual({ action: 'unsupported-kind' })
    }
  })
})

describe('userPathWriteEnv', () => {
  test('carries the expected and next values as ASCII base64 UTF-8', () => {
    const env = userPathWriteEnv(
      { exists: true, kind: 'ExpandString', value: 'C:\\Søren' },
      'C:\\Søren;C:\\bin',
      'ExpandString'
    )
    expect(env.CODICTATE_PATH_EXISTED).toBe('1')
    expect(env.CODICTATE_PATH_KIND).toBe('ExpandString')
    for (const value of Object.values(env)) {
      expect(/^[\x20-\x7e]*$/.test(value)).toBe(true)
    }
    expect(
      Buffer.from(env.CODICTATE_PATH_EXPECTED!, 'base64').toString('utf8')
    ).toBe('C:\\Søren')
    expect(
      Buffer.from(env.CODICTATE_PATH_NEXT!, 'base64').toString('utf8')
    ).toBe('C:\\Søren;C:\\bin')
  })

  test('a missing Path is expected to stay missing', () => {
    const env = userPathWriteEnv({ exists: false }, 'C:\\bin', 'ExpandString')
    expect(env.CODICTATE_PATH_EXISTED).toBe('0')
    expect(env.CODICTATE_PATH_EXPECTED).toBe('')
  })
})

describe('encodePowerShellCommand', () => {
  test('is base64 UTF-16LE', () => {
    expect(encodePowerShellCommand("'ø'")).toBe(
      Buffer.from("'ø'", 'utf16le').toString('base64')
    )
    expect(
      Buffer.from(encodePowerShellCommand('$a = 1'), 'base64').toString(
        'utf16le'
      )
    ).toBe('$a = 1')
  })
})

describe('isTransientAppLocation', () => {
  test('a translocated app or one on a disk image will not last', () => {
    expect(
      isTransientAppLocation(
        '/private/var/folders/xy/T/AppTranslocation/ABC-123/d/Codictate.app/Contents/Resources/app/bin/codictate'
      )
    ).toBe(true)
    expect(
      isTransientAppLocation(
        '/Volumes/Codictate/Codictate.app/Contents/Resources/app/bin/codictate'
      )
    ).toBe(true)
  })

  test('Applications and a source checkout are fine', () => {
    expect(isTransientAppLocation(CLIENT)).toBe(false)
    expect(
      isTransientAppLocation(
        '/Users/me/src/codictate/native/codictate-cli/target/release/codictate'
      )
    ).toBe(false)
  })
})

describe('appendDirToWindowsPath', () => {
  test('appends with one separator', () => {
    expect(appendDirToWindowsPath('C:\\a;', 'C:\\bin')).toBe('C:\\a;C:\\bin')
    expect(appendDirToWindowsPath('', 'C:\\bin')).toBe('C:\\bin')
  })

  test('leaves the value alone when the directory is already listed', () => {
    expect(appendDirToWindowsPath('c:\\BIN\\;C:\\a', 'C:\\bin')).toBe(
      'c:\\BIN\\;C:\\a'
    )
  })
})

describe('tildify', () => {
  test('shortens paths under home only', () => {
    expect(tildify('/Users/me/.local/bin/codictate', '/Users/me')).toBe(
      '~/.local/bin/codictate'
    )
    expect(tildify('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x')
  })
})
