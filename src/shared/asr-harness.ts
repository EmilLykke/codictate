/**
 * ASR Harness: the binary and CLI contract used to execute a Speech Engine.
 *
 * The Whisper Speech Engine has two Harnesses. `whisper-cli` is the shipping
 * default; `crispasr` is selectable in the benchmark and behind a dev-only env
 * flag in the app. Harness is internal and never exposed to end users.
 *
 * See docs/adr/0002-asr-harness-abstraction.md and CONTEXT.md.
 */

export const ASR_HARNESS_IDS = ['whisper-cli', 'crispasr'] as const

export type AsrHarnessId = (typeof ASR_HARNESS_IDS)[number]

export const DEFAULT_ASR_HARNESS: AsrHarnessId = 'whisper-cli'

/** Labels for benchmark reports and dev logs. Never shown in the app UI. */
export const ASR_HARNESS_LABELS: Record<AsrHarnessId, string> = {
  'whisper-cli': 'whisper-cli',
  crispasr: 'crispasr',
}

export function isAsrHarnessId(value: unknown): value is AsrHarnessId {
  return (
    typeof value === 'string' &&
    (ASR_HARNESS_IDS as readonly string[]).includes(value)
  )
}

/** Env var that overrides the Harness in the app. Dev builds only. */
export const ASR_HARNESS_ENV_VAR = 'CODICTATE_ASR_HARNESS'
