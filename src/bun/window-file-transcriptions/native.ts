/**
 * The native pieces behind the Transcribe page: the open dialog, the Save dialog for a
 * Transcript Export, and writing the file. Electrobun's open dialog is the same call on macOS
 * (NSOpenPanel) and Windows (IFileOpenDialog). Electrobun 1.18 has no save dialog, so that one
 * is the media Native Helper's `save-dialog`: NSSavePanel in `CodictateMediaHelper`,
 * IFileSaveDialog in `CodictateWindowsHelper`.
 */

import { statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Utils } from 'electrobun/bun'
import { requireRuntimeBinary } from '../platform/binaries'
import {
  parseSaveDialogAnswer,
  saveDialogArgs,
  splitDialogPaths,
  type SaveDialogRequest,
} from './paths'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Any file is allowed. Electrobun 1.18 cannot offer "audio and video" with an "all files"
 * escape: on macOS a type list is a hard filter, and on Windows it becomes one dropdown entry
 * per extension. The queue says plainly when a file has no audio, which is the better place.
 */
export async function chooseFilesWithNativeDialog(
  startingFolder: string | null
): Promise<string[]> {
  const chosen = await Utils.openFileDialog({
    startingFolder: startingFolder ?? homedir(),
    allowedFileTypes: '*',
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: true,
  })
  return splitDialogPaths(chosen.join(','), isFile)
}

/**
 * The path the user chose in the system Save dialog, or `null` when they cancelled. The
 * dialog has a name field and folder browsing, and asks before replacing a file, so the
 * caller writes to the path as it is. Only ever called from an RPC *message* handler: the
 * dialog stays open as long as the user likes, longer than a request may wait (#156).
 *
 * Throws when the helper is missing or gives no answer, so that is reported as a failure.
 */
export async function chooseSaveLocationWithNativeDialog(
  request: SaveDialogRequest
): Promise<string | null> {
  const helper = requireRuntimeBinary('media')
  const proc = Bun.spawn([helper, ...saveDialogArgs(request)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `The Save dialog failed (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`
    )
  }
  return parseSaveDialogAnswer(stdout)
}

/** Replaces an existing file: the Save dialog already asked. */
export function writeTextFile(path: string, text: string): void {
  writeFileSync(path, text, { encoding: 'utf8' })
}
