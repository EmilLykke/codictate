import { describe, expect, test } from "bun:test";
import { ASR_HARNESS_IDS } from "../../src/shared/asr-harness";
import {
  BENCHMARK_HARNESS_LABELS,
  DEFAULT_HARNESS_LABEL,
  PRE_HARNESS_ARCHIVE_LABEL,
  isBenchmarkHarnessLabel,
  makeVariantKey,
  parseVariantKey,
} from "./results-schema";

describe("runnable Harnesses vs archived Harness labels", () => {
  test("whisper-cli is an archived label but is not runnable", () => {
    expect(isBenchmarkHarnessLabel("whisper-cli")).toBe(true);
    expect((ASR_HARNESS_IDS as readonly string[]).includes("whisper-cli")).toBe(
      false,
    );
  });

  test("every runnable Harness is also an archived label", () => {
    for (const id of ASR_HARNESS_IDS) {
      expect(isBenchmarkHarnessLabel(id)).toBe(true);
    }
  });

  test("variant keys round-trip for every archived label", () => {
    for (const label of BENCHMARK_HARNESS_LABELS) {
      const key = makeVariantKey(label, "large-v3-turbo-q5_0");
      expect(parseVariantKey(key)).toEqual({
        modelId: "large-v3-turbo-q5_0",
        harness: label,
      });
    }
  });

  test("the pre-harness archive label is not the shipping default", () => {
    expect(PRE_HARNESS_ARCHIVE_LABEL).toBe("whisper-cli");
    expect(PRE_HARNESS_ARCHIVE_LABEL).not.toBe(DEFAULT_HARNESS_LABEL);
  });
});
