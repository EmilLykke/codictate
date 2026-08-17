/**
 * Transcription languages shown in Settings / Ready.
 * `whisperCode` is passed to the ASR Harness `--language` (whisper.cpp g_lang keys).
 * Variants that share a Whisper language (e.g. Mandarin TW/CN → zh) use distinct `id`s.
 */
const ENTRIES_UNSORTED: { id: string; label: string; whisperCode: string }[] = [
  { id: 'af', label: 'Afrikaans', whisperCode: 'af' },
  { id: 'sq', label: 'Albanian', whisperCode: 'sq' },
  { id: 'ar', label: 'Arabic', whisperCode: 'ar' },
  { id: 'hy', label: 'Armenian', whisperCode: 'hy' },
  { id: 'az', label: 'Azerbaijani', whisperCode: 'az' },
  { id: 'eu', label: 'Basque', whisperCode: 'eu' },
  { id: 'be', label: 'Belarusian', whisperCode: 'be' },
  { id: 'bn', label: 'Bengali', whisperCode: 'bn' },
  { id: 'yue-cn', label: 'Cantonese (CN)', whisperCode: 'yue' },
  { id: 'yue-hk', label: 'Cantonese (HK)', whisperCode: 'yue' },
  { id: 'ca', label: 'Catalan', whisperCode: 'ca' },
  { id: 'cs', label: 'Czech', whisperCode: 'cs' },
  { id: 'da', label: 'Danish', whisperCode: 'da' },
  { id: 'nl', label: 'Dutch', whisperCode: 'nl' },
  { id: 'en', label: 'English', whisperCode: 'en' },
  { id: 'et', label: 'Estonian', whisperCode: 'et' },
  { id: 'fi', label: 'Finnish', whisperCode: 'fi' },
  { id: 'fr', label: 'French', whisperCode: 'fr' },
  { id: 'gl', label: 'Galician', whisperCode: 'gl' },
  { id: 'de', label: 'German', whisperCode: 'de' },
  { id: 'el', label: 'Greek', whisperCode: 'el' },
  { id: 'he', label: 'Hebrew', whisperCode: 'he' },
  { id: 'hi', label: 'Hindi', whisperCode: 'hi' },
  { id: 'hu', label: 'Hungarian', whisperCode: 'hu' },
  { id: 'id', label: 'Indonesian', whisperCode: 'id' },
  { id: 'it', label: 'Italian', whisperCode: 'it' },
  { id: 'ja', label: 'Japanese', whisperCode: 'ja' },
  { id: 'kk', label: 'Kazakh', whisperCode: 'kk' },
  { id: 'ko', label: 'Korean', whisperCode: 'ko' },
  { id: 'lv', label: 'Latvian', whisperCode: 'lv' },
  { id: 'lt', label: 'Lithuanian', whisperCode: 'lt' },
  { id: 'zh-cn', label: 'Mandarin (CN)', whisperCode: 'zh' },
  { id: 'zh-tw', label: 'Mandarin (TW)', whisperCode: 'zh' },
  { id: 'mk', label: 'Macedonian', whisperCode: 'mk' },
  { id: 'mr', label: 'Marathi', whisperCode: 'mr' },
  { id: 'ne', label: 'Nepali', whisperCode: 'ne' },
  { id: 'no', label: 'Norwegian Bokmål', whisperCode: 'no' },
  { id: 'nn', label: 'Norwegian Nynorsk', whisperCode: 'nn' },
  { id: 'fa', label: 'Persian', whisperCode: 'fa' },
  { id: 'pl', label: 'Polish', whisperCode: 'pl' },
  { id: 'pt', label: 'Portuguese', whisperCode: 'pt' },
  { id: 'pa', label: 'Punjabi', whisperCode: 'pa' },
  { id: 'ro', label: 'Romanian', whisperCode: 'ro' },
  { id: 'ru', label: 'Russian', whisperCode: 'ru' },
  { id: 'sr', label: 'Serbian', whisperCode: 'sr' },
  { id: 'sk', label: 'Slovak', whisperCode: 'sk' },
  { id: 'sl', label: 'Slovenian', whisperCode: 'sl' },
  { id: 'es', label: 'Spanish', whisperCode: 'es' },
  { id: 'sw', label: 'Swahili', whisperCode: 'sw' },
  { id: 'sv', label: 'Swedish', whisperCode: 'sv' },
  { id: 'ta', label: 'Tamil', whisperCode: 'ta' },
  { id: 'th', label: 'Thai', whisperCode: 'th' },
  { id: 'tr', label: 'Turkish', whisperCode: 'tr' },
  { id: 'uk', label: 'Ukrainian', whisperCode: 'uk' },
  { id: 'ur', label: 'Urdu', whisperCode: 'ur' },
  { id: 'vi', label: 'Vietnamese', whisperCode: 'vi' },
  { id: 'cy', label: 'Welsh', whisperCode: 'cy' },
]

const SORTED = [...ENTRIES_UNSORTED].sort((a, b) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
)

const ID_TO_WHISPER = new Map(SORTED.map((e) => [e.id, e.whisperCode]))

export const TRANSCRIPTION_LANGUAGE_OPTIONS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto-detect' },
  ...SORTED.map(({ id, label }) => ({ id, label })),
]

const VALID_IDS = new Set(TRANSCRIPTION_LANGUAGE_OPTIONS.map((o) => o.id))

export function isValidTranscriptionLanguageId(id: string): boolean {
  return VALID_IDS.has(id)
}

/**
 * Maps a **settings / UI language id** (`transcriptionLanguageId`) to Whisper’s language token.
 * - `'auto'` or unknown → `null` (caller should treat as “use auto-detect”).
 * - `'da'`, `'en'`, … → whisper.cpp code (`'da'`, `'en'`, …).
 *
 * This is **not** the CLI argv value: the ASR Harness defaults to English if `--language` is omitted,
 * so the process layer must pass `--language auto` when this returns `null` — use {@link asrHarnessLanguageArg}.
 */
export function whisperCodeForTranscriptionId(id: string): string | null {
  if (id === 'auto' || id.trim() === '') return null
  const code = ID_TO_WHISPER.get(id)
  if (code == null) return null
  const t = code.trim()
  return t.length > 0 ? t : null
}

/**
 * Exact value for the ASR Harness `-l` / `--language`.
 * Feeds on the output of {@link whisperCodeForTranscriptionId} (or `null` from config): `null` / empty / whitespace → **`"auto"`** so the binary does not fall back to its default **`en`**.
 */
export function asrHarnessLanguageArg(
  whisperCodeOrAuto: string | null | undefined
): string {
  if (whisperCodeOrAuto == null) return 'auto'
  const t = whisperCodeOrAuto.trim()
  return t.length > 0 ? t : 'auto'
}

/** Shared helper / tooltip copy for Settings and Ready screens. */
export const TRANSCRIPTION_LANGUAGE_HINT =
  'Choosing a language improves accuracy. Auto-detect identifies the language per recording.'

/** Hover copy when Parakeet is selected and the transcription language control is locked. */
export const PARAKEET_TRANSCRIPTION_LANGUAGE_LOCK_TOOLTIP =
  'Parakeet detects language automatically. Manual selection is disabled.'
