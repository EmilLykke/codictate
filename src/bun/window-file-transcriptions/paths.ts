/**
 * File paths for the Transcribe page: what the native open dialog hands back, the main
 * window's navigation rules, and where a Transcript Export's folder picker opens and what the
 * file in that folder is called. Pure, so both platforms are tested on any host. A dropped
 * file has no path here: the page sends its bytes (dropped-files.ts).
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
 * Where the Transcript Export folder picker opens: the last folder a transcript was saved to,
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

/** How many names `uniqueExportPath` tries before it gives up. */
export const EXPORT_NAME_LIMIT = 1000

/**
 * Where a Transcript Export is written: `fileName` in `folder`, or, when that is taken,
 * `talk 2.srt`, `talk 3.srt` and so on, so an export never replaces a file. The number goes
 * before the last extension (`a.b.srt` gives `a.b 2.srt`); a name with no extension, or only
 * a leading dot, gets it at the end. The folder keeps its own separator, so a Windows path is
 * joined the same way on any host. `exists` must count anything at the path as taken.
 *
 * After `EXPORT_NAME_LIMIT` names it stops looking and returns the last one: the exclusive
 * write then refuses it rather than replace anything.
 */
export function uniqueExportPath(
  folder: string,
  fileName: string,
  exists: (path: string) => boolean
): string {
  const separator = /^[A-Za-z]:|^\\\\/.test(folder) ? '\\' : '/'
  const prefix =
    folder.endsWith('/') || folder.endsWith(separator)
      ? folder
      : folder + separator
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const extension = dot > 0 ? fileName.slice(dot) : ''
  let path = prefix + fileName
  for (let n = 2; n <= EXPORT_NAME_LIMIT && exists(path); n++) {
    path = `${prefix}${stem} ${n}${extension}`
  }
  return path
}
