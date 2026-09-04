import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ModelDatasetResult, PeakRSSStats } from "./runner";
import { getSpeechModel } from "../../src/shared/speech-models";
import {
  rateSpeed,
  rateAccuracy,
  rateLanguages,
  modelSupportedLanguages,
  isEnglishOnlyModel,
} from "./rating-utils";
import {
  flattenDatasetResults,
  harnessLabelsPresent,
  parseVariantKey,
  variantModelId,
  DEFAULT_HARNESS_LABEL,
  type DatasetResults,
} from "./results-schema";
import {
  INSTRUMENTATION_ASYMMETRY_LABEL,
  poolableSpeedTotals,
  publishableWallRtf,
  pooledCer,
  pooledWer,
  type AccuracyLeafV2,
  type PooledAccuracy,
} from "../contract";

export interface BenchmarkResults {
  description: string;
  hardware: {
    chip: string;
    ram: string;
    os: string;
    osVersion: string;
  };
  runDate: string;
  config: {
    /**
     * Deepest sample depth this run's leaves reached, i.e. the largest cursor `endIndex`.
     *
     * Not the number of clips the run transcribed. Since `--samples` became a delta, a run
     * can take a Combination from 400 to 800 by transcribing 400 clips, and this says 800 -
     * the depth its leaves sit at, which is what makes two runs comparable.
     */
    sampleSize: number;
    /**
     * Where `sampleSize` came from, because the two possible answers are different
     * claims and only one of them may be labelled "pooled".
     *
     * `"pooled-v2"` means the number is a count of **pooled unique scored clips**, with a
     * Sample on disk behind every one of them. Anything else - including absence - means
     * the number is the v1 *claimed range width*, which every archived run carries and
     * which sits exactly `warmupCount` above its deepest `utteranceCount` (400 against
     * 397, 200 against 197, 50 against 47). Printing that under the pooled wording would
     * claim 400 measured clips where 397 exist and no v2 Sample does - defect 2's own
     * error class, on the aggregate path.
     *
     * Absent on every archived run, which is why absence reads as v1.
     */
    sampleSizeBasis?: "pooled-v2" | "v1-claimed-range";
    warmupCount: number;
    normalization: string;
    /**
     * The depth flag this run was given. Absent on every run written before `--samples`
     * became a delta, which is why it is optional: those runs measured `[0, sampleSize)`
     * and had no other mode to be in.
     */
    sampleSelection?: {
      mode: "delta" | "target";
      requested: number;
    };
  };
  librispeech: DatasetResults;
  fleurs: DatasetResults;
}

const CONDITION_LABELS: Record<string, string> = {
  "test-clean": "English (clean)",
  "test-other": "English (noisy)",
  es_419: "Spanish",
  da_dk: "Danish",
  hu_hu: "Hungarian",
};

/**
 * Row label for a flattened key. Non-default Harnesses are named explicitly so a
 * report that mixes Harnesses stays readable; default-Harness rows read exactly as
 * they did before Harness became a dimension.
 *
 * Retired Harnesses are labelled by exactly the same rule as live ones. Archived
 * `whisper-cli` rows keep their `[whisper-cli]` tag, which is what keeps the
 * crispasr-vs-whisper comparison a comparison after whisper-cli left the build.
 * `harnessLegend` names the untagged Harness so nothing rests on the reader knowing
 * which one is shipping.
 */
function modelName(key: string): string {
  const { modelId, harness } = parseVariantKey(key);
  const suffix = harness === DEFAULT_HARNESS_LABEL ? "" : ` [${harness}]`;
  const model = getSpeechModel(modelId);
  if (!model) return `${modelId}${suffix}`;
  const parts = [model.label];
  const qMatch = modelId.match(/-?(q\d+_\d+)/);
  if (qMatch) parts.push(qMatch[1]);
  else parts.push("full");
  if (modelId.includes(".en")) parts.push("en");
  if (modelId.includes("-tdrz")) parts.push("tdrz");
  return `${parts.join(" ")}${suffix}`;
}

function modelDiskMB(key: string): number | null {
  return getSpeechModel(variantModelId(key))?.downloadSizeMB ?? null;
}

function conditionLabel(key: string): string {
  return CONDITION_LABELS[key] ?? key;
}

function fmtAccuracy(wer: number): string {
  if (wer < 0) return "N/A";
  return `${((1 - wer) * 100).toFixed(1)}%`;
}

function fmtCharAccuracy(cer: number | undefined): string {
  if (cer === undefined || cer === null) return "N/A";
  if (cer < 0) return "N/A";
  return `${((1 - cer) * 100).toFixed(1)}%`;
}

function isFleurs(key: string): boolean {
  return !key.startsWith("test-");
}

function fmtSpeed(rtf: number): string {
  if (rtf <= 0) return "N/A";
  const ms = Math.round(rtf * 1000);
  return `${ms} ms`;
}

/**
 * One leaf's speed, read from `speedV2.wallRtf` - the field the contract publishes -
 * and never substituted with `meanRTF`.
 *
 * The substitution is the bug this replaces. `wallRtf: null` means "no publishable v2
 * speed", and `meanRTF` on the same leaf is a *different measurement*: session wall clock
 * over audio, over all scored Samples. For a Wispr Flow leaf whose clips all predate the
 * keydown-edge instrumentation, `wallRtf` is correctly `null` and `meanRTF` is ~15x the
 * v2 ratio, so a fallback plots the wrong product's number as though it were comparable.
 * A legacy figure is shown here, tagged, because the archive has nothing else - never in
 * place of a v2 one.
 */
function leafSpeedCell(result: ModelDatasetResult | undefined): string {
  if (!result) return "-";
  const speed = result.speedV2;
  if (speed) {
    // Through the contract's accessor rather than reading the field here, so the
    // no-fallback precedence is defined in one place for both repositories: it returns
    // `null` for an absent or non-finite `wallRtf` and never looks at `meanRTF`.
    const wallRtf = publishableWallRtf(result);
    const cell = wallRtf === null ? "N/A" : `${Math.round(wallRtf * 1000)} ms`;
    const excluded =
      speed.speedExcludedCount > 0
        ? ` (${speed.speedExcludedCount} of ${speed.respondedCount} responded excluded: no timing provenance)`
        : "";
    return `${cell}${excluded}`;
  }
  const legacy = fmtSpeed(result.meanRTF);
  return legacy === "N/A" ? legacy : `${legacy} (legacy)`;
}

function fmtSize(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${mb} MB`;
}

function fmtRss(mb: number | null): string {
  if (mb === null) return "N/A";
  return fmtSize(mb);
}

interface ConditionData {
  key: string;
  label: string;
  models: Record<string, ModelDatasetResult>;
}

/**
 * One condition per dataset, with the Harness level collapsed into the row keys.
 * Everything below this point works on flat `[key] -> result` maps.
 */
function buildConditions(results: BenchmarkResults): ConditionData[] {
  const conditions: ConditionData[] = [];

  for (const [split, models] of Object.entries(
    flattenDatasetResults(results.librispeech),
  )) {
    conditions.push({ key: split, label: conditionLabel(split), models });
  }

  for (const [lang, models] of Object.entries(
    flattenDatasetResults(results.fleurs),
  )) {
    conditions.push({ key: lang, label: conditionLabel(lang), models });
  }

  return conditions;
}

/**
 * Header line naming every Harness in the run and how its rows are tagged.
 *
 * Row tags alone leave the untagged Harness implicit, which is fine while there is one
 * shipping Harness and misleading the moment which Harness ships changes. Spelling it
 * out keeps an archived report readable on its own terms years later.
 */
function harnessLegend(results: BenchmarkResults): string | null {
  const labels = harnessLabelsPresent(results.librispeech, results.fleurs);
  if (labels.length === 0) return null;
  if (labels.length === 1) return `- **ASR Harness:** ${labels[0]}`;
  const described = labels.map((label) =>
    label === DEFAULT_HARNESS_LABEL
      ? `${label} (untagged rows)`
      : `${label} (rows tagged \`[${label}]\`)`,
  );
  return `- **ASR Harnesses:** ${described.join(", ")}`;
}

/**
 * One result leaf as the two counts an accuracy pool needs, or nothing.
 *
 * The whole of defect 9 lives in this conversion. A leaf carries a *rate* and a
 * denominator, and pooling needs a numerator: `wordErrors` is on every v2 leaf, and for
 * an archived one it is `wer * referenceWords`, which the README has always said is a
 * whole number. A leaf with **no denominator** yields no counts at all and is therefore
 * **skipped** - never folded in as zero errors over zero words, which is a perfect score
 * for a clip nobody scored. The runs written before `referenceWords` existed have no
 * denominator on disk and can never be re-measured, so skipping them is the only honest
 * option and `PooledAccuracy.skippedCount` is how a caller sees how many.
 *
 * A `wer` below zero is the sentinel a leaf carries when the Speech Model was not on
 * disk when the run happened. It measured nothing, so it contributes nothing.
 */
export function accuracyLeafOf(result: ModelDatasetResult): AccuracyLeafV2 {
  if (result.wer < 0) return {};
  const referenceWords = result.referenceWords;
  const wordErrors =
    result.wordErrors ??
    (referenceWords === undefined ? undefined : result.wer * referenceWords);

  const referenceChars = result.referenceChars;
  const charErrors =
    result.charErrors ??
    (result.cer === undefined || result.cer < 0 || referenceChars === undefined
      ? undefined
      : result.cer * referenceChars);

  return { wordErrors, referenceWords, charErrors, referenceChars };
}

/**
 * The **pooled** WER across a set of conditions for one row, `sum(errors) / sum(refs)`.
 *
 * Never a mean of per-dataset rates. An unweighted mean weights a 908-clip Spanish pool
 * the same as a 5-clip smoke slice, so it is a different number from the one it looks
 * like and it is not the accuracy of the combined sample. `benchmarks/README.md` has said
 * so since `referenceWords` was added, and this is the code catching up with it.
 */
export function pooledWerForConditions(
  modelId: string,
  conditions: ConditionData[],
): PooledAccuracy {
  return pooledWer(
    conditions
      .map((condition) => condition.models[modelId])
      .filter((result): result is ModelDatasetResult => result !== undefined)
      .map(accuracyLeafOf),
  );
}

/** The pooled CER across a set of conditions for one row. Same rule, same skips. */
export function pooledCerForConditions(
  modelId: string,
  conditions: ConditionData[],
): PooledAccuracy {
  return pooledCer(
    conditions
      .map((condition) => condition.models[modelId])
      .filter((result): result is ModelDatasetResult => result !== undefined)
      .map(accuracyLeafOf),
  );
}

/** Pooled word accuracy as a fraction, or `-Infinity` when no leaf could be pooled. */
function pooledAccuracyForConditions(
  modelId: string,
  conditions: ConditionData[],
): number {
  const pooled = pooledWerForConditions(modelId, conditions);
  return pooled.rate === null ? -Infinity : 1 - pooled.rate;
}

/**
 * Transcription failures across a set of conditions, and the leaves that never counted.
 *
 * Two numbers because "absent" and "zero" are different claims, and only one of them can
 * be published as a zero. Nothing on disk records *which* utterances failed, so `failures`
 * is the one field a migration could never backfill: an archived leaf without it means
 * "nobody counted", and reporting that as zero would say an engine that produced nothing
 * transcribed perfectly.
 */
export function pooledFailures(
  modelId: string,
  conditions: ConditionData[],
): { counted: number; uncountedLeaves: number } {
  let counted = 0;
  let uncountedLeaves = 0;
  for (const condition of conditions) {
    const result = condition.models[modelId];
    if (!result || result.wer < 0) continue;
    if (typeof result.failures === "number") counted += result.failures;
    else uncountedLeaves++;
  }
  return { counted, uncountedLeaves };
}

function splitConditions(conditions: ConditionData[]): {
  english: ConditionData[];
  multilingual: ConditionData[];
} {
  const english: ConditionData[] = [];
  const multilingual: ConditionData[] = [];
  for (const c of conditions) {
    if (c.key.startsWith("test-")) english.push(c);
    else multilingual.push(c);
  }
  return { english, multilingual };
}

/** Flattened row keys (Model ID, or `modelId@harness` for a non-default Harness). */
function collectModelIds(conditions: ConditionData[]): string[] {
  const ids = new Set<string>();
  for (const c of conditions) {
    for (const id of Object.keys(c.models)) ids.add(id);
  }
  return [...ids].sort();
}

function aggregateRss(
  modelId: string,
  conditions: ConditionData[],
): PeakRSSStats | null {
  const stats: PeakRSSStats[] = [];
  for (const c of conditions) {
    const rss = c.models[modelId]?.peakRSS_MB;
    if (rss) stats.push(rss);
  }
  if (stats.length === 0) return null;
  return {
    min: Math.min(...stats.map((s) => s.min)),
    avg: Math.round(stats.reduce((sum, s) => sum + s.avg, 0) / stats.length),
    max: Math.max(...stats.map((s) => s.max)),
  };
}

/**
 * The **pooled** wall-clock RTF across a set of conditions: total time over total audio.
 *
 * Pooled sums, not a mean of per-dataset RTFs, for the same reason accuracy is pooled: a
 * mean weights a 5-clip condition like a 900-clip one. Equal to
 * `responseMsPerAudioSec / 1000` over the same Samples, which is the field
 * `speedV2.wallRtf` carries per leaf - and `benchmarks/stt/charts.py` computes this same
 * quotient from the same two sums, so the chart and the report cannot disagree.
 *
 * Only successful, speed-compatible Samples are in either sum; `runner.ts` filters both
 * accumulators together, so a Combination that refused its longest clip does not look
 * faster for it.
 */
export interface PooledSpeed {
  /**
   * Milliseconds of response per second of audio, pooled from the **v2** sums
   * (`speedV2.responseMs / speedV2.audioDurationSec`). `null` when no leaf carries a v2
   * summary, or when every v2 Sample was excluded for want of timing provenance.
   *
   * The only number that may be published as a speed.
   */
  v2MsPerAudioSec: number | null;
  /** Conditions that contributed a v2 summary. */
  v2Conditions: number;
  /**
   * The **legacy** v1 quotient, `totalWallSec / totalAudioSec` in ms per audio second,
   * over the leaves that carry no v2 summary.
   *
   * A different measurement, kept separate and never substituted for the one above. The
   * v1 sums are session wall clock over audio across **all** scored Samples - failures
   * and provenance-less Samples included - so folding them into the v2 ratio would pool
   * two definitions under one number. `dictation-product-benchmark` keeps the same v1
   * definition, and its legacy Flow leaves read ~15x its v2 ratio, so the substitution is
   * not a rounding difference: it is the wrong product's number.
   */
  legacyMsPerAudioSec: number | null;
  /** Conditions that could only be read the legacy way. */
  legacyConditions: number;
  /** Scored Samples in the v2 leaves, whatever their status. */
  attemptedSamples: number;
  /** Successful ones: `status: "ok"` with a numeric `responseMs`. */
  respondedSamples: number;
  /**
   * Conditions with a v2 summary that cannot join the pooled figure: no sums, or a zero
   * denominator.
   *
   * Counted rather than weighted by `totalAudioSec`. That substitution would weight a
   * provenance-filtered numerator by an unfiltered denominator - two different sets of
   * Samples - and produce a number that looks like a pooled speed and is not one.
   */
  unpoolableV2Conditions: number;
  /**
   * Responded Samples withheld from the ratio for want of timing provenance.
   *
   * Reported because the whole point of the field is that a bucket cannot lose its speed
   * data in silence: `respondedCount: 400, speedExcludedCount: 400` renders as "N/A", and
   * without this number nothing says that 400 measurements were withheld rather than
   * never taken.
   */
  excludedSamples: number;
}

/**
 * Pooled speed across a set of conditions, with the v2 and legacy answers kept apart.
 *
 * Pooled sums, not a mean of per-dataset RTFs, for the same reason accuracy is pooled: a
 * mean weights a 5-clip condition like a 900-clip one. The v2 numerator and denominator
 * are the same two sums `speedV2.responseMsPerAudioSec` and `speedV2.wallRtf` are derived
 * from, and `benchmarks/stt/charts.py::pooled_ms_per_audio_sec` pools the identical pair
 * with the identical inclusion rule - a leaf contributes iff its
 * `speedV2.audioDurationSec` is above zero - which is what makes acceptance gate 11 hold
 * by construction rather than by inspection.
 */
export function pooledSpeedForConditions(
  modelId: string,
  conditions: ConditionData[],
): PooledSpeed {
  let v2ResponseMs = 0;
  let v2AudioSec = 0;
  let v2Conditions = 0;
  let legacyWallSec = 0;
  let legacyAudioSec = 0;
  let legacyConditions = 0;
  let attemptedSamples = 0;
  let respondedSamples = 0;
  let excludedSamples = 0;
  let unpoolableV2Conditions = 0;

  for (const condition of conditions) {
    const result = condition.models[modelId];
    if (!result) continue;
    const speed = result.speedV2;
    if (speed) {
      attemptedSamples += speed.attemptedCount;
      respondedSamples += speed.respondedCount;
      excludedSamples += speed.speedExcludedCount;
      // The contract's accessor decides whether this leaf may join a pooled figure, and
      // `null` is exactly the cannot-pool case: no sums, or a zero denominator. It is the
      // counterpart to `publishableWallRtf` - one says whether a leaf may be *shown*, the
      // other whether it may be *added* - and going through it keeps the no-fallback rule
      // in one place rather than re-deriving "is this poolable" from a field test here.
      const totals = poolableSpeedTotals(result);
      // `null` is the contract's answer for "the sums are absent or not finite". A
      // present-but-zero denominator adds nothing to either sum, so it is added anyway
      // and simply does not count as a contributing condition - the arithmetic is on the
      // contract's own output rather than a second field test beside it.
      if (totals) {
        v2ResponseMs += totals.responseMs;
        v2AudioSec += totals.audioDurationSec;
      }
      if (totals && totals.audioDurationSec > 0) v2Conditions++;
      else unpoolableV2Conditions++;
      continue;
    }
    // No v2 summary: an archived leaf. Read the legacy way, counted separately.
    if (result.totalAudioSec > 0) {
      legacyWallSec += result.totalWallSec;
      legacyAudioSec += result.totalAudioSec;
      legacyConditions++;
    }
  }

  return {
    v2MsPerAudioSec: v2AudioSec > 0 ? v2ResponseMs / v2AudioSec : null,
    v2Conditions,
    legacyMsPerAudioSec:
      legacyAudioSec > 0 ? (legacyWallSec / legacyAudioSec) * 1000 : null,
    legacyConditions,
    attemptedSamples,
    respondedSamples,
    excludedSamples,
    unpoolableV2Conditions,
  };
}

/**
 * The speed cell for a row: the v2 number when there is one, the legacy number tagged as
 * legacy when there is not, and never one standing in for the other.
 */
function fmtPooledSpeed(speed: PooledSpeed): string {
  if (speed.v2MsPerAudioSec !== null) {
    const cell = `${Math.round(speed.v2MsPerAudioSec)} ms`;
    return speed.excludedSamples > 0
      ? `${cell} (${speed.excludedSamples} excl.)`
      : cell;
  }
  if (speed.excludedSamples > 0) {
    // The case the field exists for: measurements were taken and withheld.
    return `N/A (${speed.excludedSamples} of ${speed.respondedSamples} responded excluded: no timing provenance)`;
  }
  if (speed.legacyMsPerAudioSec !== null) {
    return `${Math.round(speed.legacyMsPerAudioSec)} ms (legacy)`;
  }
  return "N/A";
}

/** The number a row is ranked by. Legacy rows never win the speed column. */
function rankableSpeed(speed: PooledSpeed): number {
  return speed.v2MsPerAudioSec ?? Infinity;
}

interface ModelRatings {
  speed: number;
  accuracy: number;
  accuracyEnglish?: number;
  languages: number;
}

function computeRatings(
  modelIds: string[],
  conditions: ConditionData[],
): Record<string, ModelRatings> {
  const ratings: Record<string, ModelRatings> = {};
  const { english } = splitConditions(conditions);

  for (const id of modelIds) {
    // Ratings describe what a user gets, so they rate from the published v2 speed when
    // there is one. An archive-only Speech Model has none, and rating it from a legacy
    // wall-clock figure is the honest option there - it is what those measurements are.
    const speed = pooledSpeedForConditions(id, conditions);
    const msPerAudioSec = speed.v2MsPerAudioSec ?? speed.legacyMsPerAudioSec;
    const rtf = msPerAudioSec === null ? 0 : msPerAudioSec / 1000;
    const pooled = pooledWerForConditions(id, conditions);
    const overallAccuracy = pooled.rate === null ? 0 : 1 - pooled.rate;
    const langCount = modelSupportedLanguages(variantModelId(id));

    const entry: ModelRatings = {
      speed: rateSpeed(rtf),
      accuracy: rateAccuracy(overallAccuracy),
      languages: rateLanguages(langCount),
    };

    if (isEnglishOnlyModel(variantModelId(id))) {
      const pooledEnglish = pooledWerForConditions(id, english);
      entry.accuracyEnglish = rateAccuracy(
        pooledEnglish.rate === null ? 0 : 1 - pooledEnglish.rate,
      );
    }

    ratings[id] = entry;
  }

  return ratings;
}

export function generateMarkdownReport(
  results: BenchmarkResults,
  options?: { noChunks?: boolean },
): string {
  const lines: string[] = [];
  const conditions = buildConditions(results);
  const modelIds = collectModelIds(conditions);

  // Header
  lines.push("# STT Benchmark Report");
  lines.push("");
  if (results.description) {
    lines.push(`**Description:** ${results.description}`);
    lines.push("");
  }
  lines.push(`- **Date:** ${results.runDate}`);
  lines.push(
    `- **Hardware:** ${results.hardware.chip} / ${results.hardware.ram} / ${results.hardware.os} ${results.hardware.osVersion}`,
  );
  // The v1 wording for a v1 number. `sampleSize` is only a count of measured clips when
  // a v2 pool produced it; otherwise it is the claimed width of a range, three above the
  // deepest `utteranceCount` on every archived run.
  lines.push(
    results.config.sampleSizeBasis === "pooled-v2"
      ? `- **Pooled unique scored clips per dataset:** ${results.config.sampleSize}`
      : `- **Samples per dataset:** ${results.config.sampleSize}`,
  );
  if (results.config.sampleSelection) {
    const { mode, requested } = results.config.sampleSelection;
    lines.push(
      mode === "delta"
        ? `- **Sample selection:** \`--samples ${requested}\` (${requested} clips per dataset not previously measured)`
        : `- **Sample selection:** \`--to ${requested}\` (topped every dataset up to depth ${requested})`,
    );
  }
  lines.push(`- **Warmup utterances:** ${results.config.warmupCount}`);
  const legend = harnessLegend(results);
  if (legend) lines.push(legend);
  lines.push(`- **Combinations tested:** ${modelIds.length}`);
  lines.push("");
  // Printed on every report, verbatim from one constant. Any surface that shows both
  // products has to state the asymmetry, and three paraphrases in three surfaces is how a
  // reader ends up believing the two numbers are the same measurement. The report shows
  // Codictate only today and still prints it, because a reader comparing this report to a
  // published head-to-head needs the same sentence in front of them.
  lines.push(`> ${INSTRUMENTATION_ASYMMETRY_LABEL}`);
  lines.push("");
  lines.push(
    "Accuracy and speed are **pooled**: `sum(errors) / sum(references)` and `sum(response time) / sum(audio)`. An unweighted mean of per-dataset rates is a different number and is never published. Leaves with no denominator are skipped, never counted as zero.",
  );
  lines.push("");
  lines.push(
    "Speed comes from `speedV2` - the provenance-filtered v2 measurement - and a leaf that has none is shown as `(legacy)`, from `meanRTF`. The two are different measurements (`meanRTF` is session wall clock over audio, over every scored Sample) and neither ever stands in for the other.",
  );
  lines.push("");

  // Printed before any table when a bucket withheld measurements it did take. The
  // failure this exists to prevent is a silent one: `respondedCount: 400,
  // speedExcludedCount: 400` renders as "N/A", which reads as "never measured".
  const withheld = modelIds
    .map((modelId) => ({
      modelId,
      speed: pooledSpeedForConditions(modelId, conditions),
    }))
    .filter((row) => row.speed.excludedSamples > 0);
  if (withheld.length > 0) {
    const total = withheld.reduce(
      (sum, row) => sum + row.speed.excludedSamples,
      0,
    );
    lines.push(
      `- **Samples withheld from pooled speed:** ${total} across ${withheld.length} row${withheld.length === 1 ? "" : "s"}, for want of timing provenance (\`overhead.timingRegime\`, and for a UI-observed Sample \`hotkeyEdge\`/\`timingClock\`). They responded, they count in \`attemptedCount\` and their words count in the pooled WER; only the speed ratio drops them.`,
    );
    for (const row of withheld) {
      lines.push(
        `  - ${modelName(row.modelId)}: ${row.speed.excludedSamples} of ${row.speed.respondedSamples} responded`,
      );
    }
    lines.push("");
  }

  // Summary table
  lines.push("## Summary");
  lines.push("");

  const { english, multilingual } = splitConditions(conditions);

  const fleursConditions = conditions.filter((c) => isFleurs(c.key));
  const hasCerData = fleursConditions.some((c) =>
    Object.values(c.models).some((r) => r.cer !== undefined),
  );

  const summaryHeader = [
    "Model",
    "Disk",
    "Min Peak RSS",
    "Avg Peak RSS",
    "Max Peak RSS",
    "Transcribe Time / sec Audio",
    "Pooled Overall",
    "Pooled English",
    "Pooled Multilingual",
    ...conditions.map((c) => c.label),
    ...(hasCerData ? ["Pooled Char Accuracy"] : []),
    "Failures",
  ];
  lines.push(`| ${summaryHeader.join(" | ")} |`);
  lines.push(`| ${summaryHeader.map(() => "---").join(" | ")} |`);

  const modelData = modelIds.map((modelId) => {
    const avgEn = pooledAccuracyForConditions(modelId, english);
    const avgMulti = pooledAccuracyForConditions(modelId, multilingual);
    const avgAll = pooledAccuracyForConditions(modelId, conditions);
    const speed = pooledSpeedForConditions(modelId, conditions);
    const diskMB = modelDiskMB(modelId);
    const rss = aggregateRss(modelId, conditions);
    const condAccs = conditions.map((c) => {
      const r = c.models[modelId];
      return r ? 1 - r.wer : -Infinity;
    });
    const pooledCharRate = pooledCerForConditions(modelId, fleursConditions);
    const avgCer =
      pooledCharRate.rate === null ? undefined : 1 - pooledCharRate.rate;
    const failures = pooledFailures(modelId, conditions);
    return {
      failures,
      modelId,
      avgAll,
      avgEn,
      avgMulti,
      speed,
      diskMB,
      rss,
      condAccs,
      avgCer,
    };
  });

  const pos = (v: number) => v > 0;
  const bestSpeed = Math.min(
    ...modelData.map((d) => rankableSpeed(d.speed)).filter(pos),
  );
  const bestDisk = Math.min(
    ...modelData.map((d) => d.diskMB ?? Infinity).filter(pos),
  );
  const bestRssMin = Math.min(
    ...modelData.map((d) => d.rss?.min ?? Infinity).filter(pos),
  );
  const bestRssAvg = Math.min(
    ...modelData.map((d) => d.rss?.avg ?? Infinity).filter(pos),
  );
  const bestRssMax = Math.min(
    ...modelData.map((d) => d.rss?.max ?? Infinity).filter(pos),
  );
  const bestAvgAll = Math.max(...modelData.map((d) => d.avgAll));
  const bestAvgEn = Math.max(...modelData.map((d) => d.avgEn));
  const bestAvgMulti = Math.max(...modelData.map((d) => d.avgMulti));
  const bestPerCond = conditions.map((_, ci) =>
    Math.max(...modelData.map((d) => d.condAccs[ci])),
  );
  const bestAvgCer = hasCerData
    ? Math.max(...modelData.map((d) => d.avgCer ?? -Infinity))
    : -Infinity;

  const bold = (s: string) => `**${s}**`;

  for (const d of modelData) {
    const disk = d.diskMB ? fmtSize(d.diskMB) : "N/A";
    const rssMinStr = fmtRss(d.rss?.min ?? null);
    const rssAvgStr = fmtRss(d.rss?.avg ?? null);
    const rssMaxStr = fmtRss(d.rss?.max ?? null);
    const speedStr = fmtPooledSpeed(d.speed);
    const avgAllStr =
      d.avgAll > -Infinity ? `${(d.avgAll * 100).toFixed(1)}%` : "-";
    const avgEnStr =
      d.avgEn > -Infinity ? `${(d.avgEn * 100).toFixed(1)}%` : "-";
    const avgMultiStr =
      d.avgMulti > -Infinity ? `${(d.avgMulti * 100).toFixed(1)}%` : "-";

    const row = [
      modelName(d.modelId),
      d.diskMB && d.diskMB === bestDisk ? bold(disk) : disk,
      d.rss?.min && d.rss.min === bestRssMin ? bold(rssMinStr) : rssMinStr,
      d.rss?.avg && d.rss.avg === bestRssAvg ? bold(rssAvgStr) : rssAvgStr,
      d.rss?.max && d.rss.max === bestRssMax ? bold(rssMaxStr) : rssMaxStr,
      rankableSpeed(d.speed) === bestSpeed && Number.isFinite(bestSpeed)
        ? bold(speedStr)
        : speedStr,
      d.avgAll === bestAvgAll && d.avgAll > -Infinity
        ? bold(avgAllStr)
        : avgAllStr,
      d.avgEn === bestAvgEn && d.avgEn > -Infinity ? bold(avgEnStr) : avgEnStr,
      d.avgMulti === bestAvgMulti && d.avgMulti > -Infinity
        ? bold(avgMultiStr)
        : avgMultiStr,
      ...conditions.map((c, ci) => {
        const r = c.models[d.modelId];
        if (!r) return "-";
        const acc = fmtAccuracy(r.wer);
        return d.condAccs[ci] === bestPerCond[ci] ? bold(acc) : acc;
      }),
    ];
    if (hasCerData) {
      const avgCerStr =
        d.avgCer !== undefined ? `${(d.avgCer * 100).toFixed(1)}%` : "N/A";
      row.push(
        d.avgCer !== undefined && d.avgCer === bestAvgCer
          ? bold(avgCerStr)
          : avgCerStr,
      );
    }
    // "not counted" rather than 0 wherever a leaf has no `failures` field. The two are
    // different claims and only one of them is a measurement; nothing on disk records
    // which utterances failed, so an absent count can never be filled in later.
    row.push(
      d.failures.uncountedLeaves > 0
        ? `${d.failures.counted} (+${d.failures.uncountedLeaves} leaf${d.failures.uncountedLeaves === 1 ? "" : "s"} not counted)`
        : `${d.failures.counted}`,
    );
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");

  // Ratings
  const ratings = computeRatings(modelIds, conditions);
  lines.push("## Ratings (1-10)");
  lines.push("");
  lines.push("| Model | Speed | Accuracy | Languages |");
  lines.push("| --- | --- | --- | --- |");
  for (const modelId of modelIds) {
    const r = ratings[modelId];
    const accStr =
      r.accuracyEnglish !== undefined
        ? `${r.accuracy} (${r.accuracyEnglish} en)`
        : `${r.accuracy}`;
    lines.push(
      `| ${modelName(modelId)} | ${r.speed} | ${accStr} | ${r.languages} |`,
    );
  }
  lines.push("");

  // Charts
  const CHUNK_SIZE = 8;
  const chunkCount = Math.ceil(modelIds.length / CHUNK_SIZE);
  const hasChunks = modelIds.length > CHUNK_SIZE;

  if (hasChunks && !options?.noChunks) {
    for (let i = 1; i <= chunkCount; i++) {
      const start = (i - 1) * CHUNK_SIZE;
      const chunkModels = modelIds.slice(start, start + CHUNK_SIZE);
      const first = modelName(chunkModels[0]);
      const last = modelName(chunkModels[chunkModels.length - 1]);
      lines.push(`## Charts (${first} - ${last})`);
      lines.push("");
      lines.push(`![Accuracy Comparison ${i}](accuracy-comparison-${i}.png)`);
      lines.push("");
      lines.push(`![Speed Comparison ${i}](speed-comparison-${i}.png)`);
      lines.push("");
      lines.push(`![Average Accuracy ${i}](accuracy-averages-${i}.png)`);
      lines.push("");
      if (hasCerData) {
        lines.push(`![Character Accuracy ${i}](cer-comparison-${i}.png)`);
        lines.push("");
      }
    }
  }

  lines.push("## Charts (All Models)");
  lines.push("");
  lines.push("![Accuracy Comparison](accuracy-comparison.png)");
  lines.push("");
  lines.push("![Speed Comparison](speed-comparison.png)");
  lines.push("");
  lines.push("![Average Accuracy](accuracy-averages.png)");
  lines.push("");
  if (hasCerData) {
    lines.push("![Character Accuracy](cer-comparison.png)");
    lines.push("");
  }

  // Accuracy by condition
  lines.push("## Accuracy by Condition");
  lines.push("");

  for (const condition of conditions) {
    const showCer =
      isFleurs(condition.key) &&
      Object.values(condition.models).some((r) => r.cer !== undefined);

    lines.push(`### ${condition.label}`);
    lines.push("");
    if (showCer) {
      lines.push("| Model | Word Accuracy (%) | Char Accuracy (%) |");
      lines.push("| --- | --- | --- |");
      for (const modelId of modelIds) {
        const r = condition.models[modelId];
        lines.push(
          `| ${modelName(modelId)} | ${r ? fmtAccuracy(r.wer) : "-"} | ${r ? fmtCharAccuracy(r.cer) : "N/A"} |`,
        );
      }
    } else {
      lines.push("| Model | Accuracy (%) |");
      lines.push("| --- | --- |");
      for (const modelId of modelIds) {
        const r = condition.models[modelId];
        lines.push(
          `| ${modelName(modelId)} | ${r ? fmtAccuracy(r.wer) : "-"} |`,
        );
      }
    }
    lines.push("");
  }

  // Speed by condition
  lines.push("## Speed by Condition");
  lines.push("");

  for (const condition of conditions) {
    lines.push(`### ${condition.label}`);
    lines.push("");
    lines.push("| Model | Transcribe Time / sec Audio |");
    lines.push("| --- | --- |");
    for (const modelId of modelIds) {
      const r = condition.models[modelId];
      lines.push(`| ${modelName(modelId)} | ${leafSpeedCell(r)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeReport(
  results: BenchmarkResults,
  resultsDir: string,
  options?: { noChunks?: boolean },
): Promise<void> {
  mkdirSync(resultsDir, { recursive: true });

  const markdown = generateMarkdownReport(results, options);
  await Bun.write(join(resultsDir, "report.md"), markdown);
  console.log(`Report written to ${join(resultsDir, "report.md")}`);

  const chartsScript = join(import.meta.dir, "charts.py");
  const args = ["python3", chartsScript, resultsDir];
  if (options?.noChunks) args.push("--no-chunks");
  const proc = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.warn("Chart generation failed (python3 + matplotlib required)");
  }
}
