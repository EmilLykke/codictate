/**
 * What has already been benchmarked, aggregated across every Benchmark Run in
 * `benchmarks/results/`.
 *
 * "Already benchmarked" is a property of a Benchmark Combination - one (Harness,
 * Speech Model, dataset, language) tuple - not of a Speech Model, and the same
 * Combination can exist at different sample depths across runs. Coverage keeps the
 * deepest run seen for each Combination.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AsrHarnessId } from "../../src/shared/asr-harness";
import { normalizeDatasetResults } from "./results-schema";

/** harness -> modelId -> datasetKey -> deepest sample count recorded. */
export type CoverageIndex = Record<
  string,
  Record<string, Record<string, number>>
>;

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function recordCoverage(
  index: CoverageIndex,
  raw: unknown,
  onDataset?: (datasetKey: string) => void,
): void {
  for (const [datasetKey, byHarness] of Object.entries(
    normalizeDatasetResults(raw),
  )) {
    onDataset?.(datasetKey);
    for (const [harness, byModel] of Object.entries(byHarness)) {
      if (!byModel) continue;
      for (const [modelId, result] of Object.entries(byModel)) {
        if (result.utteranceCount <= 0) continue;
        const byDataset = ((index[harness] ??= {})[modelId] ??= {});
        byDataset[datasetKey] = Math.max(
          byDataset[datasetKey] ?? 0,
          result.utteranceCount,
        );
      }
    }
  }
}

export interface Coverage {
  index: CoverageIndex;
  /** Every dataset key seen in any run, so a model can be judged partial vs complete. */
  knownDatasetKeys: string[];
  runCount: number;
}

/**
 * Read every completed run's `stt.json`. Incomplete runs (checkpoint present, no
 * `stt.json`) contribute nothing; their results are not final.
 */
export function loadCoverage(resultsBaseDir: string): Coverage {
  const index: CoverageIndex = {};
  const datasetKeys = new Set<string>();
  let runCount = 0;

  if (!existsSync(resultsBaseDir)) {
    return { index, knownDatasetKeys: [], runCount };
  }

  for (const entry of readdirSync(resultsBaseDir)) {
    if (!RUN_DIR_PATTERN.test(entry)) continue;
    const jsonPath = join(resultsBaseDir, entry, "stt.json");
    if (!existsSync(jsonPath)) continue;

    let parsed: { librispeech?: unknown; fleurs?: unknown };
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch {
      continue;
    }
    runCount += 1;
    recordCoverage(index, parsed.librispeech, (k) => datasetKeys.add(k));
    recordCoverage(index, parsed.fleurs, (k) => datasetKeys.add(k));
  }

  return { index, knownDatasetKeys: [...datasetKeys].sort(), runCount };
}

export interface ModelCoverage {
  /** Dataset keys this Combination has results for, at any depth. */
  datasetKeys: string[];
  /** Shallowest run among those datasets - the depth the whole set is comparable at. */
  minSamples: number;
  /** True when some but not all known dataset keys are covered. */
  partial: boolean;
}

export function modelCoverage(
  coverage: Coverage,
  harness: AsrHarnessId,
  modelId: string,
): ModelCoverage | null {
  const byDataset = coverage.index[harness]?.[modelId];
  if (!byDataset) return null;

  const datasetKeys = Object.keys(byDataset).sort();
  if (datasetKeys.length === 0) return null;

  return {
    datasetKeys,
    minSamples: Math.min(...datasetKeys.map((k) => byDataset[k])),
    partial: datasetKeys.length < coverage.knownDatasetKeys.length,
  };
}

/** One-line coverage badge for a model row in the benchmark TUI. */
export function formatModelCoverage(
  coverage: Coverage,
  harness: AsrHarnessId,
  modelId: string,
): string {
  const covered = modelCoverage(coverage, harness, modelId);
  if (!covered) return "- never";
  const suffix = covered.partial
    ? ` (${covered.datasetKeys.length}/${coverage.knownDatasetKeys.length} datasets)`
    : "";
  return `✓ ${covered.minSamples} samples${suffix}`;
}

/**
 * Whether one Benchmark Combination already has results at least `samples` deep.
 * Used to decide which rows start deselected, so pressing enter through the TUI
 * runs only what is missing.
 */
export function isCombinationCovered(
  coverage: Coverage,
  harness: AsrHarnessId,
  modelId: string,
  datasetKey: string,
  samples: number,
): boolean {
  const recorded = coverage.index[harness]?.[modelId]?.[datasetKey];
  return recorded !== undefined && recorded >= samples;
}
