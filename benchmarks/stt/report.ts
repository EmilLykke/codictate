import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ModelDatasetResult, PeakRSSStats } from "./runner";
import { getSpeechModel } from "../../src/shared/speech-models";

export interface BenchmarkResults {
  hardware: {
    chip: string;
    ram: string;
    os: string;
    osVersion: string;
  };
  runDate: string;
  config: {
    sampleSize: number;
    warmupCount: number;
    normalization: string;
  };
  librispeech: Record<string, Record<string, ModelDatasetResult>>;
  fleurs: Record<string, Record<string, ModelDatasetResult>>;
}

const CONDITION_LABELS: Record<string, string> = {
  "test-clean": "English (clean)",
  "test-other": "English (noisy)",
  es_419: "Spanish",
  da_dk: "Danish",
  hu_hu: "Hungarian",
};

function modelName(id: string): string {
  const model = getSpeechModel(id);
  if (!model) return id;
  const parts = [model.label];
  const qMatch = id.match(/-?(q\d+_\d+)/);
  if (qMatch) parts.push(qMatch[1]);
  else parts.push("full");
  if (id.includes(".en")) parts.push("en");
  if (id.includes("-tdrz")) parts.push("tdrz");
  return parts.join(" ");
}

function modelDiskMB(id: string): number | null {
  return getSpeechModel(id)?.downloadSizeMB ?? null;
}

function modelSupportedLanguages(id: string): number {
  const model = getSpeechModel(id);
  if (!model) return 1;
  if (model.engine === "whisperkit")
    return model.supportedTranscriptionLanguageIds?.length ?? 1;
  if (id.includes(".en")) return 1;
  return 99;
}

function conditionLabel(key: string): string {
  return CONDITION_LABELS[key] ?? key;
}

function fmtAccuracy(wer: number): string {
  if (wer < 0) return "N/A";
  return `${((1 - wer) * 100).toFixed(1)}%`;
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

function buildConditions(results: BenchmarkResults): ConditionData[] {
  const conditions: ConditionData[] = [];

  for (const [split, models] of Object.entries(results.librispeech)) {
    conditions.push({ key: split, label: conditionLabel(split), models });
  }

  for (const [lang, models] of Object.entries(results.fleurs)) {
    conditions.push({ key: lang, label: conditionLabel(lang), models });
  }

  return conditions;
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
  languages: number;
}

function rateSpeed(rtf: number): number {
  if (rtf <= 0) return 1;
  const score = Math.round(10 - rtf * 9);
  return Math.max(1, Math.min(10, score));
}

function rateAccuracy(accuracy: number): number {
  const score = Math.round((accuracy - 0.5) * 18 + 1);
  return Math.max(1, Math.min(10, score));
}

function rateLanguages(count: number): number {
  if (count >= 90) return 10;
  if (count >= 50) return 9;
  if (count >= 25) return 8;
  if (count >= 10) return 6;
  if (count >= 5) return 4;
  return Math.max(1, Math.min(3, count));
}

function computeRatings(
  modelIds: string[],
  conditions: ConditionData[],
): Record<string, ModelRatings> {
  const ratings: Record<string, ModelRatings> = {};

  for (const id of modelIds) {
    const rtf = avgRtf(id, conditions);
    const accs = conditions
      .map((c) => c.models[id]?.wer)
      .filter((w): w is number => w !== undefined && w >= 0);
    const avgAccuracy =
      accs.length > 0
        ? 1 - accs.reduce((sum, w) => sum + w, 0) / accs.length
        : 0;
    const langCount = modelSupportedLanguages(id);

    ratings[id] = {
      speed: rateSpeed(rtf),
      accuracy: rateAccuracy(avgAccuracy),
      languages: rateLanguages(langCount),
    };
  }

  return ratings;
}

export function generateMarkdownReport(results: BenchmarkResults): string {
  const lines: string[] = [];
  const conditions = buildConditions(results);
  const modelIds = collectModelIds(conditions);

  // Header
  lines.push("# STT Benchmark Report");
  lines.push("");
  lines.push(`- **Date:** ${results.runDate}`);
  lines.push(
    `- **Hardware:** ${results.hardware.chip} / ${results.hardware.ram} / ${results.hardware.os} ${results.hardware.osVersion}`,
  );
  lines.push(`- **Samples per dataset:** ${results.config.sampleSize}`);
  lines.push(`- **Warmup utterances:** ${results.config.warmupCount}`);
  lines.push(`- **Models tested:** ${modelIds.length}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");

  const { english, multilingual } = splitConditions(conditions);

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
    return { modelId, avgAll, avgEn, avgMulti, rtf, diskMB, rss, condAccs };
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
      d.avgEn === bestAvgEn && d.avgEn > -Infinity
        ? bold(avgEnStr)
        : avgEnStr,
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
    lines.push(
      `| ${modelName(modelId)} | ${r.speed} | ${r.accuracy} | ${r.languages} |`,
    );
  }
  lines.push("");

  // Charts
  lines.push("## Charts");
  lines.push("");
  lines.push("![Accuracy Comparison](accuracy-comparison.png)");
  lines.push("");
  lines.push("![Speed Comparison](speed-comparison.png)");
  lines.push("");
  lines.push("![Average Accuracy](accuracy-averages.png)");
  lines.push("");

  // Accuracy by condition
  lines.push("## Accuracy by Condition");
  lines.push("");

  for (const condition of conditions) {
    lines.push(`### ${condition.label}`);
    lines.push("");
    lines.push("| Model | Accuracy (%) |");
    lines.push("| --- | --- |");
    for (const modelId of modelIds) {
      const r = condition.models[modelId];
      lines.push(`| ${modelName(modelId)} | ${r ? fmtAccuracy(r.wer) : "-"} |`);
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
): Promise<void> {
  mkdirSync(resultsDir, { recursive: true });

  const markdown = generateMarkdownReport(results);
  await Bun.write(join(resultsDir, "report.md"), markdown);
  console.log(`Report written to ${join(resultsDir, "report.md")}`);

  const chartsScript = join(import.meta.dir, "charts.py");
  const proc = Bun.spawn(["python3", chartsScript, resultsDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.warn("Chart generation failed (python3 + matplotlib required)");
  }
}
