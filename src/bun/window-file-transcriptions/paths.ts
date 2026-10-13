/**
 * File paths for the Transcribe page: what the native open dialog hands back, the main
 * window's navigation rules, and the Transcript Export Save dialog's start folder, argv and
 * answer. Pure, so both platforms are tested on any host. A dropped file has no path here:
 * the page sends its bytes (dropped-files.ts).
 */

/**
 * Electrobun 1.18's `openFileDialog` joins the chosen paths with `,` and does not escape
 * them, so a file named `notes, part 2.m4a` arrives split in two. Segments are joined back
 * until they name a file that exists. A tail that never does is kept as it is: the queue
 * reports it as unreadable rather than it vanishing.
 */
export function splitDialogPaths(
  raw: string,
  isFile: (path: string) => boolean
): string[] {
  if (raw.trim() === '') return []
  const segments = raw.split(',')
  const paths: string[] = []
  let pending: string | null = null
  for (const segment of segments) {
    const candidate: string =
      pending === null ? segment : `${pending},${segment}`
    if (isFile(candidate)) {
      paths.push(candidate)
      pending = null
    } else {
      pending = candidate
    }
  }
  if (pending !== null && pending.trim() !== '') paths.push(pending)
  return paths
}

/**
 * The navigation rules for the main window's webview (Electrobun: a `^` rule blocks, the
 * last matching rule wins, no match allows). Everything is blocked except the bundled views
 * and, in HMR dev, the Vite dev server the window was pointed at. The page never navigates
 * on its own, so any navigation is something that must not replace the app: a link, a
 * script, or a file dropped where the page did not cancel the drop.
 */
export function mainWindowNavigationRules(viewUrl: string): string[] {
  const rules = ['^*', 'views://*']
  const parsed = URL.canParse(viewUrl) ? new URL(viewUrl) : null
  if (
    parsed !== null &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    rules.push(parsed.origin, `${parsed.origin}/*`)
  }
  return rules
}

/**
 * Where the Transcript Export Save dialog opens: the last folder a transcript was saved to,
 * if it is still there; otherwise the transcribed file's own folder, if that is still there;
 * otherwise the home folder. A dropped file has no folder of its own (`sourceFolder: null`),
 * since Codictate transcribed a temporary copy of it.
 */
export function exportStartFolder(args: {
  lastExportFolder: string | null
  sourceFolder: string | null
  homeFolder: string
  isDirectory: (path: string) => boolean
}): string {
  for (const folder of [args.lastExportFolder, args.sourceFolder]) {
    if (folder !== null && folder.trim() !== '' && args.isDirectory(folder)) {
      return folder
    }
  }
  return args.homeFolder
}

export interface SaveDialogRequest {
  /** The name the dialog starts with, extension included: `talk.srt`. */
  defaultName: string
  /** The folder it opens in. */
  directory: string
  /** Without the dot: `srt`. */
  extension: string
}

/** What the dialog says in its title bar. */
export const SAVE_DIALOG_TITLE = 'Save Transcript'

/**
 * The media Native Helper's `save-dialog` argv after the executable, the same on macOS
 * (`CodictateMediaHelper`, NSSavePanel) and Windows (`CodictateWindowsHelper`,
 * IFileSaveDialog).
 */
export function saveDialogArgs(request: SaveDialogRequest): string[] {
  return [
    'save-dialog',
    '--name',
    request.defaultName,
    '--directory',
    request.directory,
    '--extension',
    request.extension,
    '--title',
    SAVE_DIALOG_TITLE,
  ]
}

/**
 * The helper's one JSON line: `{"path":"..."}` is the chosen path, `{"cancelled":true}` is
 * `null`. Anything else throws, so a broken helper is reported, not taken for a cancel.
 */
export function parseSaveDialogAnswer(stdout: string): string | null {
  const line = stdout.trim()
  let answer: unknown
  try {
    answer = JSON.parse(line)
  } catch {
    throw new Error(`The Save dialog gave no answer: ${line.slice(0, 200)}`)
  }
  if (typeof answer === 'object' && answer !== null) {
    if ('cancelled' in answer && answer.cancelled === true) return null
    if (
      'path' in answer &&
      typeof answer.path === 'string' &&
      answer.path.trim() !== ''
    ) {
      return answer.path
    }
  }
  throw new Error(`The Save dialog gave no answer: ${line.slice(0, 200)}`)
}
