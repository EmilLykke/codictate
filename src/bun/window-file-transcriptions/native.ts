/**
 * The native pieces behind the Transcribe page: the open dialog and writing a `.txt`.
 * Electrobun's dialog is the same call on macOS (NSOpenPanel) and Windows (IFileOpenDialog).
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

/** Fails with `EEXIST` rather than overwrite. */
export function writeNewTextFile(path: string, text: string): void {
  writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
}
