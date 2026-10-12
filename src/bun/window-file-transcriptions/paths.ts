/**
 * File paths for the Transcribe page: what the native dialog and a file drop hand back, and
 * where "Save as text" writes. Pure, so both platforms are tested on any host.
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
 * on its own, so any navigation is either a dropped file (read from `will-navigate`, see
 * `droppedFilePath`) or something that must not replace the app.
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
 * The local path a dropped file navigated the webview to, or `null` for anything that is
 * not a local file URL.
 *
 * A file dropped on WKWebView or WebView2 that the page does not handle makes the webview
 * navigate to its `file://` URL. The main window blocks that navigation (with every other
 * one, `mainWindowNavigationRules`) and reads the path from the `will-navigate` event
 * instead: the only place either webview exposes a dropped file's real path.
 *
 * Only a URL with no host or `localhost` is a dropped file. On Windows only a drive path
 * is: a UNC or remote host is refused, so a drop never makes the app touch a network share.
 */
export function droppedFilePath(
  url: string,
  platform: 'macos' | 'windows' | 'linux'
): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') return null
  const host = parsed.hostname
  if (host !== '' && host !== 'localhost') return null
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (platform === 'windows') {
    // `/C:/Users/...`; `//server/share` (a `file:////server` URL) is a UNC path in disguise.
    if (!/^\/[A-Za-z]:\//.test(pathname)) return null
    return pathname.slice(1).replace(/\//g, '\\')
  }
  return pathname
}

/**
 * The `.txt` names "Save as text" tries, in order: `talk.txt`, then `talk 2.txt`, `talk
 * 3.txt` and so on, so an existing file is never overwritten.
 */
export function transcriptTextFileName(
  sourceFileName: string,
  attempt: number
): string {
  const dot = sourceFileName.lastIndexOf('.')
  const stem = dot > 0 ? sourceFileName.slice(0, dot) : sourceFileName
  return attempt <= 1 ? `${stem}.txt` : `${stem} ${attempt}.txt`
}
