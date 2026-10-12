import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commandLineEndpoint,
  readHiddenLaunchMarker,
  removeHiddenLaunchMarker,
  hiddenLaunchMarkerPath,
  isFreshHiddenLaunchMarker,
  MAX_SOCKET_PATH_BYTES,
  prepareSocketDir,
  privateDirProblem,
} from './endpoint'

describe('commandLineEndpoint', () => {
  test('macOS: a socket per bundle identifier under run/', () => {
    expect(
      commandLineEndpoint({
        platform: 'darwin',
        appDataDir: '/Users/me/Library/Application Support/codictate',
        identifier: 'app.codictate.canary',
        username: 'me',
        uid: 501,
      })
    ).toEqual({
      kind: 'unix-socket',
      runDir: '/Users/me/Library/Application Support/codictate/run',
      socketDir: '/Users/me/Library/Application Support/codictate/run',
      path: '/Users/me/Library/Application Support/codictate/run/app.codictate.canary.sock',
      lockPath:
        '/Users/me/Library/Application Support/codictate/run/app.codictate.canary.lock',
      uid: 501,
    })
  })

  // The client's `app::socket_path` test pins the same boundary.
  test('macOS: a socket path past 103 UTF-8 bytes moves to /tmp/codictate-<uid>', () => {
    const endpointFor = (appDataDir: string) =>
      commandLineEndpoint({
        platform: 'darwin',
        appDataDir,
        identifier: 'app.codictate',
        username: 'me',
        uid: 501,
      })
    const suffix = '/run/app.codictate.sock'
    const fits = '/U' + 'x'.repeat(MAX_SOCKET_PATH_BYTES - suffix.length - 2)
    expect(Buffer.byteLength(fits + suffix)).toBe(103)
    expect(endpointFor(fits).path).toBe(fits + suffix)

    const tooLong = endpointFor(fits + 'x')
    expect(tooLong).toMatchObject({
      socketDir: '/tmp/codictate-501',
      path: '/tmp/codictate-501/app.codictate.sock',
      // The lock and the marker stay in <data>/run.
      runDir: `${fits}x/run`,
      lockPath: `${fits}x/run/app.codictate.lock`,
    })

    // Bytes, not characters: a two-byte letter tips the same length over.
    const accented = fits.slice(0, -1) + 'é'
    expect(accented.length).toBe(fits.length)
    expect(endpointFor(accented)).toMatchObject({
      socketDir: '/tmp/codictate-501',
    })
  })

  test('Windows: a named pipe per identifier and user', () => {
    expect(
      commandLineEndpoint({
        platform: 'win32',
        appDataDir: 'C:\\Users\\me\\AppData\\Local\\codictate',
        identifier: 'app.codictate',
        username: 'me',
        uid: -1,
      })
    ).toEqual({ kind: 'named-pipe', path: '\\\\.\\pipe\\app.codictate.me' })
  })
})

describe('hidden launch marker', () => {
  const now = 1_760_000_000_000

  test('fresh means a millisecond timestamp under 60 s old', () => {
    expect(isFreshHiddenLaunchMarker(String(now - 59_000), now)).toBe(true)
    expect(isFreshHiddenLaunchMarker(`${now}\n`, now)).toBe(true)
    expect(isFreshHiddenLaunchMarker(String(now - 60_000), now)).toBe(false)
    expect(isFreshHiddenLaunchMarker(String(now + 60_000), now)).toBe(false)
    expect(isFreshHiddenLaunchMarker('soon', now)).toBe(false)
    expect(isFreshHiddenLaunchMarker('', now)).toBe(false)
  })

  const dir = mkdtempSync(join(tmpdir(), 'codictate-hidden-launch-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('is read without being deleted, so a racing second instance sees it too', () => {
    const path = hiddenLaunchMarkerPath(dir, 'app.codictate')
    expect(path).toBe(join(dir, 'run', 'app.codictate.hidden-launch'))
    const marker = join(dir, 'marker')

    writeFileSync(marker, String(now - 1_000))
    expect(readHiddenLaunchMarker(marker, now)).toBe(true)
    expect(readHiddenLaunchMarker(marker, now)).toBe(true)
    removeHiddenLaunchMarker(marker)
    expect(existsSync(marker)).toBe(false)

    writeFileSync(marker, String(now - 120_000))
    expect(readHiddenLaunchMarker(marker, now)).toBe(false)

    removeHiddenLaunchMarker(marker)
    expect(readHiddenLaunchMarker(marker, now)).toBe(false)
    removeHiddenLaunchMarker(marker)
  })
})

describe.skipIf(process.platform === 'win32')(
  'private socket directory',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'codictate-socket-dir-'))
    afterAll(() => rmSync(root, { recursive: true, force: true }))
    const uid = process.getuid!()

    test('missing is fine (the app creates it); ours with 0700 is fine', () => {
      expect(privateDirProblem(join(root, 'missing'), uid)).toBeNull()
      const dir = join(root, 'ours')
      mkdirSync(dir, { mode: 0o700 })
      chmodSync(dir, 0o700)
      expect(privateDirProblem(dir, uid)).toBeNull()
    })

    test('refused: another owner, any other mode, a symlink or a file', () => {
      const dir = join(root, 'loose')
      mkdirSync(dir)
      chmodSync(dir, 0o755)
      expect(privateDirProblem(dir, uid)).toContain('mode 0755, not 0700')
      chmodSync(dir, 0o700)
      expect(privateDirProblem(dir, uid + 1)).toContain(`owned by uid ${uid}`)

      const link = join(root, 'link')
      symlinkSync(dir, link)
      expect(privateDirProblem(link, uid)).toContain('not a directory')

      const file = join(root, 'file')
      writeFileSync(file, '')
      expect(privateDirProblem(file, uid)).toContain('not a directory')
    })

    function endpointIn(socketDir: string) {
      return {
        kind: 'unix-socket' as const,
        runDir: join(root, 'data', 'run'),
        socketDir,
        path: join(socketDir, 'app.codictate.sock'),
        lockPath: join(root, 'data', 'run', 'app.codictate.lock'),
        uid,
      }
    }

    test('the server creates the fallback directory 0700, and refuses one it did not make private', () => {
      const fresh = join(root, 'fallback-fresh')
      prepareSocketDir(endpointIn(fresh))
      expect(statSync(fresh).mode & 0o7777).toBe(0o700)
      expect(statSync(join(root, 'data', 'run')).mode & 0o7777).toBe(0o700)
      // Again, now that it exists.
      prepareSocketDir(endpointIn(fresh))

      const planted = join(root, 'fallback-planted')
      mkdirSync(planted)
      chmodSync(planted, 0o777)
      expect(() => prepareSocketDir(endpointIn(planted))).toThrow(
        'mode 0777, not 0700'
      )
      // Refused, not repaired.
      expect(statSync(planted).mode & 0o7777).toBe(0o777)
    })
  }
)
