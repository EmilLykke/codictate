/**
 * The native pieces behind the Transcribe page: the open dialog, the folder picker for a
 * Transcript Export, and writing the file. Both dialogs are Electrobun's `openFileDialog`, the
 * same call on macOS (NSOpenPanel) and Windows (IFileOpenDialog, folder mode for the picker).
 * Codictate names the exported file itself, so it needs no save dialog: the system one opens
 * collapsed on macOS when shown from a helper process, with no folder browser.
 */

import { lstatSync, statSync, writeFileSync } from 'node:fs'
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
 * The folder the user picked for a Transcript Export, or `null` when they cancelled. Only one
 * folder can be picked, so the unescaped `,` join (see `splitDialogPaths`) is undone by
 * joining back. The caller checks it is a folder. Only ever called from an RPC *message*
 * handler: the picker stays open as long as the user likes, longer than a request may wait
 * (#156).
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
  const folder = chosen.join(',').trim()
  return folder === '' ? null : folder
}

/**
 * Anything at the path counts, a broken link included (`lstat`, not `stat`), so an export
 * never picks a name the exclusive write would refuse.
 */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Creates the file and never replaces one: throws `EEXIST` when the name is taken. */
export function writeNewTextFile(path: string, text: string): void {
  writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
}
