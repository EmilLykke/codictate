import type {
  FocusedAppContext,
  FormatterModelTier,
  FormattingRuntimeSettings,
} from '../../../shared/types'
import {
  FORMATTING_MODE_ORDER,
  type FormattingModeId,
} from '../../../shared/formatting-modes'
import { log } from '../logger'
import { detectAll } from 'tinyld/heavy'
import { superviseProcess } from '../whisper/engines/process-supervisor'

export interface FormatterRequest {
  /** Master switch: when false, `applyFormatting` must not change the transcript. */
  formattingEnabled: boolean
  modeId: FormattingModeId
  transcript: string
  formatterModelInstalled: boolean
  /** Transcription language ID ('da', 'zh-cn', 'auto', …). Used by the formatter for locale hints. */
  transcriptionLanguage: string
  userDisplayName: string
  formatterModelTier: FormatterModelTier
  s1Styling: FormattingRuntimeSettings['s1']['styling']
  s1Structure: FormattingRuntimeSettings['s1']['structure']
  s1Context: 'general' | 'email'
  // Email
  emailIncludeSenderName: boolean
  emailGreetingStyle: FormattingRuntimeSettings['email']['greetingStyle']
  emailClosingStyle: FormattingRuntimeSettings['email']['closingStyle']
  emailCustomGreeting: string
  emailCustomClosing: string
  // iMessage
  imessageTone: FormattingRuntimeSettings['imessage']['tone']
  imessageAllowEmoji: boolean
  imessageLightweight: boolean
  // Slack
  slackTone: FormattingRuntimeSettings['slack']['tone']
  slackAllowEmoji: boolean
  slackUseMarkdown: boolean
  slackLightweight: boolean
  // Document
  documentTone: FormattingRuntimeSettings['document']['tone']
  documentStructure: FormattingRuntimeSettings['document']['structure']
  documentLightweight: boolean
  focusedApp: FocusedAppContext | null
}

interface AppDetector {
  names: Set<string>
  bundlePrefixes: string[]
}

const APP_DETECTORS: Record<FormattingModeId, AppDetector> = {
  email: {
    names: new Set([
      'mail',
      'microsoft outlook',
      'outlook',
      'spark',
      'spark desktop',
      'superhuman',
      'mimestream',
    ]),
    bundlePrefixes: [
      'com.apple.mail',
      'com.microsoft.outlook',
      'com.readdle.spark',
      'com.readdle.smartemail',
      'com.superhuman.superhuman',
      'com.mimestream.mimestream',
    ],
  },
  imessage: {
    names: new Set(['messages']),
    bundlePrefixes: ['com.apple.mobilesms', 'com.apple.messages'],
  },
  slack: {
    names: new Set(['slack']),
    bundlePrefixes: ['com.tinyspeck.slackmacgap', 'com.slack'],
  },
  document: {
    names: new Set([
      'notes',
      'pages',
      'microsoft word',
      'word',
      'google docs',
      'ulysses',
      'bear',
    ]),
    bundlePrefixes: [
      'com.apple.notes',
      'com.apple.iwork.pages',
      'com.microsoft.word',
      'com.ulyssesapp.mac',
      'net.shinyfrog.bear',
    ],
  },
}

async function runAppleScript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ['-e', line])
  const proc = Bun.spawn(['osascript', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(stderrText.trim() || 'osascript failed')
  }
  return stdoutText.trim()
}

const WINDOWS_FOREGROUND_APP_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CodictateForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
}
'@
$window = [CodictateForegroundWindow]::GetForegroundWindow()
if ($window -eq [IntPtr]::Zero) { exit 2 }
[uint32]$processId = 0
[void][CodictateForegroundWindow]::GetWindowThreadProcessId($window, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction Stop
$titleLength = [CodictateForegroundWindow]::GetWindowTextLengthW($window)
$title = [System.Text.StringBuilder]::new([Math]::Max(1, $titleLength + 1))
[void][CodictateForegroundWindow]::GetWindowTextW($window, $title, $title.Capacity)
@{ processName = $process.ProcessName; windowTitle = $title.ToString() } | ConvertTo-Json -Compress
`.trim()

interface WindowsForegroundProcess {
  processName: string
  windowTitle: string | null
}

const WINDOWS_PROCESS_APP_NAMES: Readonly<Record<string, string>> = {
  outlook: 'Microsoft Outlook',
  olk: 'Microsoft Outlook',
  hxoutlook: 'Microsoft Outlook',
  slack: 'Slack',
  superhuman: 'Superhuman',
  spark: 'Spark Desktop',
  sparkdesktop: 'Spark Desktop',
  winword: 'Microsoft Word',
  wordpad: 'Microsoft Word',
  notepad: 'Notes',
}

const WINDOWS_BROWSER_PROCESSES = new Set([
  'brave',
  'chrome',
  'firefox',
  'iexplore',
  'msedge',
  'opera',
  'vivaldi',
])

function windowsAppName(
  processName: string,
  windowTitle: string | null
): string {
  const normalizedProcess = processName
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '')
  const mapped = WINDOWS_PROCESS_APP_NAMES[normalizedProcess]
  if (mapped) return mapped

  const title = windowTitle?.trim().toLowerCase() ?? ''
  if (WINDOWS_BROWSER_PROCESSES.has(normalizedProcess)) {
    if (title.includes('google docs')) return 'Google Docs'
    if (title.includes('outlook')) return 'Microsoft Outlook'
    if (title.includes('superhuman')) return 'Superhuman'
    if (title.includes('slack')) return 'Slack'
  }
  return processName.trim()
}

/** Parse and map the fixed PowerShell foreground-window response without platform calls. */
export function parseWindowsFocusedAppContext(
  raw: string
): FocusedAppContext | null {
  try {
    const value = JSON.parse(raw) as Partial<WindowsForegroundProcess>
    if (typeof value.processName !== 'string' || !value.processName.trim()) {
      return null
    }
    const windowTitle =
      typeof value.windowTitle === 'string' && value.windowTitle.trim()
        ? value.windowTitle.trim()
        : null
    return {
      appName: windowsAppName(value.processName, windowTitle),
      bundleIdentifier: null,
      windowTitle,
    }
  } catch {
    return null
  }
}

async function getWindowsFocusedAppContext(): Promise<FocusedAppContext | null> {
  const proc = Bun.spawn(
    [
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_FOREGROUND_APP_SCRIPT,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true }
  )
  const result = await superviseProcess(proc, {
    stdout: proc.stdout,
    stderr: proc.stderr,
    timeoutMs: 2_000,
    cleanupGraceMs: 250,
  })
  if (
    result.status !== 'exited' ||
    result.exitCode !== 0 ||
    !result.outputComplete
  ) {
    return null
  }
  return parseWindowsFocusedAppContext(new TextDecoder().decode(result.stdout))
}

export async function getFocusedAppContext(): Promise<FocusedAppContext | null> {
  try {
    if (process.platform === 'win32') return await getWindowsFocusedAppContext()
    if (process.platform !== 'darwin') return null
    const raw = await runAppleScript([
      'tell application "System Events"',
      'set frontApp to first application process whose frontmost is true',
      'set appName to name of frontApp',
      'set bundleId to ""',
      'try',
      'set bundleId to bundle identifier of frontApp',
      'end try',
      'set windowTitle to ""',
      'try',
      'set windowTitle to name of front window of frontApp',
      'end try',
      'return appName & linefeed & bundleId & linefeed & windowTitle',
      'end tell',
    ])

    const [appNameRaw, bundleIdentifierRaw, ...titleParts] = raw.split('\n')
    const appName = appNameRaw?.trim()
    if (!appName) return null

    const bundleIdentifier = bundleIdentifierRaw?.trim() || null
    const windowTitle = titleParts.join('\n').trim() || null

    return {
      appName,
      bundleIdentifier,
      windowTitle,
    }
  } catch (error) {
    log('formatter', 'failed to resolve focused app context', {
      error: String(error),
    })
    return null
  }
}

function appMatchesMode(
  mode: FormattingModeId,
  focusedApp: FocusedAppContext | null
): boolean {
  if (!focusedApp) return false
  const detector = APP_DETECTORS[mode]
  const appName = focusedApp.appName.trim().toLowerCase()
  if (detector.names.has(appName)) return true
  const bundleIdentifier = focusedApp.bundleIdentifier?.trim().toLowerCase()
  if (!bundleIdentifier) return false
  return detector.bundlePrefixes.some((prefix) =>
    bundleIdentifier.startsWith(prefix)
  )
}

function buildRequest(
  modeId: FormattingModeId,
  transcript: string,
  settings: FormattingRuntimeSettings,
  focusedApp: FocusedAppContext | null
): FormatterRequest {
  return {
    formattingEnabled: settings.enabled,
    modeId,
    transcript,
    formatterModelInstalled: settings.modelInstalled,
    transcriptionLanguage: settings.transcriptionLanguageId,
    userDisplayName: settings.userDisplayName.trim(),
    formatterModelTier: settings.formatterModelTier,
    ...s1ControlsForMode(modeId, settings),
    emailIncludeSenderName: settings.email.includeSenderName,
    emailGreetingStyle: settings.email.greetingStyle,
    emailClosingStyle: settings.email.closingStyle,
    emailCustomGreeting: settings.email.customGreeting,
    emailCustomClosing: settings.email.customClosing,
    imessageTone: settings.imessage.tone,
    imessageAllowEmoji: settings.imessage.allowEmoji,
    imessageLightweight: settings.imessage.lightweight,
    slackTone: settings.slack.tone,
    slackAllowEmoji: settings.slack.allowEmoji,
    slackUseMarkdown: settings.slack.useMarkdown,
    slackLightweight: settings.slack.lightweight,
    documentTone: settings.document.tone,
    documentStructure: settings.document.structure,
    documentLightweight: settings.document.lightweight,
    focusedApp,
  }
}

function s1ControlsForMode(
  modeId: FormattingModeId | null,
  settings: FormattingRuntimeSettings
): Pick<FormatterRequest, 's1Styling' | 's1Structure' | 's1Context'> {
  let s1Styling = settings.s1.styling
  const s1Structure = 'lists' as const
  let s1Context: FormatterRequest['s1Context'] = 'general'

  switch (modeId) {
    case 'email':
      s1Context = 'email'
      break
    case 'imessage':
      s1Styling =
        settings.imessage.tone === 'formal'
          ? 'formal'
          : settings.imessage.tone === 'casual'
            ? 'casual'
            : 'semi-casual'
      break
    case 'slack':
      s1Styling =
        settings.slack.tone === 'professional'
          ? 'semi-formal'
          : settings.slack.tone === 'casual'
            ? 'casual'
            : 'semi-casual'
      break
    case 'document':
      s1Styling =
        settings.document.tone === 'formal'
          ? 'formal'
          : settings.document.tone === 'casual'
            ? 'semi-casual'
            : 'semi-formal'
      break
    case null:
      break
  }

  return { s1Styling, s1Structure, s1Context }
}

/**
 * S1-mini is English-only. Fixed languages are authoritative; automatic detection is
 * intentionally conservative because trigram detectors are unreliable for short dictation.
 */
export function isEnglishTranscriptEligible(
  transcript: string,
  transcriptionLanguage: string
): boolean {
  if (transcriptionLanguage !== 'auto') {
    return transcriptionLanguage.toLowerCase().split('-')[0] === 'en'
  }

  const words = transcript.match(/\p{L}+/gu) ?? []
  const letterCount = words.reduce((total, word) => total + word.length, 0)
  if (words.length < 4 || letterCount < 10) return false

  const candidates = detectAll(transcript)
  const [best, runnerUp] = candidates
  // Short English corrections can score around 0.65 despite a large lead over
  // every other language. Keep the margin and mixed-language checks below.
  if (!best || best.lang !== 'en' || best.accuracy < 0.6) return false
  if (runnerUp && best.accuracy - runnerUp.accuracy < 0.2) return false

  // Mixed English/Danish is the common ambiguous case in Codictate. TinyLD evaluates
  // punctuation-delimited chunks, so an English-dominant sentence can hide a Danish phrase.
  // Two adjacent Danish-leading windows are enough evidence to preserve the transcript.
  let previousWindowWasDanish = false
  for (let index = 0; index + 2 < words.length; index += 1) {
    const window = words.slice(index, index + 3).join(' ')
    const windowIsDanish =
      detectAll(window, { only: ['en', 'da'] })[0]?.lang === 'da'
    if (windowIsDanish && previousWindowWasDanish) return false
    previousWindowWasDanish = windowIsDanish
  }
  return true
}

function matchingEnabledMode(
  settings: FormattingRuntimeSettings,
  focusedApp: FocusedAppContext | null
): FormattingModeId | null {
  if (settings.forceModeId !== null) return settings.forceModeId
  for (const modeId of FORMATTING_MODE_ORDER) {
    if (settings.enabledModes[modeId] && appMatchesMode(modeId, focusedApp)) {
      return modeId
    }
  }
  return null
}

/** Pure S1-mini routing over the focused-app snapshot captured by the adapter. */
export function buildS1FormatterRequest(
  transcript: string,
  settings: FormattingRuntimeSettings,
  focusedApp: FocusedAppContext | null
): FormatterRequest | null {
  if (!settings.enabled) return null
  if (
    !isEnglishTranscriptEligible(transcript, settings.transcriptionLanguageId)
  ) {
    return null
  }

  const modeId = matchingEnabledMode(settings, focusedApp)
  const request = buildRequest(
    modeId ?? 'document',
    transcript,
    settings,
    focusedApp
  )
  Object.assign(request, s1ControlsForMode(modeId, settings))
  return request
}

export async function buildFormatterRequest(
  transcript: string,
  settings: FormattingRuntimeSettings
): Promise<FormatterRequest | null> {
  if (settings.formatterModelTier === 's1-mini') {
    if (!settings.enabled) {
      log('formatter', 'skip S1-mini: master switch off')
      return null
    }
    if (
      !isEnglishTranscriptEligible(transcript, settings.transcriptionLanguageId)
    ) {
      log('formatter', 'skip S1-mini: transcript is not confidently English', {
        transcriptionLanguage: settings.transcriptionLanguageId,
      })
      return null
    }
    const focusedApp = await getFocusedAppContext()
    const request = buildS1FormatterRequest(transcript, settings, focusedApp)
    if (request === null) return null
    log('formatter', 'S1-mini cleanup selected', {
      focusedApp: focusedApp?.appName,
      styling: request.s1Styling,
      structure: request.s1Structure,
      context: request.s1Context,
    })
    return request
  }

  // Force mode bypasses both the master switch and per-mode toggles.
  if (settings.forceModeId !== null) {
    const focusedApp = await getFocusedAppContext()
    log('formatter', 'force mode active', {
      forceModeId: settings.forceModeId,
      focusedApp: focusedApp?.appName,
    })
    return buildRequest(settings.forceModeId, transcript, settings, focusedApp)
  }

  if (!settings.enabled) {
    log('formatter', 'skip: master switch off')
    return null
  }

  const focusedApp = await getFocusedAppContext()
  for (const modeId of FORMATTING_MODE_ORDER) {
    if (!settings.enabledModes[modeId]) continue
    if (appMatchesMode(modeId, focusedApp)) {
      log('formatter', 'matched mode', {
        modeId,
        focusedApp: focusedApp?.appName,
      })
      return buildRequest(modeId, transcript, settings, focusedApp)
    }
  }

  log('formatter', 'skip: no enabled mode matches focused app', {
    focusedApp: focusedApp?.appName,
    bundleIdentifier: focusedApp?.bundleIdentifier,
    enabledModes: settings.enabledModes,
  })
  return null
}
