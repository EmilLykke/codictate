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

function avgAccuracyForConditions(
  modelId: string,
  conditions: ConditionData[],
): number {
  const accs = conditions
    .map((c) => c.models[modelId]?.wer)
    .filter((w): w is number => w !== undefined);
  if (accs.length === 0) return -Infinity;
  return 1 - accs.reduce((s, w) => s + w, 0) / accs.length;
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

function avgRtf(modelId: string, conditions: ConditionData[]): number {
  let totalAudio = 0;
  let totalWall = 0;
  for (const c of conditions) {
    const r = c.models[modelId];
    if (r && r.meanRTF > 0) {
      totalAudio += r.totalAudioSec;
      totalWall += r.totalWallSec;
    }
  }
  if (totalAudio === 0 || totalWall === 0) return 0;
  return totalWall / totalAudio;
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
    const rtf = avgRtf(id, conditions);
    const allWers = conditions
      .map((c) => c.models[id]?.wer)
      .filter((w): w is number => w !== undefined && w >= 0);
    const overallAccuracy =
      allWers.length > 0
        ? 1 - allWers.reduce((sum, w) => sum + w, 0) / allWers.length
        : 0;
    const langCount = modelSupportedLanguages(variantModelId(id));

    const entry: ModelRatings = {
      speed: rateSpeed(rtf),
      accuracy: rateAccuracy(overallAccuracy),
      languages: rateLanguages(langCount),
    };

    if (isEnglishOnlyModel(variantModelId(id))) {
      const enWers = english
        .map((c) => c.models[id]?.wer)
        .filter((w): w is number => w !== undefined && w >= 0);
      const enAccuracy =
        enWers.length > 0
          ? 1 - enWers.reduce((sum, w) => sum + w, 0) / enWers.length
          : 0;
      entry.accuracyEnglish = rateAccuracy(enAccuracy);
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
  lines.push(`- **Samples per dataset:** ${results.config.sampleSize}`);
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
    "Avg Overall",
    "Avg English",
    "Avg Multilingual",
    ...conditions.map((c) => c.label),
    ...(hasCerData ? ["Avg Char Accuracy"] : []),
  ];
  lines.push(`| ${summaryHeader.join(" | ")} |`);
  lines.push(`| ${summaryHeader.map(() => "---").join(" | ")} |`);

  const modelData = modelIds.map((modelId) => {
    const avgEn = avgAccuracyForConditions(modelId, english);
    const avgMulti = avgAccuracyForConditions(modelId, multilingual);
    const avgAll = avgAccuracyForConditions(modelId, conditions);
    const rtf = avgRtf(modelId, conditions);
    const diskMB = modelDiskMB(modelId);
    const rss = aggregateRss(modelId, conditions);
    const condAccs = conditions.map((c) => {
      const r = c.models[modelId];
      return r ? 1 - r.wer : -Infinity;
    });
    const cerValues = fleursConditions
      .map((c) => c.models[modelId]?.cer)
      .filter((c): c is number => c !== undefined && c >= 0);
    const avgCer =
      cerValues.length > 0
        ? 1 - cerValues.reduce((s, c) => s + c, 0) / cerValues.length
        : undefined;
    return {
      modelId,
      avgAll,
      avgEn,
      avgMulti,
      rtf,
      diskMB,
      rss,
      condAccs,
      avgCer,
    };
  });

  const pos = (v: number) => v > 0;
  const bestSpeed = Math.min(...modelData.map((d) => d.rtf).filter(pos));
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
    const speedStr = fmtSpeed(d.rtf);
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
      d.rtf > 0 && d.rtf === bestSpeed ? bold(speedStr) : speedStr,
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
      lines.push(
        `| ${modelName(modelId)} | ${r ? fmtSpeed(r.meanRTF) : "-"} |`,
      );
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
