/**
 * ASR Harness: the binary and CLI contract used to execute a Speech Engine.
 *
 * The Whisper Speech Engine has exactly one Harness, `crispasr`. The benchmark settled it
 * against the `whisper-cli` Harness Codictate used to ship: faster in 9 of 9 comparisons
 * (median 1.58x), lower peak memory on all three Speech Models, and WER at parity (4.68%
 * vs 4.78% mean). `whisper-cli` was kept on afterwards only as a degrade target, and has
 * now been retired, so nothing is built from whisper.cpp source at build time.
 *
 * The list stays a list, and this stays its own module, because Harness is a real domain
 * concept rather than an implementation detail of the current binary: a second Harness is
 * a one-line addition here plus its candidate paths. Harness is internal and never exposed
 * to end users - there is deliberately no picker and no env override.
 *
 * See docs/adr/0002-asr-harness-abstraction.md and CONTEXT.md.
 */

export const ASR_HARNESS_IDS = ['crispasr'] as const

export type AsrHarnessId = (typeof ASR_HARNESS_IDS)[number]

export const DEFAULT_ASR_HARNESS: AsrHarnessId = 'crispasr'

export function isAsrHarnessId(value: unknown): value is AsrHarnessId {
  return (
    typeof value === 'string' &&
    (ASR_HARNESS_IDS as readonly string[]).includes(value)
  )
}

/**
 * crispasr `--backend` values Codictate names. The vendored binary compiles in ~107
 * backends; only the ones we deliberately drive belong here.
 *
 * `cohere` is the backend that can load hviske GGUF weights.
 */
export const CRISPASR_BACKEND_IDS = ['cohere'] as const

export type CrispasrBackendId = (typeof CRISPASR_BACKEND_IDS)[number]

/** The Harness that hviske Speech Models require. */
export const HVISKE_ASR_HARNESS: AsrHarnessId = 'crispasr'

/** The crispasr backend that hviske Speech Models require. */
export const HVISKE_CRISPASR_BACKEND: CrispasrBackendId = 'cohere'
