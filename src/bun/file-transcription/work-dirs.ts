/**
 * The temp directories File Transcription jobs decode into, and the sweep that removes the
 * ones a previous run of the app left behind (a quit or crash mid-job can exit before the
 * job's own cleanup runs).
 */

import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const WORK_DIR_PREFIX = 'codictate-file-transcription-'

/** `mkdtemp` appends six characters; anything else with the prefix is not ours. */
const WORK_DIR_NAME = /^codictate-file-transcription-[A-Za-z0-9]{6}$/

/** A job dir untouched this long belongs to no live job, even in another process. */
export const STALE_WORK_DIR_MS = 60 * 60 * 1000

export function isWorkDirName(name: string): boolean {
  return WORK_DIR_NAME.test(name)
}

export function createWorkDir(parent: string): string {
  return mkdtempSync(join(parent, WORK_DIR_PREFIX))
}

/** The latest modification time of the directory and its direct children. */
function lastTouchedMs(dir: string, dirMtimeMs: number): number {
  let latest = dirMtimeMs
  for (const name of readdirSync(dir)) {
    try {
      latest = Math.max(latest, lstatSync(join(dir, name)).mtimeMs)
    } catch {
      /* gone already */
    }
  }
  return latest
}

/**
 * Removes job directories in `parent` that nothing has written to for `staleMs`. Only real
 * directories (not symlinks) whose name is exactly a job directory's are considered.
 * Returns the paths removed.
 */
export function removeStaleWorkDirs(
  parent: string,
  options: { now: number; staleMs?: number }
): string[] {
  const staleMs = options.staleMs ?? STALE_WORK_DIR_MS
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!isWorkDirName(name)) continue
    const dir = join(parent, name)
    try {
      const stat = lstatSync(dir)
      if (!stat.isDirectory()) continue
      if (options.now - lastTouchedMs(dir, stat.mtimeMs) < staleMs) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      /* in use or already gone: the next boot tries again */
    }
  }
  return removed
}
