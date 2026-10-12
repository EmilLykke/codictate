/**
 * Putting the `codictate` command on the user's PATH (docs/CLI.md, "Where the client lives").
 *
 * macOS: Settings symlinks `~/.local/bin/codictate` to the client inside this app, then asks
 * the login shell whether `~/.local/bin` is on its PATH (a GUI app does not inherit it).
 * Windows: the installer adds `<install>\Resources\app\bin` to the user's Path; Settings
 * shows whether it is there and can append it for the current user, no admin.
 *
 * The decisions are pure functions at the top, tested in `command-line-install.test.ts`. The
 * filesystem and process work is below them.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { PlatformRuntime } from '../shared/platform'
import type {
  CommandLineInstallResult,
  CommandLineInstallState,
  CommandLineLinkStatus,
} from '../shared/types'
import { getPlatformRuntime } from './platform/runtime'
import { resolveBinary } from './platform/resolve-binary'

// ─── Pure decisions ──────────────────────────────────────────────────────────

export function clientFileName(platform: PlatformRuntime): string {
  return platform === 'windows' ? 'codictate.exe' : 'codictate'
}

/**
 * Where this app's client may be, in priority order: the bundle first, then a release build
 * in a source checkout (dev from source, before post-build has copied it into the bundle).
 */
export function clientCandidates(
  platform: PlatformRuntime,
  bundleRoot: string,
  repositoryRoots: readonly string[]
): string[] {
  const name = clientFileName(platform)
  return [
    join(bundleRoot, 'bin', name),
    ...repositoryRoots.map((root) =>
      join(root, 'native', 'codictate-cli', 'target', 'release', name)
    ),
  ]
}

/** What `lstat` found at the symlink location. */
export type LinkEntry =
  { kind: 'missing' } | { kind: 'symlink'; target: string } | { kind: 'other' }

/**
 * Whether a path is some Codictate's client: the bundled one in any copy of the app, or a
 * cargo build of it. Used to decide that replacing a symlink loses the user nothing.
 */
export function looksLikeCodictateClient(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return (
    /\/Resources\/app\/bin\/codictate(\.exe)?$/.test(normalized) ||
    /\/codictate-cli\/target\/[^/]+\/codictate(\.exe)?$/.test(normalized)
  )
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

export function classifyLink(
  entry: LinkEntry,
  clientPath: string | null
): CommandLineLinkStatus {
  if (entry.kind === 'missing') return 'not-installed'
  if (entry.kind === 'other') return 'foreign'
  if (clientPath !== null && samePath(entry.target, clientPath)) {
    return 'installed'
  }
  return looksLikeCodictateClient(entry.target) ? 'other-codictate' : 'foreign'
}

export type InstallDecision =
  | 'create'
  | 'replace'
  | 'already-installed'
  | 'confirm-replace'
  | 'refuse-foreign'
  | 'no-client'
  | 'move-to-applications'

/** `realClientPath` is the client with symlinks resolved, which is what the link points at. */
export function decideInstall(
  link: CommandLineLinkStatus,
  realClientPath: string | null,
  replace: boolean
): InstallDecision {
  if (realClientPath === null) return 'no-client'
  if (link !== 'installed' && isTransientAppLocation(realClientPath)) {
    return 'move-to-applications'
  }
  switch (link) {
    case 'installed':
      return 'already-installed'
    case 'not-installed':
      return 'create'
    case 'other-codictate':
      return replace ? 'replace' : 'confirm-replace'
    case 'foreign':
      return 'refuse-foreign'
  }
}

/** Only a symlink this app made is ours to remove. */
export function decideRemove(link: CommandLineLinkStatus): boolean {
  return link === 'installed'
}

export const SHELL_PATH_MARKER = '__CODICTATE_PATH__'

/**
 * The PATH printed between two markers. An interactive shell may print a banner or a
 * prompt-framework warning around it, so the markers are what make the read reliable.
 */
export function parseMarkedShellOutput(stdout: string): string | null {
  const start = stdout.indexOf(SHELL_PATH_MARKER)
  if (start === -1) return null
  const from = start + SHELL_PATH_MARKER.length
  const end = stdout.indexOf(SHELL_PATH_MARKER, from)
  if (end === -1) return null
  return stdout.slice(from, end)
}

function expandWindowsVariables(
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  const lookup = new Map(
    Object.entries(env).map(([key, v]) => [key.toLowerCase(), v])
  )
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const found = lookup.get(name.toLowerCase())
    return found === undefined ? whole : found
  })
}

function normalizePathEntry(entry: string, windows: boolean): string {
  if (windows) {
    return entry.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  }
  return entry.trim().replace(/\/+$/, '')
}

/**
 * Whether a PATH value lists `dir`. Windows compares case-insensitively and expands
 * `%VAR%` references the registry keeps unexpanded.
 */
export function pathListsDir(
  pathValue: string,
  dir: string,
  options: {
    windows: boolean
    env?: Readonly<Record<string, string | undefined>>
  }
): boolean {
  const separator = options.windows ? ';' : ':'
  const wanted = normalizePathEntry(dir, options.windows)
  if (wanted === '') return false
  return pathValue.split(separator).some((raw) => {
    const entry = options.windows
      ? expandWindowsVariables(raw, options.env ?? {})
      : raw
    return normalizePathEntry(entry, options.windows) === wanted
  })
}

/** The line that puts `~/.local/bin` on PATH for the user's login shell, and where it goes. */
export function pathSetupFor(shellPath: string | undefined): {
  line: string
  where: string
} {
  const shell = basename(shellPath ?? '')
  if (shell === 'fish') {
    return {
      line: 'fish_add_path ~/.local/bin',
      where: 'Run this once in fish',
    }
  }
  const where =
    shell === 'bash'
      ? 'Add this line to ~/.bash_profile'
      : shell === 'zsh' || shell === ''
        ? 'Add this line to ~/.zshrc'
        : 'Add this line to your shell profile'
  return { line: 'export PATH="$HOME/.local/bin:$PATH"', where }
}

/**
 * Whether the client sits somewhere that will not last: a quarantined app macOS runs from a
 * randomized read-only mount (App Translocation), or a copy still on the disk image. A
 * symlink to either breaks as soon as the app is moved or the image is ejected.
 */
export function isTransientAppLocation(realClientPath: string): boolean {
  return (
    realClientPath.includes('/AppTranslocation/') ||
    realClientPath.startsWith('/Volumes/')
  )
}

export const MOVE_TO_APPLICATIONS_MESSAGE =
  'Move Codictate to your Applications folder first, then install the command.'

/** The registry value kinds a Path can be edited as. Anything else is left alone. */
export type UserPathKind = 'String' | 'ExpandString'

/** The user's `HKCU\Environment` Path, unexpanded, as the read script reports it. */
export type UserPathRead =
  { exists: false } | { exists: true; kind: string; value: string }

/**
 * Prints the user's Path as three ASCII lines: `1`/`0` for whether it exists, its
 * `RegistryValueKind`, and the unexpanded value as base64 UTF-8. Nothing is decoded through
 * the console code page, so `C:\Users\Søren` survives the trip.
 */
export const READ_USER_PATH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }',
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
  "$exists = $false; $kind = ''; $value = ''",
  'if ($null -ne $key) {',
  "  if ($key.GetValueNames() -contains 'Path') {",
  '    $exists = $true',
  "    $kind = $key.GetValueKind('Path').ToString()",
  "    $raw = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  '    if ($raw -is [string]) { $value = $raw }',
  '  }',
  '  $key.Close()',
  '}',
  "$flag = if ($exists) { '1' } else { '0' }",
  '[Console]::Out.Write($flag + "`n" + $kind + "`n" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) + "`n")',
].join('\n')

/** `READ_USER_PATH_SCRIPT`'s output, or `null` when it is not that. */
export function parseUserPathRead(stdout: string): UserPathRead | null {
  const lines = stdout.replace(/\r/g, '').split('\n')
  const [flag, kind, encoded] = lines
  if (flag === '0') return { exists: false }
  if (flag !== '1' || kind === undefined || encoded === undefined) return null
  if (!/^[A-Za-z]+$/.test(kind) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return null
  }
  return {
    exists: true,
    kind,
    value: Buffer.from(encoded, 'base64').toString('utf8'),
  }
}

export type UserPathDecision =
  | { action: 'already-listed' }
  | { action: 'unsupported-kind' }
  | { action: 'write'; value: string; kind: UserPathKind }

/**
 * What adding `dir` to the user's Path should do. A Path of another kind (a binary or a
 * number someone wrote by hand) is never overwritten; a missing one is created as
 * `ExpandString`, which is what Windows itself uses.
 */
export function decideUserPathWrite(
  read: UserPathRead,
  dir: string,
  env: Readonly<Record<string, string | undefined>> = {}
): UserPathDecision {
  if (!read.exists) {
    return { action: 'write', value: dir, kind: 'ExpandString' }
  }
  if (read.kind !== 'String' && read.kind !== 'ExpandString') {
    return { action: 'unsupported-kind' }
  }
  if (pathListsDir(read.value, dir, { windows: true, env })) {
    return { action: 'already-listed' }
  }
  return {
    action: 'write',
    value: appendDirToWindowsPath(read.value, dir, env),
    kind: read.kind,
  }
}

/** Exit code of `WRITE_USER_PATH_SCRIPT` when the Path changed since it was read. */
export const USER_PATH_CHANGED_EXIT = 3

/**
 * Writes the new Path through the registry, only if the value is still exactly what was read
 * (`CODICTATE_PATH_EXPECTED`, base64 UTF-8, with `CODICTATE_PATH_EXISTED`); otherwise exits
 * `USER_PATH_CHANGED_EXIT` and changes nothing. The value kind is the one read, so
 * `%USERPROFILE%`-style entries keep expanding (Windows PowerShell's
 * `[Environment]::SetEnvironmentVariable` would write `REG_SZ`). Setting and clearing a
 * throwaway variable afterwards broadcasts `WM_SETTINGCHANGE`, so terminals opened from now on
 * see it.
 */
export const WRITE_USER_PATH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }',
  '$utf8 = [Text.Encoding]::UTF8',
  '$expected = $utf8.GetString([Convert]::FromBase64String($env:CODICTATE_PATH_EXPECTED))',
  '$next = $utf8.GetString([Convert]::FromBase64String($env:CODICTATE_PATH_NEXT))',
  '$kind = [Microsoft.Win32.RegistryValueKind]$env:CODICTATE_PATH_KIND',
  "$existed = $env:CODICTATE_PATH_EXISTED -eq '1'",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  '$changed = $false',
  'try {',
  "  $exists = $key.GetValueNames() -contains 'Path'",
  '  if ($exists -ne $existed) { $changed = $true } elseif ($exists) {',
  "    $currentKind = $key.GetValueKind('Path')",
  "    $current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  '    if ($currentKind -ne $kind -or -not ($current -is [string]) -or -not [string]::Equals($current, $expected, [StringComparison]::Ordinal)) { $changed = $true }',
  '  }',
  "  if (-not $changed) { $key.SetValue('Path', $next, $kind) }",
  '} finally { $key.Close() }',
  `if ($changed) { exit ${USER_PATH_CHANGED_EXIT} }`,
  "[Environment]::SetEnvironmentVariable('CODICTATE_PATH_REFRESH', '1', 'User')",
  "[Environment]::SetEnvironmentVariable('CODICTATE_PATH_REFRESH', $null, 'User')",
].join('\n')

/** The environment `WRITE_USER_PATH_SCRIPT` reads its inputs from. All ASCII. */
export function userPathWriteEnv(
  read: UserPathRead,
  next: string,
  kind: UserPathKind
): Record<string, string> {
  return {
    CODICTATE_PATH_EXISTED: read.exists ? '1' : '0',
    CODICTATE_PATH_EXPECTED: Buffer.from(
      read.exists ? read.value : '',
      'utf8'
    ).toString('base64'),
    CODICTATE_PATH_NEXT: Buffer.from(next, 'utf8').toString('base64'),
    CODICTATE_PATH_KIND: kind,
  }
}

/** `powershell -EncodedCommand` takes the script as base64 UTF-16LE, sidestepping quoting. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** `value` with `dir` appended, unless it is already listed. */
export function appendDirToWindowsPath(
  value: string,
  dir: string,
  env: Readonly<Record<string, string | undefined>> = {}
): string {
  if (pathListsDir(value, dir, { windows: true, env })) return value
  const trimmed = value.replace(/;+$/, '')
  return trimmed === '' ? dir : `${trimmed};${dir}`
}

/** `~/…` for a path under the home directory, for display. */
export function tildify(path: string, home: string): string {
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// ─── Effects ─────────────────────────────────────────────────────────────────

/**
 * Electrobun bundles the entry under Resources/app, so `..` from the bundled main process is
 * `Resources/app`, the same root `platform/binaries.ts` uses. From source it is `src`.
 */
const bundleRoot = (): string => resolve(import.meta.dir, '..')

/** Every ancestor, so a dev build nested inside the checkout still finds `native/`. */
function ancestors(start: string): string[] {
  const out: string[] = []
  let current = resolve(start)
  for (;;) {
    out.push(current)
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

function findClient(platform: PlatformRuntime): string | null {
  const root = bundleRoot()
  return resolveBinary(
    clientCandidates(platform, root, ancestors(dirname(root))),
    existsSync
  )
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const linkDir = (): string => join(homedir(), '.local', 'bin')
const linkPath = (): string => join(linkDir(), 'codictate')

function readLinkEntry(path: string): LinkEntry {
  try {
    const stat = lstatSync(path)
    if (!stat.isSymbolicLink()) return { kind: 'other' }
    const target = resolve(dirname(path), readlinkSync(path))
    return { kind: 'symlink', target: realOrSelf(target) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' }
    }
    return { kind: 'other' }
  }
}

/**
 * Runs a command and collects stdout, giving up after `timeoutMs`. `doneWhen` lets a caller
 * stop reading early: a login shell can leave a daemon (a prompt theme's git helper) holding
 * the pipe open long after it printed what was asked.
 */
async function runCapture(
  argv: string[],
  options: {
    timeoutMs: number
    env?: Record<string, string | undefined>
    doneWhen?: (stdout: string) => boolean
  }
): Promise<{ exitCode: number | null; stdout: string } | null> {
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    env: options.env ?? process.env,
    windowsHide: true,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), options.timeoutMs)
  })
  const collect = async (): Promise<{
    exitCode: number | null
    stdout: string
  }> => {
    const decoder = new TextDecoder()
    let stdout = ''
    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk, { stream: true })
      if (options.doneWhen?.(stdout)) return { exitCode: null, stdout }
    }
    stdout += decoder.decode()
    return { exitCode: await proc.exited, stdout }
  }
  try {
    return await Promise.race([collect(), timedOut])
  } finally {
    clearTimeout(timer)
    if (proc.exitCode === null) proc.kill()
  }
}

/**
 * The login shell's PATH. `-l` reads the profile and `-i` the rc file, which is where most
 * people add to PATH. `null` when the shell cannot be asked within the timeout.
 */
async function loginShellPath(shell: string): Promise<string | null> {
  try {
    const run = await runCapture(
      [
        shell,
        '-lic',
        `printf '%s%s%s' '${SHELL_PATH_MARKER}' "$PATH" '${SHELL_PATH_MARKER}'`,
      ],
      {
        timeoutMs: 4000,
        doneWhen: (stdout) => parseMarkedShellOutput(stdout) !== null,
      }
    )
    return run === null ? null : parseMarkedShellOutput(run.stdout)
  } catch {
    return null
  }
}

async function macosState(): Promise<CommandLineInstallState> {
  const home = homedir()
  const clientPath = findClient('macos')
  const realClient = clientPath === null ? null : realOrSelf(clientPath)
  const entry = readLinkEntry(linkPath())
  const shell = process.env.SHELL || '/bin/zsh'
  const shellPath = await loginShellPath(shell)
  return {
    platform: 'macos',
    clientPath,
    linkPath: tildify(linkPath(), home),
    link: classifyLink(entry, realClient),
    mustMoveToApplications:
      realClient !== null && isTransientAppLocation(realClient),
    linkTarget: entry.kind === 'symlink' ? entry.target : null,
    onPath:
      shellPath === null
        ? null
        : pathListsDir(shellPath, linkDir(), { windows: false }),
    pathSetup: pathSetupFor(shell),
  }
}

function runPowerShell(
  script: string,
  options: { timeoutMs: number; env?: Record<string, string | undefined> }
): ReturnType<typeof runCapture> {
  return runCapture(
    [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(script),
    ],
    options
  )
}

async function readUserPath(): Promise<UserPathRead | null> {
  try {
    const run = await runPowerShell(READ_USER_PATH_SCRIPT, { timeoutMs: 15000 })
    if (run === null || run.exitCode !== 0) return null
    return parseUserPathRead(run.stdout)
  } catch {
    return null
  }
}

function windowsBinDir(clientPath: string | null): string {
  return clientPath === null ? join(bundleRoot(), 'bin') : dirname(clientPath)
}

async function windowsState(): Promise<CommandLineInstallState> {
  const clientPath = findClient('windows')
  const binDir = windowsBinDir(clientPath)
  const userPath = await readUserPath()
  return {
    platform: 'windows',
    clientPath,
    binDir,
    onPath:
      userPath === null
        ? null
        : userPath.exists &&
          pathListsDir(userPath.value, binDir, {
            windows: true,
            env: process.env,
          }),
  }
}

export async function getCommandLineInstallState(): Promise<CommandLineInstallState> {
  switch (getPlatformRuntime()) {
    case 'macos':
      return macosState()
    case 'windows':
      return windowsState()
    default:
      return { platform: 'linux' }
  }
}

async function result(
  ok: boolean,
  message: string | null
): Promise<CommandLineInstallResult> {
  return { ok, message, state: await getCommandLineInstallState() }
}

export async function installCommandLine(
  replace: boolean
): Promise<CommandLineInstallResult> {
  if (getPlatformRuntime() !== 'macos') {
    return result(false, 'Installing the command is only needed on macOS.')
  }
  const clientPath = findClient('macos')
  const realClient = clientPath === null ? null : realOrSelf(clientPath)
  const entry = readLinkEntry(linkPath())
  const link = classifyLink(entry, realClient)
  switch (decideInstall(link, realClient, replace)) {
    case 'move-to-applications':
      return result(false, MOVE_TO_APPLICATIONS_MESSAGE)
    case 'no-client':
      return result(
        false,
        "This copy of Codictate doesn't include the command."
      )
    case 'refuse-foreign':
      return result(
        false,
        "Something else is already at ~/.local/bin/codictate, so it's been left alone."
      )
    case 'confirm-replace':
      return result(
        false,
        '~/.local/bin/codictate points to another Codictate. Replace it to use this one.'
      )
    case 'already-installed':
      return result(true, null)
    case 'replace':
    case 'create':
      try {
        mkdirSync(linkDir(), { recursive: true })
        if (entry.kind === 'symlink') unlinkSync(linkPath())
        symlinkSync(clientPath!, linkPath())
        return result(true, null)
      } catch (error) {
        console.error('[command-line] install failed', error)
        return result(false, "Couldn't create ~/.local/bin/codictate.")
      }
  }
}

export async function removeCommandLine(): Promise<CommandLineInstallResult> {
  if (getPlatformRuntime() !== 'macos') return result(false, null)
  const clientPath = findClient('macos')
  const link = classifyLink(
    readLinkEntry(linkPath()),
    clientPath === null ? null : realOrSelf(clientPath)
  )
  if (!decideRemove(link)) {
    return result(
      false,
      "~/.local/bin/codictate isn't this app's, so it's been left alone."
    )
  }
  try {
    unlinkSync(linkPath())
    return result(true, null)
  } catch (error) {
    console.error('[command-line] remove failed', error)
    return result(false, "Couldn't remove ~/.local/bin/codictate.")
  }
}

export async function addCommandLineToUserPath(): Promise<CommandLineInstallResult> {
  if (getPlatformRuntime() !== 'windows') {
    return result(false, 'Adding to Path is only needed on Windows.')
  }
  const binDir = windowsBinDir(findClient('windows'))
  const current = await readUserPath()
  if (current === null) {
    return result(false, "Couldn't read your Path.")
  }
  const decision = decideUserPathWrite(current, binDir, process.env)
  if (decision.action === 'already-listed') return result(true, null)
  if (decision.action === 'unsupported-kind') {
    return result(
      false,
      "Your Path is stored in an unusual way, so it's been left alone."
    )
  }
  try {
    const run = await runPowerShell(WRITE_USER_PATH_SCRIPT, {
      timeoutMs: 15000,
      env: {
        ...process.env,
        ...userPathWriteEnv(current, decision.value, decision.kind),
      },
    })
    if (run?.exitCode === USER_PATH_CHANGED_EXIT) {
      return result(false, 'Your Path changed while updating it. Try again.')
    }
    if (run?.exitCode !== 0) return result(false, "Couldn't update your Path.")
    return result(true, null)
  } catch (error) {
    console.error('[command-line] add to Path failed', error)
    return result(false, "Couldn't update your Path.")
  }
}
