/**
 * Audio Ducking (GLOSSARY.md): lower what the user is listening to while a Dictation records.
 *
 * One `duck` command per platform helper, started beside whichever recorder runs (MicRecorder,
 * the Windows `record` command, either Parakeet stream) and stopped when that recorder exits.
 * The recorders know nothing about it.
 *
 *   <helper> duck <level 0-100> <speakers 0|1> <headphones 0|1> <delayMs> <stateFile> <excludePid>
 *
 * The helper waits `delayMs`, lowers the volume over 40 ms, and holds it until a `stop` line,
 * the end of stdin (so a crashed app still gets its volume back) or SIGINT/SIGTERM; then it
 * brings the volume back over 40 ms unless the user moved it in the meantime, and exits.
 *
 * - macOS lowers the default output device itself (no public API lowers other apps only), so
 *   the delay lets the start chime finish first. `excludePid` is unused.
 * - Windows lowers every other app's audio session on the default output and leaves sessions
 *   owned by `excludePid` (this process) or its children (the chime player) alone, so there is
 *   nothing to wait for.
 *
 * Before it lowers anything the helper writes what it is about to change to `stateFile`, and
 * deletes the file once it has put everything back. A file still there at launch means the
 * helper was killed mid-Dictation: `restoreLeftoverAudioDucking` asks `duck-restore` to finish
 * the job.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../../AppConfig/AppConfig'
import { APP_DATA_DIR, getPlatformRuntime } from '../../platform/runtime'
import { log } from '../logger'
import { duckDelayAfterStartChimeMs } from '../sound/play-sound'
import { findMicRecorderBinary } from './find-mic-recorder'

const STATE_FILE = join(APP_DATA_DIR, 'run', 'audio-ducking.json')

/** How long `stop` waits for the helper to put the volume back before killing it. */
const STOP_TIMEOUT_MS = 1500

export interface AudioDucking {
  /** Bring the volume back. Resolves once the helper has exited. Safe to call twice. */
  stop(): Promise<void>
}

const NOT_DUCKING: AudioDucking = { stop: async () => {} }

export async function startAudioDucking(
  appConfig: AppConfig
): Promise<AudioDucking> {
  const speakers = appConfig.getAudioDuckingIncludeSpeakers()
  const headphones = appConfig.getAudioDuckingIncludeHeadphones()
  const level = appConfig.getAudioDuckingLevel()
  if ((!speakers && !headphones) || level >= 100) return NOT_DUCKING

  const delayMs =
    getPlatformRuntime() === 'macos' && appConfig.getSoundEffectsEnabled()
      ? duckDelayAfterStartChimeMs(appConfig.getFunModeEnabled())
      : 0

  let helper: string
  try {
    helper = await findMicRecorderBinary()
  } catch (err) {
    log('ducking', 'helper not found', { err: String(err) })
    return NOT_DUCKING
  }

  const proc = Bun.spawn(
    [
      helper,
      'duck',
      String(level),
      speakers ? '1' : '0',
      headphones ? '1' : '0',
      String(delayMs),
      STATE_FILE,
      String(process.pid),
    ],
    { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' }
  )
  void proc.exited.then(async (exitCode) => {
    const stderr = await new Response(proc.stderr).text().catch(() => '')
    log('ducking', 'exited', {
      exitCode,
      stderr: stderr.slice(0, 500) || undefined,
    })
  })
  log('ducking', 'started', { pid: proc.pid, level, speakers, headphones })

  let stopping: Promise<void> | null = null
  return {
    stop: () => {
      stopping ??= (async () => {
        try {
          proc.stdin.write('stop\n')
          await proc.stdin.end()
        } catch {
          // Already gone.
        }
        const exited = await Promise.race([
          proc.exited.then(() => true),
          Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
        ])
        if (!exited) {
          proc.kill('SIGTERM')
          await proc.exited
        }
      })()
      return stopping
    },
  }
}

/** Put back a volume a killed helper left lowered. Called once at launch. */
export async function restoreLeftoverAudioDucking(): Promise<void> {
  if (!existsSync(STATE_FILE)) return
  try {
    const helper = await findMicRecorderBinary()
    const proc = Bun.spawn([helper, 'duck-restore', STATE_FILE], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text().catch(() => '')
    log('ducking', 'restored leftover ducking', {
      exitCode,
      stderr: stderr.slice(0, 500) || undefined,
    })
  } catch (err) {
    log('ducking', 'could not restore leftover ducking', { err: String(err) })
  }
}
