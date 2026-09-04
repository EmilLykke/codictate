/**
 * The v2-on-v1 leaf, and the field name that diverged.
 *
 * This file exists because of a published wrong chart. Codictate wrote the pooled speed
 * summary as `speedV2`, the external harness wrote it as `speed`, and nothing anywhere
 * asserted the name. `charts.py` reads `speedV2`, found nothing on every external row,
 * fell back to `meanRTF` - a legacy, unfiltered, differently-defined quotient - and drew
 * it at up to 28x the contract value beside Codictate's correctly-filtered number. No
 * error, no warning, one of the two products in the comparison simply plotted wrong.
 *
 * So the name, the field set and the no-fallback rule are all pinned here, and the golden
 * leaf in `fixtures/v2-on-v1-leaf.json` is copied verbatim to the external repository to
 * be asserted, never regenerated.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertV2OnV1Leaf,
  isV2OnV1Leaf,
  LEAF_SPEED_V2_FIELD,
  poolableSpeedTotals,
  publishableWallRtf,
  V1_FINGERPRINT_FORMATS,
  v2OnV1LeafComplaints,
  type V2OnV1Leaf,
} from "./v1-leaf";

const fixture: { leaf: V2OnV1Leaf; rules: Record<string, unknown> } =
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures", "v2-on-v1-leaf.json"),
      "utf-8",
    ),
  );

/** The golden leaf, freshly parsed so a mutation in one test cannot reach another. */
function leaf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...JSON.parse(JSON.stringify(fixture.leaf)), ...over };
}

describe("the golden leaf", () => {
  test("it satisfies the contract it documents", () => {
    expect(v2OnV1LeafComplaints(fixture.leaf)).toEqual([]);
    expect(isV2OnV1Leaf(fixture.leaf)).toBe(true);
  });

  test("its numbers are internally consistent", () => {
    const {
      wer,
      referenceWords,
      wordErrors,
      failures,
      failuresByStatus,
      speedV2,
    } = fixture.leaf;
    expect(wer * referenceWords).toBe(wordErrors);
    expect(failuresByStatus!.timeout + failuresByStatus!.failed).toBe(failures);
    expect(speedV2.attemptedCount).toBe(
      speedV2.respondedCount + speedV2.failureCount,
    );
    expect(speedV2.wallRtf).toBe(speedV2.responseMsPerAudioSec! / 1000);
  });

  test("meanRTF and speedV2.wallRtf deliberately differ", () => {
    // The teaching point of the fixture. `meanRTF` is session wall clock over all scored
    // Samples; `wallRtf` is the provenance-filtered response quotient over the eight that
    // could be pooled. A fixture where they matched would let a fallback look harmless.
    expect(fixture.leaf.meanRTF).not.toBe(fixture.leaf.speedV2.wallRtf);
    expect(fixture.leaf.meanRTF).toBe(
      fixture.leaf.totalWallSec / fixture.leaf.totalAudioSec,
    );
  });
});

describe("the pooled speed summary has one field name", () => {
  test("it is speedV2", () => {
    expect(LEAF_SPEED_V2_FIELD).toBe("speedV2");
  });

  test("a leaf without it is refused, and the message says why", () => {
    const without = leaf();
    delete without.speedV2;
    expect(isV2OnV1Leaf(without)).toBe(false);
    expect(v2OnV1LeafComplaints(without).join(" ")).toMatch(
      /speedV2 is required on a v2 leaf/,
    );
  });

  test("a summary written as `speed` is refused by name", () => {
    // The actual divergence. Renaming it is the external repo's fix; refusing it here is
    // what stops it recurring in either direction.
    const renamed = leaf();
    renamed.speed = renamed.speedV2;
    delete renamed.speedV2;
    const complaints = v2OnV1LeafComplaints(renamed);
    expect(complaints.join(" ")).toMatch(/"speed" is not the field name/);
    expect(complaints.join(" ")).toMatch(/it is "speedV2"/);
    expect(isV2OnV1Leaf(renamed)).toBe(false);
  });

  test("an incomplete summary is refused", () => {
    const partial = leaf({ speedV2: { wallRtf: 0.15 } });
    expect(v2OnV1LeafComplaints(partial).join(" ")).toMatch(
      /not a complete pooled speed summary/,
    );
    // Every count the contract publishes has to be there, including the two skip counters.
    for (const field of [
      "speedExcludedCount",
      "missingDurationCount",
      "sampleCount",
    ]) {
      const dropped = leaf();
      const summary = { ...(dropped.speedV2 as Record<string, unknown>) };
      delete summary[field];
      expect(isV2OnV1Leaf(leaf({ speedV2: summary }))).toBe(false);
    }
  });
});

describe("no consumer may fall back to meanRTF", () => {
  test("publishableWallRtf reads speedV2 and only speedV2", () => {
    expect(publishableWallRtf(fixture.leaf)).toBe(0.15);
  });

  test("a missing summary means no v2 speed, not the legacy number", () => {
    // `charts.py` did `speed.get("wallRtf", r.get("meanRTF"))`, which is how a Flow row
    // was plotted at 2.8 against Codictate's 0.1.
    // An archived leaf: `meanRTF` and no `speedV2` at all.
    const archived: { speedV2?: undefined; meanRTF: number } = { meanRTF: 2.8 };
    expect(publishableWallRtf(archived)).toBeNull();
    expect(
      publishableWallRtf({ speedV2: null, meanRTF: 2.8 } as never),
    ).toBeNull();
    expect(
      publishableWallRtf({ speedV2: {}, meanRTF: 2.8 } as never),
    ).toBeNull();
  });

  test("a null or non-finite wallRtf is not a number to publish", () => {
    expect(publishableWallRtf({ speedV2: { wallRtf: null } })).toBeNull();
    expect(publishableWallRtf({ speedV2: { wallRtf: Number.NaN } })).toBeNull();
    // Zero is a real measurement and is published.
    expect(publishableWallRtf({ speedV2: { wallRtf: 0 } })).toBe(0);
  });
});

describe("the v2 speed ratio is poolable across leaves", () => {
  test("the filtered numerator and denominator are required", () => {
    for (const field of ["responseMs", "audioDurationSec"]) {
      const summary: Record<string, unknown> = { ...fixture.leaf.speedV2 };
      delete summary[field];
      expect(isV2OnV1Leaf(leaf({ speedV2: summary }))).toBe(false);
      expect(
        v2OnV1LeafComplaints(leaf({ speedV2: summary })).join(" "),
      ).toMatch(/not a complete pooled speed summary/);
    }
  });

  test("they are the sums the ratio came from, and must agree with it", () => {
    const sums = poolableSpeedTotals(fixture.leaf)!;
    expect(sums.responseMs / sums.audioDurationSec).toBe(
      fixture.leaf.speedV2.responseMsPerAudioSec as number,
    );
    // A writer accumulating its own totals beside the ratio can drift from it.
    const drifted = { ...fixture.leaf.speedV2, responseMs: 9000 };
    expect(v2OnV1LeafComplaints(leaf({ speedV2: drifted })).join(" ")).toMatch(
      /implies 112.5 ms\/s but responseMsPerAudioSec says 150/,
    );
    const badRtf = { ...fixture.leaf.speedV2, wallRtf: 0.185 };
    expect(v2OnV1LeafComplaints(leaf({ speedV2: badRtf })).join(" ")).toMatch(
      /wallRtf 0.185 is not responseMsPerAudioSec \/ 1000/,
    );
    const missingRtf = { ...fixture.leaf.speedV2, wallRtf: null };
    expect(
      v2OnV1LeafComplaints(leaf({ speedV2: missingRtf })).join(" "),
    ).toMatch(/wallRtf is not a number/);
  });

  test("no poolable audio means the ratio must be null", () => {
    const nothingPoolable = {
      ...fixture.leaf.speedV2,
      responseMs: 0,
      audioDurationSec: 0,
      responseMsPerAudioSec: null,
      wallRtf: null,
    };
    expect(isV2OnV1Leaf(leaf({ speedV2: nothingPoolable }))).toBe(true);
    // ...and a number there would be a rate over no denominator.
    expect(
      v2OnV1LeafComplaints(
        leaf({ speedV2: { ...nothingPoolable, responseMsPerAudioSec: 150 } }),
      ).join(" "),
    ).toMatch(/no poolable audio .* it must be null/);
  });

  test("the poolable sums are not the legacy totals", () => {
    // 12000 ms over 80 s (the 6 poolable Samples) versus 18.5 s over 100 s (all 10
    // scored). A consumer that reached for `totalAudioSec` as a weight would be weighting
    // a filtered numerator by an unfiltered denominator.
    const sums = poolableSpeedTotals(fixture.leaf)!;
    expect(sums.audioDurationSec).toBe(80);
    expect(fixture.leaf.totalAudioSec).toBe(100);
    expect(sums.audioDurationSec).not.toBe(fixture.leaf.totalAudioSec);
    expect(sums.responseMs / 1000).not.toBe(fixture.leaf.totalWallSec);
  });

  test("a leaf without the sums cannot join a pooled figure", () => {
    const summary: Record<string, unknown> = { ...fixture.leaf.speedV2 };
    delete summary.responseMs;
    delete summary.audioDurationSec;
    expect(poolableSpeedTotals(leaf({ speedV2: summary }) as never)).toBeNull();
    expect(poolableSpeedTotals({ meanRTF: 2.8 } as never)).toBeNull();
    // Its own per-condition number is still displayable.
    expect(publishableWallRtf(leaf({ speedV2: summary }) as never)).toBe(0.15);
  });

  test("pooling two leaves from the sums differs from averaging their ratios", () => {
    // The regression witness, deliberately unbalanced: a 1-second condition that answered
    // slowly and a 99-second condition that answered fast. Averaging the two ratios
    // weights them equally, which is defect 9's error class on the speed axis.
    const slowSmall = { responseMs: 3000, audioDurationSec: 1 }; // 3000 ms/s
    const fastLarge = { responseMs: 9900, audioDurationSec: 99 }; // 100 ms/s

    const pooled =
      (slowSmall.responseMs + fastLarge.responseMs) /
      (slowSmall.audioDurationSec + fastLarge.audioDurationSec);
    const meanOfRatios =
      (slowSmall.responseMs / slowSmall.audioDurationSec +
        fastLarge.responseMs / fastLarge.audioDurationSec) /
      2;

    expect(pooled).toBeCloseTo(129, 6);
    expect(meanOfRatios).toBe(1550);
    // Twelvefold apart, and only the first is the speed of the combined sample.
    expect(meanOfRatios / pooled).toBeGreaterThan(10);
    expect(pooled).not.toBeCloseTo(meanOfRatios, 0);

    // And the same thing through the accessor, on two real leaves.
    const leaves = [
      leaf({
        speedV2: {
          ...fixture.leaf.speedV2,
          ...slowSmall,
          responseMsPerAudioSec: 3000,
          wallRtf: 3,
        },
      }),
      leaf({
        speedV2: {
          ...fixture.leaf.speedV2,
          ...fastLarge,
          responseMsPerAudioSec: 100,
          wallRtf: 0.1,
        },
      }),
    ];
    for (const candidate of leaves) expect(isV2OnV1Leaf(candidate)).toBe(true);

    const totals = leaves.map((candidate) =>
      poolableSpeedTotals(candidate as never)!,
    );
    const summed =
      totals.reduce((acc, t) => acc + t.responseMs, 0) /
      totals.reduce((acc, t) => acc + t.audioDurationSec, 0);
    expect(summed).toBeCloseTo(pooled, 9);
    const averagedWallRtf =
      leaves.reduce(
        (acc, candidate) => acc + publishableWallRtf(candidate as never)!,
        0,
      ) / leaves.length;
    expect(averagedWallRtf * 1000).toBe(meanOfRatios);
    expect(summed).not.toBeCloseTo(averagedWallRtf * 1000, 0);
  });
});

describe("what is required, optional and forbidden", () => {
  test("the accuracy denominator and the whole error count are required", () => {
    for (const field of [
      "wer",
      "referenceWords",
      "wordErrors",
      "utteranceCount",
      "failures",
    ]) {
      const without = leaf();
      delete without[field];
      expect(isV2OnV1Leaf(without)).toBe(false);
      expect(v2OnV1LeafComplaints(without).join(" ")).toMatch(
        new RegExp(`${field} must be a finite number`),
      );
    }
  });

  test("the rate and the counts must agree", () => {
    // A consumer reading `wer` and one reading `wordErrors / referenceWords` must not be
    // able to publish two different numbers off one leaf.
    expect(v2OnV1LeafComplaints(leaf({ wordErrors: 97 })).join(" ")).toMatch(
      /implies 100 word errors but wordErrors says 97/,
    );
  });

  test("the legacy speed fields are required and keep their v1 meaning", () => {
    for (const field of ["meanRTF", "totalWallSec", "totalAudioSec"]) {
      const without = leaf();
      delete without[field];
      expect(isV2OnV1Leaf(without)).toBe(false);
    }
  });

  test("cer, referenceChars and charErrors are all present or all absent", () => {
    const noCer = leaf();
    delete noCer.cer;
    delete noCer.referenceChars;
    delete noCer.charErrors;
    expect(isV2OnV1Leaf(noCer)).toBe(true);

    const halfCer = leaf();
    delete halfCer.charErrors;
    expect(v2OnV1LeafComplaints(halfCer).join(" ")).toMatch(
      /all present or all absent/,
    );
  });

  test("failuresByStatus is optional, and nested when present", () => {
    const without = leaf();
    delete without.failuresByStatus;
    // Codictate cannot report a timeout at all (ADR-0006), so it writes no breakdown.
    expect(isV2OnV1Leaf(without)).toBe(true);

    // Nested, not disjoint: the parts sum to the total.
    expect(
      v2OnV1LeafComplaints(
        leaf({ failuresByStatus: { timeout: 1, failed: 5 } }),
      ).join(" "),
    ).toMatch(/sums to 6 but failures says 2/);
    expect(
      isV2OnV1Leaf(leaf({ failuresByStatus: { timeout: 1.5, failed: 0.5 } })),
    ).toBe(false);
  });

  test("sampleRange is optional, and forbidden on a leaf pooling several runs", () => {
    const range = {
      sampleRange: {
        startIndex: 0,
        endIndex: 10,
        manifestFingerprint: "10:abc",
      },
    };
    expect(isV2OnV1Leaf(leaf(range), { pooledRunCount: 1 })).toBe(true);
    expect(isV2OnV1Leaf(leaf(range), { pooledRunCount: 3 })).toBe(false);
    expect(
      v2OnV1LeafComplaints(leaf(range), { pooledRunCount: 3 }).join(" "),
    ).toMatch(/one range cannot describe several/);
    // Without a run count the rule cannot be evaluated, so it is skipped, not guessed.
    expect(isV2OnV1Leaf(leaf(range))).toBe(true);
    expect(isV2OnV1Leaf(leaf({ sampleRange: { startIndex: 0 } }))).toBe(false);
  });
});

describe("the assertion", () => {
  test("it names the leaf and points at the contract", () => {
    const broken = leaf({ wordErrors: 97 });
    delete broken.speedV2;
    expect(() =>
      assertV2OnV1Leaf(broken, { label: "fleurs/da_dk large-v3" }),
    ).toThrow(
      /^fleurs\/da_dk large-v3 does not match the published leaf contract/,
    );
    expect(() => assertV2OnV1Leaf(broken)).toThrow(
      /docs\/BENCHMARK_CONTRACT\.md/,
    );
    // Everything at once, not the first problem.
    expect(v2OnV1LeafComplaints(broken).length).toBeGreaterThan(1);
  });

  test("a valid leaf passes", () => {
    expect(() => assertV2OnV1Leaf(fixture.leaf)).not.toThrow();
    expect(() => assertV2OnV1Leaf(null)).toThrow(/it is not an object/);
  });
});

describe("there are two v1 fingerprint formats", () => {
  test("and they are recorded as such", () => {
    // The canonical comment used to assert there was one, which is how someone eventually
    // writes the comparison. Codictate: `3:efdb04c4041c2ba1`. External:
    // `sha256:966cacb8b651...`. Neither is ever compared to the other, or to a v2 value.
    expect(V1_FINGERPRINT_FORMATS.codictate).toBe("<count>:<16 hex>");
    expect(V1_FINGERPRINT_FORMATS.wisprFlow).toBe("sha256:<64 hex>");
    expect(V1_FINGERPRINT_FORMATS.codictate).not.toBe(
      V1_FINGERPRINT_FORMATS.wisprFlow,
    );
  });
});
