/**
 * The timing window, and the 750 ms that must stay outside it.
 *
 * Two failure modes are pinned here, and both favour one product over the other by
 * tens or hundreds of milliseconds without changing a line of visible output:
 *
 * 1. A Wispr Flow start timestamp taken *after* `post(hotkey)` returns excludes the
 *    sleep between the Option and the Z transitions - roughly 20-70 ms of the
 *    product's own window, in its favour.
 * 2. The harness's own 750 ms stability-confirmation wait, if it lands inside the
 *    window, adds a flat 750 ms to every Wispr Flow Sample and to nothing of
 *    Codictate's.
 */

import { describe, expect, test } from "bun:test";
import {
  HOTKEY_EDGE_KEYDOWN,
  INSTRUMENTATION_ASYMMETRY_LABEL,
  responseMsFromWindow,
  responseMsPerAudioSec,
  speedCompatible,
  stabilityConfirmedAtMs,
  STABILITY_DELAY_MS,
  statedBiasMs,
  TIMING_CLOCK_MONOTONIC,
  TIMING_REGIME_LABELS,
  wallRtfFromResponseRatio,
  type DirectAdapterWindow,
  type UiObservedWindow,
} from "./timing";

const direct: DirectAdapterWindow = {
  regime: "direct-adapter",
  startedAtMs: 1_000,
  transcriptReturnedAtMs: 2_450,
};

const uiObserved: UiObservedWindow = {
  regime: "ui-observed-paste",
  startedAtMs: 1_000,
  lastTextChangeAtMs: 3_200,
  observation: "text-change-event",
  stabilityDelayMs: STABILITY_DELAY_MS,
};

describe("one formula, two regimes", () => {
  test("the direct window is adapter in to final transcript out", () => {
    expect(responseMsFromWindow(direct)).toBe(1_450);
  });

  test("the UI window is the Z keydown edge to the last pasted-text change", () => {
    expect(responseMsFromWindow(uiObserved)).toBe(2_200);
  });

  test("a window that ends before it starts is refused", () => {
    // Two clocks, not a fast transcription. A negative responseMs would pool as a
    // discount on every other clip in the bucket.
    expect(() =>
      responseMsFromWindow({ ...direct, transcriptReturnedAtMs: 900 }),
    ).toThrow(/before it started/);
  });

  test("a start timestamp taken after the hotkey post shortens the window", () => {
    // The defect, as arithmetic: the modifier-to-key sleep is inside the product's
    // window and a post-return timestamp drops it.
    const modifierToKeySleepMs = 40;
    const late: UiObservedWindow = {
      ...uiObserved,
      startedAtMs: uiObserved.startedAtMs + modifierToKeySleepMs,
    };
    expect(responseMsFromWindow(uiObserved) - responseMsFromWindow(late)).toBe(
      modifierToKeySleepMs,
    );
  });
});

describe("the 750 ms stability delay is outside the metric", () => {
  test("the confirmation instant is after the window closes", () => {
    expect(STABILITY_DELAY_MS).toBe(750);
    const confirmedMs =
      stabilityConfirmedAtMs(uiObserved) - uiObserved.startedAtMs;
    expect(responseMsFromWindow(uiObserved)).toBe(2_200);
    expect(confirmedMs).toBe(2_950);
    expect(responseMsFromWindow(uiObserved)).toBeLessThan(confirmedMs);
    expect(confirmedMs - responseMsFromWindow(uiObserved)).toBe(
      STABILITY_DELAY_MS,
    );
  });

  test("waiting longer does not change the measurement", () => {
    // Structural, not subtractive: the window ends at the last text change, so there is
    // no delay to subtract and no way to subtract it twice.
    const patient: UiObservedWindow = {
      ...uiObserved,
      stabilityDelayMs: 5_000,
    };
    expect(responseMsFromWindow(patient)).toBe(
      responseMsFromWindow(uiObserved),
    );
  });
});

describe("polling is a fallback, and it says so", () => {
  test("a polled Sample carries its interval as a stated bias", () => {
    const polled: UiObservedWindow = {
      ...uiObserved,
      observation: "polling",
      pollIntervalMs: 50,
    };
    expect(statedBiasMs(polled)).toBe(50);
    // Reported next to the number, never folded into it: a corrected bias is
    // indistinguishable from a measurement.
    expect(responseMsFromWindow(polled)).toBe(responseMsFromWindow(uiObserved));
  });

  test("an event-observed or direct Sample admits no bias", () => {
    expect(statedBiasMs(uiObserved)).toBe(0);
    expect(statedBiasMs(direct)).toBe(0);
  });
});

describe("the pooled speed formula is shared", () => {
  test("it is ms of response over seconds of audio", () => {
    expect(responseMsPerAudioSec(3_000, 20)).toBe(150);
    expect(responseMsPerAudioSec(0, 20)).toBe(0);
  });

  test("no audio gives null, not zero", () => {
    // Unlike `benchmarks/stt/rtf.ts::computeRtf`, which returns 0 for legacy reasons.
    // Zero is the fastest possible answer, so it must not also spell "unmeasured".
    expect(responseMsPerAudioSec(1_000, 0)).toBeNull();
    expect(responseMsPerAudioSec(1_000, -5)).toBeNull();
  });
});

describe("which Samples may enter a pooled speed number", () => {
  test("a direct-adapter Sample needs no hotkey provenance", () => {
    // The regime trap: a direct adapter call has no hotkey to have an edge, so a filter
    // written for Flow alone would exclude every Codictate Sample.
    expect(
      speedCompatible({ overhead: { timingRegime: "direct-adapter" } }),
    ).toBe(true);
    expect(
      speedCompatible({
        overhead: { timingRegime: "direct-adapter", inferenceMs: 1500 },
      }),
    ).toBe(true);
  });

  test("a UI-observed Sample needs the keydown edge and a monotonic clock", () => {
    expect(
      speedCompatible({
        overhead: {
          timingRegime: "ui-observed-paste",
          hotkeyEdge: HOTKEY_EDGE_KEYDOWN,
          timingClock: TIMING_CLOCK_MONOTONIC,
        },
      }),
    ).toBe(true);
    // Missing either half, or holding the wrong value, means the ~81-90 ms optimistic
    // instrumentation cannot be ruled out.
    for (const overhead of [
      { timingRegime: "ui-observed-paste" as const },
      { timingRegime: "ui-observed-paste" as const, hotkeyEdge: "keydown" },
      { timingRegime: "ui-observed-paste" as const, timingClock: "monotonic" },
      {
        timingRegime: "ui-observed-paste" as const,
        hotkeyEdge: "keyup",
        timingClock: "monotonic",
      },
      {
        timingRegime: "ui-observed-paste" as const,
        hotkeyEdge: "keydown",
        timingClock: "wall",
      },
    ]) {
      expect(speedCompatible({ overhead })).toBe(false);
    }
  });

  test("an absent or unknown regime is incompatible", () => {
    // Conservative on purpose: excluding a Sample is recoverable, publishing a
    // flattering wrong number is not.
    expect(speedCompatible({})).toBe(false);
    expect(speedCompatible({ overhead: {} })).toBe(false);
    expect(speedCompatible({ overhead: null })).toBe(false);
    expect(speedCompatible({ overhead: { timingRegime: null } })).toBe(false);
    expect(speedCompatible({ overhead: { inferenceMs: 1500 } })).toBe(false);
  });

  test("the constants are the values a record has to carry", () => {
    expect(HOTKEY_EDGE_KEYDOWN).toBe("keydown");
    expect(TIMING_CLOCK_MONOTONIC).toBe("monotonic");
    // The regime values are the same two labels the asymmetry sentence is built from.
    expect(Object.keys(TIMING_REGIME_LABELS).sort()).toEqual([
      "direct-adapter",
      "ui-observed-paste",
    ]);
  });
});

describe("wall-clock RTF is derived, not measured again", () => {
  test("it is the response ratio in seconds", () => {
    expect(wallRtfFromResponseRatio(responseMsPerAudioSec(3_000, 20))).toBe(
      0.15,
    );
    expect(wallRtfFromResponseRatio(1_000)).toBe(1);
    expect(wallRtfFromResponseRatio(0)).toBe(0);
  });

  test("an unmeasured ratio has no RTF", () => {
    // null in, null out. A zero here would be a real-time-factor of "instant" for a
    // bucket where nothing succeeded.
    expect(wallRtfFromResponseRatio(null)).toBeNull();
    expect(
      wallRtfFromResponseRatio(responseMsPerAudioSec(1_000, 0)),
    ).toBeNull();
  });

  test("there is one derivation, so a chart and a report cannot disagree", () => {
    // `benchmarks/stt/charts.py` arithmetically averaged per-dataset RTFs. Anything that
    // needs this number calls this function over the pooled ratio.
    const pooledRatio = responseMsPerAudioSec(1_450 + 2_200, 25);
    expect(wallRtfFromResponseRatio(pooledRatio)).toBeCloseTo(
      (1_450 + 2_200) / 1000 / 25,
      12,
    );
  });
});

describe("the published instrumentation asymmetry", () => {
  test("one sentence, one constant, both regimes named", () => {
    // Report output, chart captions and subtitles, and the staging reader all print
    // this string. Three paraphrases is how a reader ends up believing the two numbers
    // are the same measurement.
    expect(INSTRUMENTATION_ASYMMETRY_LABEL).toContain(
      TIMING_REGIME_LABELS["direct-adapter"],
    );
    expect(INSTRUMENTATION_ASYMMETRY_LABEL).toContain(
      TIMING_REGIME_LABELS["ui-observed-paste"],
    );
    expect(INSTRUMENTATION_ASYMMETRY_LABEL).toContain("Codictate");
    expect(INSTRUMENTATION_ASYMMETRY_LABEL).toContain("Wispr Flow");
    expect(INSTRUMENTATION_ASYMMETRY_LABEL.split(". ").length).toBe(1);
  });
});
