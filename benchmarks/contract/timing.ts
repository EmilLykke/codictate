/**
 * The timing window: what `responseMs` measures, and the two different things it
 * measures in the two Harnesses.
 *
 * Codictate can call its Speech Engine Adapter directly. Wispr Flow cannot be called
 * at all - it is a shipped product with a global shortcut - so it is measured the only
 * way it can be: press the hotkey, watch the text appear in a capture window. Those
 * are not the same measurement and no arithmetic makes them the same, so the contract
 * is not "make them comparable" but **state the asymmetry everywhere a number from
 * both appears**. `INSTRUMENTATION_ASYMMETRY_LABEL` is that sentence, exported as one
 * constant so the report, the chart subtitle and the staging reader print it
 * identically rather than three paraphrases that drift.
 *
 * What the two regimes do share is the pooled ratio: `responseMsPerAudioSec` below is
 * the one implementation both call. Two copies of a division is how the published
 * comparison starts comparing two formulas.
 *
 * Pure arithmetic and types. Timestamps are injected as milliseconds by the caller;
 * nothing here reads a clock.
 */

/**
 * The stability-confirmation delay the Wispr Flow harness waits after the last text
 * change before it decides the paste is finished.
 *
 * **Excluded from `responseMs`.** It is the harness's own patience, not the product's
 * latency: the response ended at the last text change, and this delay is how long the
 * harness waits to be sure there will not be another one. Including it would add a
 * flat 750 ms to every Wispr Flow Sample and to nothing of Codictate's, which is a
 * 750 ms handicap presented as a measurement.
 *
 * The exclusion is structural rather than subtractive - `responseMsFromWindow` ends at
 * `lastTextChangeAtMs`, which is before the wait begins - so there is no delay to
 * subtract and no risk of subtracting it twice. `stabilityConfirmedAtMs` exists so a
 * test can assert the confirmation instant is outside the window.
 */
export const STABILITY_DELAY_MS = 750;

import { spansBothProducts } from "./harness";

/** Which instrumentation produced a `responseMs`. */
export type TimingRegime = "direct-adapter" | "ui-observed-paste";

/**
 * One clause per regime, for a table cell or a legend entry. The full sentence is
 * `INSTRUMENTATION_ASYMMETRY_LABEL`.
 */
export const TIMING_REGIME_LABELS: Record<TimingRegime, string> = {
  "direct-adapter": "direct adapter call boundary",
  "ui-observed-paste": "UI-observed paste",
};

/**
 * The one sentence every surface that shows both products must print.
 *
 * Exported as a constant because three surfaces in two repositories have to say the
 * same thing: the report output, the chart captions and subtitles, and the staging
 * reader. A paraphrase in one of them is how a reader ends up believing the two
 * numbers are the same measurement.
 */
export const INSTRUMENTATION_ASYMMETRY_LABEL =
  "Response times are not measured the same way for both products: Codictate is timed at " +
  "the direct adapter call boundary, Wispr Flow is timed from the UI-observed paste.";

/**
 * Whether a surface showing these harnesses **must** print
 * `INSTRUMENTATION_ASYMMETRY_LABEL`.
 *
 * The published-label requirement as a function, because as a rule in prose it was already
 * missed once: a reader knew the external product only as `external-product` while the
 * external harness writes `wispr-flow`, so the two never matched, and the sentence
 * disclosing that the two numbers are measured differently simply never rendered. Nothing
 * failed - it just silently stopped being said, on the one surface that shows both
 * products. `harness.ts::spansBothProducts` accepts either spelling.
 */
export function requiresAsymmetryLabel(harnesses: Iterable<string>): boolean {
  return spansBothProducts(harnesses);
}

/**
 * Codictate's window: adapter in, final transcript out.
 *
 * Nothing else may sit inside it - no manifest read, no WAV read, no logging. Those
 * are the harness's costs and they would be charged to the Speech Model. Paste and UI
 * overhead are excluded because Codictate's harness never pastes.
 */
export interface DirectAdapterWindow {
  regime: "direct-adapter";
  /** Taken on the statement immediately before the adapter invocation. */
  startedAtMs: number;
  /** Taken when the adapter returns the final transcript. */
  transcriptReturnedAtMs: number;
}

/**
 * How the pasted text was watched.
 *
 * `text-change-event` is the accurate one and the default. `polling` is a fallback,
 * and a Sample measured by polling has a stated bias of up to one interval, so the
 * interval is recorded on the record rather than left for a reader to guess. A record
 * that does not say which of the two it used cannot be corrected later.
 */
export type UiObservation = "text-change-event" | "polling";

/**
 * Wispr Flow's window: the Z keydown edge to the last pasted-text change.
 *
 * `startedAtMs` is taken **immediately before the Z keydown event is posted**, not
 * after `post(hotkey)` returns. Option is held first, and the existing code sleeps
 * between the modifier and the key transition, so a timestamp taken after the post
 * silently excludes that sleep - roughly 20-70 ms of the product's own window, in the
 * product's favour. The stop edge follows the same rule: the stop timestamp is the Z
 * keydown edge of the stop hotkey, before any inter-transition sleep.
 *
 * Lead/tail audio setup happens before the stop timestamp, and restoring the previous
 * output device happens after `lastTextChangeAtMs`, so neither is inside the window.
 */
export interface UiObservedWindow {
  regime: "ui-observed-paste";
  /** The instant the Z keydown of the start hotkey is posted. */
  startedAtMs: number;
  /** The last observed change to the pasted text. The end of the response. */
  lastTextChangeAtMs: number;
  observation: UiObservation;
  /** The polling interval, when `observation` is `polling`. A stated bias. */
  pollIntervalMs?: number;
  /**
   * The stability delay this run waited, recorded so the record says what was
   * configured. Outside the window; see `STABILITY_DELAY_MS`.
   */
  stabilityDelayMs: number;
}

export type TimingWindow = DirectAdapterWindow | UiObservedWindow;

/**
 * The `responseMs` of a window.
 *
 * One function for both regimes, so neither can quietly gain a term. Refuses a
 * negative duration rather than returning one: a window that ends before it starts
 * means the two timestamps came from different clocks, and a negative `responseMs`
 * would pool as a discount on every other clip.
 */
export function responseMsFromWindow(window: TimingWindow): number {
  const endedAtMs =
    window.regime === "direct-adapter"
      ? window.transcriptReturnedAtMs
      : window.lastTextChangeAtMs;
  const durationMs = endedAtMs - window.startedAtMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(
      `A ${window.regime} timing window ended ${-durationMs} ms before it started. ` +
        `Both timestamps must come from the same monotonic clock.`,
    );
  }
  return durationMs;
}

/**
 * When the Wispr Flow harness will have confirmed the paste is stable.
 *
 * After the window closes, by exactly `stabilityDelayMs`. Exported so the exclusion is
 * assertable: `responseMsFromWindow(w) < stabilityConfirmedAtMs(w) - w.startedAtMs` is
 * the acceptance gate for "the 750 ms stability delay does not enter the metric".
 */
export function stabilityConfirmedAtMs(window: UiObservedWindow): number {
  return window.lastTextChangeAtMs + window.stabilityDelayMs;
}

/**
 * The measurement bias a window admits to, in milliseconds.
 *
 * One polling interval for a polled Sample, zero otherwise. Reported next to the
 * number rather than folded into it: a bias that has been silently corrected for is
 * indistinguishable from a measurement.
 */
export function statedBiasMs(window: TimingWindow): number {
  if (
    window.regime === "ui-observed-paste" &&
    window.observation === "polling"
  ) {
    return window.pollIntervalMs ?? 0;
  }
  return 0;
}

/**
 * The hotkey edge a UI-observed `startedAt` must have been taken on.
 *
 * The keydown edge, not the keyup and not the return of `post(hotkey)`. See
 * `UiObservedWindow.startedAtMs`.
 */
export const HOTKEY_EDGE_KEYDOWN = "keydown";

/** The clock a UI-observed window's two timestamps must both come from. */
export const TIMING_CLOCK_MONOTONIC = "monotonic";

/**
 * The provenance a Sample records about how its `responseMs` was taken.
 *
 * Structural rather than `SampleMeasurementV2`, so `timing.ts` owes nothing to
 * `schema.ts` and the dependency stays one-way (`schema` imports `TimingRegime` from
 * here; nothing here imports from there).
 */
export interface SpeedProvenance {
  timingRegime?: TimingRegime | null;
  hotkeyEdge?: string | null;
  timingClock?: string | null;
  [field: string]: number | string | boolean | null | undefined;
}

/**
 * Whether a Sample's `responseMs` may enter a **pooled speed** number.
 *
 * Exported so the external harness and the website reader apply this rule rather than
 * each inventing one. Three cases, and the regime is what makes them different:
 *
 * - **`direct-adapter`** needs no further provenance. There is no hotkey to have an edge
 *   and no keystroke synthesis to sleep between transitions; the window is two
 *   timestamps around one function call.
 * - **`ui-observed-paste`** is compatible only with `hotkeyEdge: "keydown"` **and**
 *   `timingClock: "monotonic"`. A Flow Sample missing either was measured under
 *   instrumentation that ran **~81-90 ms optimistic per clip** - measured, not estimated -
 *   because the start timestamp was taken after `post(hotkey)` returned and therefore
 *   excluded the modifier-to-key sleep. Pooling it would put that discount into the
 *   published comparison.
 * - **An absent `timingRegime` is incompatible**, and this is the deliberately
 *   conservative half. The alternative is to guess, and the failure mode of guessing is
 *   publishing an ~85 ms-optimistic Flow number as though it were comparable to a
 *   Codictate one - the exact defect this whole exercise exists to remove. Excluding a
 *   Sample is recoverable: the clip is still in the corpus, it can be re-measured, and it
 *   stays readable as legacy. Publishing a flattering wrong number is not recoverable,
 *   because it is the number people quote.
 *
 * **This is a speed rule and nothing else.** An incompatible Sample was still attempted,
 * still responded, and its `wordErrors` are still a valid measurement of what the product
 * transcribed: the instrumentation defect moved a timestamp, not a transcript. So it stays
 * in `attemptedCount`, in `respondedCount`, in accuracy pooling and in coverage, and is
 * removed only from the speed numerator, the speed denominator and the raw
 * median/p90 list. `aggregation.ts::pooledSpeed` surfaces how many it dropped as
 * `speedExcludedCount`, so a bucket cannot quietly lose half its speed data in silence.
 */
export function speedCompatible(sample: {
  overhead?: SpeedProvenance | null;
}): boolean {
  const regime = sample.overhead?.timingRegime;
  if (regime === "direct-adapter") return true;
  if (regime !== "ui-observed-paste") return false;
  return (
    sample.overhead?.hotkeyEdge === HOTKEY_EDGE_KEYDOWN &&
    sample.overhead?.timingClock === TIMING_CLOCK_MONOTONIC
  );
}

/**
 * The pooled speed metric: milliseconds of response per second of audio.
 *
 * **Pooled, never a mean of per-clip ratios.** A mean of ratios weights a 2-second clip
 * the same as a 30-second one, so it is a different number from the one it looks like
 * and it is not the speed of the combined sample. This is the same rule
 * `benchmarks/README.md` states for accuracy, applied to the other axis.
 *
 * `null` rather than `0` when there is no audio to divide by, unlike
 * `benchmarks/stt/rtf.ts::computeRtf`, which returns 0 for an empty denominator. That
 * zero is legacy and readable - a v1 leaf's RTF of 0 means "no audio" - but zero is
 * also the best possible speed, so a fresh metric must not spell "unmeasured" that way.
 */
export function responseMsPerAudioSec(
  totalResponseMs: number,
  totalAudioDurationSec: number,
): number | null {
  if (totalAudioDurationSec <= 0) return null;
  return totalResponseMs / totalAudioDurationSec;
}

/**
 * The published wall-clock RTF, derived from the pooled response ratio.
 *
 * ```
 * RTF_wall = (sum(successful responseMs) / 1000) / sum(successful audioDurationSec)
 *          = responseMsPerAudioSec / 1000
 * ```
 *
 * A derived helper rather than a second summation, because the two would drift: the
 * report and `benchmarks/stt/charts.py` each need this number, and the chart script
 * currently arithmetically averages per-dataset RTFs - a mean of means on the speed axis,
 * the same defect the accuracy rule already forbids. There is nothing to measure here
 * that `responseMsPerAudioSec` has not already measured, so there is no per-Sample field
 * behind it and no second chance to get the denominator wrong.
 *
 * `null` in, `null` out: an unmeasured ratio has no RTF, and zero is the fastest possible
 * one.
 */
export function wallRtfFromResponseRatio(
  responseMsPerAudioSecValue: number | null,
): number | null {
  return responseMsPerAudioSecValue === null
    ? null
    : responseMsPerAudioSecValue / 1000;
}
