/**
 * ASR Harness: the binary and CLI contract used to execute a Speech Engine.
 *
 * The Whisper Speech Engine has two Harnesses. `crispasr` is the shipping default:
 * the benchmark measured it faster in 9 of 9 comparisons (median 1.58x), with lower
 * peak memory on all three Speech Models and WER at parity (4.68% vs 4.78% mean).
 * `whisper-cli` stays vendored for one reason only: it is the degrade target when
 * crispasr cannot be resolved. Harness is internal and never exposed to end users.
 *
 * See docs/adr/0002-asr-harness-abstraction.md and CONTEXT.md.
 */

export const ASR_HARNESS_IDS = ['whisper-cli', 'crispasr'] as const

export type AsrHarnessId = (typeof ASR_HARNESS_IDS)[number]

export const DEFAULT_ASR_HARNESS: AsrHarnessId = 'crispasr'

/**
 * The Harness every non-hviske run degrades to when the requested one has no resolvable
 * binary. Transcribing slower is recoverable; not transcribing at all is not.
 */
export const FALLBACK_ASR_HARNESS: AsrHarnessId = 'whisper-cli'

export function isAsrHarnessId(value: unknown): value is AsrHarnessId {
  return (
    typeof value === 'string' &&
    (ASR_HARNESS_IDS as readonly string[]).includes(value)
  )
}

/**
 * Env var that overrides the Harness in the app. Dev builds only.
 *
 * Now that crispasr is the default, this is how a dev goes back to `whisper-cli`
 * (`CODICTATE_ASR_HARNESS=whisper-cli`), for example to A/B a suspected regression.
 */
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

/**
 * Env var that unlocks the prep-only hviske Speech Models. Dev builds only.
 *
 * hviske has its own gate rather than riding on the Harness, because the Harness it needs
 * is now the default: keying hviske off "is the Harness crispasr" would have switched it
 * on for every user the moment crispasr shipped. Its Mirror does not exist yet, so every
 * hviske download would 404. This env var never defaults to on.
 */
export const HVISKE_ENABLE_ENV_VAR = 'CODICTATE_ENABLE_HVISKE'

/** The crispasr backend that hviske Speech Models require. */
export const HVISKE_CRISPASR_BACKEND: CrispasrBackendId = 'cohere'
