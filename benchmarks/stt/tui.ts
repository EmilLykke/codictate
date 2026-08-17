/**
 * Interactive setup for a Benchmark Run.
 *
 * Additive to the CLI flags: `run-stt.ts` launches this only when `--models` is
 * absent, so CI keeps driving the benchmark entirely with flags. Combinations that
 * are already benchmarked start deselected, which makes pressing enter through the
 * whole flow mean "run only what is missing".
 */

import {
  intro,
  outro,
  select,
  multiselect,
  text,
  confirm,
  isCancel,
  cancel,
  log as clackLog,
  note,
} from "@clack/prompts";
import {
  ASR_HARNESS_IDS,
  type AsrHarnessId,
} from "../../src/shared/asr-harness";
import {
  SPEECH_MODEL_IDS,
  getSpeechModel,
} from "../../src/shared/speech-models";
import { LIBRISPEECH_SPLITS } from "./datasets";
import { formatModelCoverage, type Coverage } from "./coverage";

export interface BenchmarkPlan {
  /**
   * Every runnable Harness to run, in order. More than one means a same-samples
   * comparison. Not prompted for while there is only one, but still a list: the plan
   * feeds `run-stt.ts`, whose result files and read paths stay multi-Harness because
   * the archive is.
   */
  harnesses: AsrHarnessId[];
  models: string[];
  splits: string[];
  languages: string[];
  samples: number;
  name: string;
  description: string;
}

const SAMPLE_PRESETS = [50, 200, 500];

function exitIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Benchmark setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

function modelLabel(modelId: string): string {
  const model = getSpeechModel(modelId);
  return model ? `${model.label} (${modelId})` : modelId;
}

export interface TuiOptions {
  coverage: Coverage;
  /** FLEURS locale codes the download step knows how to fetch. */
  availableLanguages: readonly string[];
  /** Names already taken by an existing run directory. */
  usedNames: readonly string[];
}

export async function promptBenchmarkPlan(
  options: TuiOptions,
): Promise<BenchmarkPlan> {
  const { coverage, availableLanguages, usedNames } = options;

  intro("Codictate STT Benchmark");

  if (coverage.runCount === 0) {
    clackLog.info(
      "No previous runs found, so nothing is pre-marked as covered.",
    );
  } else {
    clackLog.info(
      `Coverage aggregated across ${coverage.runCount} previous run${coverage.runCount === 1 ? "" : "s"}.`,
    );
  }

  // Every runnable Harness, with no prompt: there is one, and a multiselect with a
  // single option is a keystroke that cannot change the outcome. If a second Harness is
  // ever added, this is where the prompt comes back - running several over identical
  // samples is the only way their WER and RTF are comparable.
  const harnesses: AsrHarnessId[] = [...ASR_HARNESS_IDS];
  clackLog.info(`ASR Harness: ${harnesses.join(", ")}`);

  const modelOptions = SPEECH_MODEL_IDS.map((id) => ({
    value: id,
    label: modelLabel(id),
    hint: harnesses
      .map((h) => `${h} ${formatModelCoverage(coverage, h, id)}`)
      .join("  |  "),
  }));
  const models = exitIfCancelled(
    await multiselect({
      message: `Speech Models to run under ${harnesses.join(" and ")}`,
      options: modelOptions,
      // Nothing is preselected: a benchmark run is expensive, so every Speech Model is
      // an explicit choice. The per-Harness coverage badge on each row is what tells the
      // user which ones still have gaps.
      initialValues: [],
      required: true,
    }),
  ) as string[];

  const splits = exitIfCancelled(
    await multiselect({
      message: "LibriSpeech splits",
      options: LIBRISPEECH_SPLITS.map((split) => ({
        value: split,
        label: split,
      })),
      initialValues: [...LIBRISPEECH_SPLITS],
      required: false,
    }),
  ) as string[];

  const languages = exitIfCancelled(
    await multiselect({
      message: "FLEURS languages",
      options: availableLanguages.map((lang) => ({
        value: lang,
        label: lang,
      })),
      initialValues: [...availableLanguages],
      required: false,
    }),
  ) as string[];

  if (splits.length === 0 && languages.length === 0) {
    cancel(
      "Nothing to run: pick at least one LibriSpeech split or FLEURS language.",
    );
    process.exit(1);
  }

  const samplesChoice = exitIfCancelled(
    await select({
      message: "Samples per dataset",
      initialValue: "200",
      options: [
        ...SAMPLE_PRESETS.map((n) => ({ value: String(n), label: String(n) })),
        { value: "custom", label: "Custom..." },
      ],
    }),
  ) as string;

  let samples: number;
  if (samplesChoice === "custom") {
    const custom = exitIfCancelled(
      await text({
        message: "Samples per dataset",
        placeholder: "200",
        validate: (value) => {
          const n = Number(value);
          if (!Number.isInteger(n) || n <= 0) {
            return "Enter a positive whole number.";
          }
          return undefined;
        },
      }),
    ) as string;
    samples = Number(custom);
  } else {
    samples = Number(samplesChoice);
  }

  const name = exitIfCancelled(
    await text({
      message: "Run name (URL slug for the benchmark page)",
      placeholder: "crispasr-vs-whisper-cli",
      validate: (value) => {
        const trimmed = value?.trim() ?? "";
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
          return "Lowercase letters, numbers and single hyphens only.";
        }
        if (usedNames.includes(trimmed)) {
          return `Already used by an existing run: ${trimmed}`;
        }
        return undefined;
      },
    }),
  ).trim();

  const description = exitIfCancelled(
    await text({
      message: "Description (what this run is meant to answer)",
      validate: (value) =>
        (value?.trim() ?? "").length === 0 ? "Required." : undefined,
    }),
  ).trim();

  note(
    [
      `Harnesses:  ${harnesses.join(", ")}`,
      `Models:     ${models.length} (${models.join(", ")})`,
      `LibriSpeech: ${splits.length > 0 ? splits.join(", ") : "none"}`,
      `FLEURS:     ${languages.length > 0 ? languages.join(", ") : "none"}`,
      `Samples:    ${samples}`,
      `Name:       ${name}`,
    ].join("\n"),
    "Planned run",
  );

  const proceed = exitIfCancelled(
    await confirm({ message: "Start this run?", initialValue: true }),
  ) as boolean;

  if (!proceed) {
    cancel("Benchmark setup cancelled.");
    process.exit(0);
  }

  outro("Starting benchmark");

  return {
    harnesses,
    models,
    splits,
    languages,
    samples,
    name,
    description,
  };
}
