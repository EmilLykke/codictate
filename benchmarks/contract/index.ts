/**
 * The benchmark-v2 contract: the public surface two repositories agree on.
 *
 * `codictate` owns it; `dictation-product-benchmark` consumes it through the required
 * sibling checkout (`config.codictatePath`) and, where a direct import is not workable
 * from its build, re-implements it and proves byte-identical behaviour against
 * `fixtures/fingerprint-v2.json`. Either way this file is the list of names that may be
 * relied on - anything not re-exported here is an implementation detail and may move.
 *
 * Every module below is pure: no filesystem, no network, no clock, no globals. The one
 * exception is `node:crypto` in `schema.ts`, for sha256. Callers inject the data. That
 * is what makes the contract testable without a datasets directory and shareable with a
 * harness that has no Codictate build.
 *
 * The prose contract is `docs/BENCHMARK_CONTRACT.md`; it is the document to read first
 * and the one to change when a rule changes.
 */

export {
  assertUniqueClipIds,
  clipIdFromAbsoluteAudioPath,
  clipIdFromRelativeAudioPath,
  fleursClipId,
  FLEURS_SPLIT,
  librispeechClipId,
  uniqueInOrder,
} from "./clip-identity";

export {
  assertRunRecordAgreesWithPlan,
  FINGERPRINT_VERSION,
  fingerprintV2,
  fingerprintV2Matches,
  fingerprintV2Record,
  isCompletedRunRecordV2,
  isFingerprintV2,
  isRunPlanRefV2,
  isRunRecordV2,
  isRunStatus,
  isSampleMeasurementV2,
  isSampleStatus,
  isScoredSample,
  isSuccessfulSample,
  normalizeRunRecordV2,
  RUN_STATUSES,
  SAMPLE_STATUSES,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  type FingerprintV2,
  type RunPlanRefV2,
  type RunRecordV2,
  type RunStatus,
  type SampleMeasurementV2,
  type SampleOverheadV2,
  type SampleStatus,
} from "./schema";

export {
  assertNoOverlappingIncompleteRun,
  assertResumeFlags,
  buildRunPlan,
  assertRunPlanOnDisk,
  contiguousCursor,
  isRunPlan,
  maxMeasuredEnd,
  overlappingClipIds,
  overlaps,
  RESUME_FORBIDDEN_FLAGS,
  resumeSelection,
  runPlanComplaints,
  runPlanRef,
  type BuildRunPlanInput,
  type IncompleteRunRef,
  type ResumeForbiddenFlag,
  type ResumeSelection,
  type RunPlan,
} from "./selection";

export {
  compatibilityKey,
  median,
  p90,
  percentileNearestRank,
  pooledCer,
  pooledInferenceRtf,
  pooledSampleCount,
  pooledSpeed,
  pooledWer,
  poolSamples,
  seriesSamples,
  type AccuracyLeafV2,
  type PoolBucket,
  type PooledAccuracy,
  type PooledInferenceRtf,
  type PooledSample,
  type PoolResult,
  type PoolSkipReason,
  type ReplacedSample,
  type SkippedRun,
  type SpeedSummary,
} from "./aggregation";

export {
  HOTKEY_EDGE_KEYDOWN,
  INSTRUMENTATION_ASYMMETRY_LABEL,
  responseMsFromWindow,
  responseMsPerAudioSec,
  speedCompatible,
  stabilityConfirmedAtMs,
  STABILITY_DELAY_MS,
  requiresAsymmetryLabel,
  statedBiasMs,
  TIMING_CLOCK_MONOTONIC,
  TIMING_REGIME_LABELS,
  wallRtfFromResponseRatio,
  type DirectAdapterWindow,
  type SpeedProvenance,
  type TimingRegime,
  type TimingWindow,
  type UiObservation,
  type UiObservedWindow,
} from "./timing";

export {
  HARNESS_CODICTATE,
  HARNESS_WISPR_FLOW,
  isExternalProduct,
  isMeasuringHarness,
  MEASURING_HARNESSES,
  spansBothProducts,
  V1_EXTERNAL_PRODUCT_LABEL,
  type MeasuringHarness,
} from "./harness";

export {
  assertV2OnV1Leaf,
  isV2OnV1Leaf,
  LEAF_SPEED_V2_FIELD,
  poolableSpeedTotals,
  publishableWallRtf,
  V1_FINGERPRINT_FORMATS,
  v2OnV1LeafComplaints,
  type LeafFailuresByStatus,
  type LeafInferenceDiagnostic,
  type LeafSampleRange,
  type LeafSpeedV2,
  type V2OnV1Leaf,
} from "./v1-leaf";
