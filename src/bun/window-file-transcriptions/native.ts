/**
 * The native pieces behind the Transcribe page: the open dialog, the folder dialog for a
 * Transcript Export, and writing a new file. Electrobun's dialog is the same call on macOS
 * (NSOpenPanel) and Windows (IFileOpenDialog).
 */

import { statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Utils } from 'electrobun/bun'
import { splitDialogPaths } from './paths'

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
 * One folder, or `null` when the user cancels. Only ever called from an RPC *message*
 * handler: awaiting a dialog inside a request hangs the webview (Electrobun #156).
 *
 * Electrobun 1.18 splits the result on `,` and returns `[""]` for a cancel, so the pieces of a
 * folder named `Talks, 2026` are joined back. Only one folder can be chosen, so the whole
 * result is that folder.
 */
export async function chooseFolderWithNativeDialog(
  startingFolder: string
): Promise<string | null> {
  const chosen = await Utils.openFileDialog({
    startingFolder,
    allowedFileTypes: '*',
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  })
  const folder = chosen.join(',')
  return folder.trim() === '' ? null : folder
}

/** Fails with `EEXIST` rather than overwrite. */
export function writeNewTextFile(path: string, text: string): void {
  writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
}
