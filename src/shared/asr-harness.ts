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

export function isAsrHarnessId(value: unknown): value is AsrHarnessId {
  return (
    typeof value === 'string' &&
    (ASR_HARNESS_IDS as readonly string[]).includes(value)
  )
}

/** Env var that overrides the Harness in the app. Dev builds only. */
export const ASR_HARNESS_ENV_VAR = 'CODICTATE_ASR_HARNESS'

/**
 * crispasr `--backend` values Codictate names. The vendored binary compiles in ~107
 * backends; only the ones we deliberately drive belong here.
 *
 * `cohere` is the backend that can load hviske GGUF weights. It is valid on the
 * `crispasr` Harness only - `whisper-cli` has no `--backend` flag at all.
 */
export const CRISPASR_BACKEND_IDS = ['cohere'] as const

export type CrispasrBackendId = (typeof CRISPASR_BACKEND_IDS)[number]

/** The Harness that hviske Speech Models require. */
export const HVISKE_ASR_HARNESS: AsrHarnessId = 'crispasr'

/** The crispasr backend that hviske Speech Models require. */
export const HVISKE_CRISPASR_BACKEND: CrispasrBackendId = 'cohere'
