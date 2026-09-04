/**
 * The public surface, pinned.
 *
 * `index.ts` is what the external harness and the website reader import, so its export
 * set is part of the contract rather than an implementation detail. This file exists so
 * the set lives somewhere that **fails when it goes stale**, instead of in a prose
 * sentence counting exports - a number in a document is wrong one commit after it is
 * written, and nobody finds out.
 *
 * Two properties, and they catch different mistakes:
 *
 * 1. **The exact list.** Adding or removing a name is a contract change and has to be a
 *    deliberate edit here, which is what makes it show up in review and in the diff the
 *    sibling repositories read.
 * 2. **Nothing is stranded.** Every runtime export of every module has to be reachable
 *    through `index.ts`. The failure this prevents is the quiet one: a new helper is added
 *    to `selection.ts`, the local tests import it directly and pass, and the external repo
 *    cannot see it at all.
 */

import { describe, expect, test } from "bun:test";
import * as contract from "./index";
import * as clipIdentity from "./clip-identity";
import * as schema from "./schema";
import * as selection from "./selection";
import * as aggregation from "./aggregation";
import * as timing from "./timing";
import * as harness from "./harness";
import * as v1Leaf from "./v1-leaf";

/**
 * Every value `benchmarks/contract/index.ts` exports, sorted.
 *
 * Types are absent because they do not exist at runtime; they are re-exported alongside
 * these and are covered by the type-check rather than by this list.
 */
const PUBLIC_RUNTIME_EXPORTS = [
  "FINGERPRINT_VERSION",
  "FLEURS_SPLIT",
  "HARNESS_CODICTATE",
  "HARNESS_WISPR_FLOW",
  "HOTKEY_EDGE_KEYDOWN",
  "INSTRUMENTATION_ASYMMETRY_LABEL",
  "LEAF_SPEED_V2_FIELD",
  "MEASURING_HARNESSES",
  "RESUME_FORBIDDEN_FLAGS",
  "RUN_STATUSES",
  "SAMPLE_STATUSES",
  "SCHEMA_VERSION",
  "SCHEMA_VERSION_KEY",
  "STABILITY_DELAY_MS",
  "TIMING_CLOCK_MONOTONIC",
  "TIMING_REGIME_LABELS",
  "V1_EXTERNAL_PRODUCT_LABEL",
  "V1_FINGERPRINT_FORMATS",
  "assertNoOverlappingIncompleteRun",
  "assertResumeFlags",
  "assertRunPlanOnDisk",
  "assertRunRecordAgreesWithPlan",
  "assertUniqueClipIds",
  "assertV2OnV1Leaf",
  "buildRunPlan",
  "clipIdFromAbsoluteAudioPath",
  "clipIdFromRelativeAudioPath",
  "compatibilityKey",
  "contiguousCursor",
  "fingerprintV2",
  "fingerprintV2Matches",
  "fingerprintV2Record",
  "fleursClipId",
  "isCompletedRunRecordV2",
  "isExternalProduct",
  "isFingerprintV2",
  "isMeasuringHarness",
  "isRunPlan",
  "isRunPlanRefV2",
  "isRunRecordV2",
  "isRunStatus",
  "isSampleMeasurementV2",
  "isSampleStatus",
  "isScoredSample",
  "isSuccessfulSample",
  "isV2OnV1Leaf",
  "librispeechClipId",
  "maxMeasuredEnd",
  "median",
  "normalizeRunRecordV2",
  "overlappingClipIds",
  "overlaps",
  "p90",
  "percentileNearestRank",
  "poolSamples",
  "poolableSpeedTotals",
  "pooledCer",
  "pooledInferenceRtf",
  "pooledSampleCount",
  "pooledSpeed",
  "pooledWer",
  "publishableWallRtf",
  "requiresAsymmetryLabel",
  "responseMsFromWindow",
  "responseMsPerAudioSec",
  "resumeSelection",
  "runPlanComplaints",
  "runPlanRef",
  "seriesSamples",
  "spansBothProducts",
  "speedCompatible",
  "stabilityConfirmedAtMs",
  "statedBiasMs",
  "uniqueInOrder",
  "v2OnV1LeafComplaints",
  "wallRtfFromResponseRatio",
] as const;

describe("the public surface", () => {
  test("it is exactly this set of names", () => {
    expect(Object.keys(contract).sort()).toEqual([...PUBLIC_RUNTIME_EXPORTS]);
  });

  test("every module export is reachable through index.ts", () => {
    const reachable = new Set(Object.keys(contract));
    for (const [moduleName, module] of [
      ["clip-identity", clipIdentity],
      ["schema", schema],
      ["selection", selection],
      ["aggregation", aggregation],
      ["timing", timing],
      ["harness", harness],
      ["v1-leaf", v1Leaf],
    ] as const) {
      for (const name of Object.keys(module)) {
        expect(
          reachable.has(name),
          `${moduleName}.ts exports "${name}" but index.ts does not re-export it, so the ` +
            `sibling repositories cannot reach it`,
        ).toBe(true);
      }
    }
  });

  test("index.ts re-exports the same value, not a copy", () => {
    // A hand-written re-export can drift into a wrapper. These have to be the same
    // functions the modules define, or a caller importing from `index` and a caller
    // importing the module directly would be running different code.
    expect(contract.fingerprintV2).toBe(schema.fingerprintV2);
    expect(contract.poolSamples).toBe(aggregation.poolSamples);
    expect(contract.speedCompatible).toBe(timing.speedCompatible);
    expect(contract.buildRunPlan).toBe(selection.buildRunPlan);
    expect(contract.fleursClipId).toBe(clipIdentity.fleursClipId);
    expect(contract.spansBothProducts).toBe(harness.spansBothProducts);
    expect(contract.publishableWallRtf).toBe(v1Leaf.publishableWallRtf);
  });
});
