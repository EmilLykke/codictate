/**
 * Lowered OS priority for the child processes of a File Transcription.
 *
 * A File Transcription can run for an hour on a long recording, and a Dictation started in
 * the meantime must not wait for the CPU behind it. So the decoder and the Speech Engine of
 * a file job run at nice 10, and a Dictation's engine keeps the default priority.
 *
 * `os.setPriority` is the libuv call: `setpriority(PRIO_PROCESS)` on macOS, and on Windows
 * `SetPriorityClass`, where 10 maps to BELOW_NORMAL_PRIORITY_CLASS. It is applied right
 * after the spawn, so the child runs a few instructions at normal priority first, which is
 * negligible next to a model load.
 */

import { setPriority } from 'node:os'
import { log } from '../../logger'

/** Unix nice value; libuv's `UV_PRIORITY_BELOW_NORMAL`, which Windows maps to BELOW_NORMAL. */
export const LOW_PROCESS_PRIORITY = 10

/** Best effort: a child that already exited, or a refused call, leaves it at normal priority. */
export function lowerProcessPriority(
  pid: number,
  tag: string,
  setter: (pid: number, priority: number) => void = setPriority
): boolean {
  try {
    setter(pid, LOW_PROCESS_PRIORITY)
    return true
  } catch (err) {
    log(tag, 'could not lower process priority', {
      pid,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
