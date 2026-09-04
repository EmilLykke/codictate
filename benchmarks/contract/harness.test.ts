/**
 * The measuring-harness vocabulary.
 *
 * Pinned because a mismatch here is silent by construction. A reader that knew the
 * external product as `external-product` while the external harness wrote `wispr-flow`
 * did not fail, log, or render an error - the instrumentation-asymmetry sentence just
 * never appeared, permanently, on the one surface that shows both products side by side.
 * The reader was correct about everything it could check and wrong about the only thing
 * nothing checked.
 */

import { describe, expect, test } from "bun:test";
import {
  HARNESS_CODICTATE,
  HARNESS_WISPR_FLOW,
  isExternalProduct,
  isMeasuringHarness,
  MEASURING_HARNESSES,
  spansBothProducts,
  V1_EXTERNAL_PRODUCT_LABEL,
} from "./harness";
import { requiresAsymmetryLabel } from "./timing";

describe("the vocabulary", () => {
  test("it is exactly two harnesses, spelled once", () => {
    expect(MEASURING_HARNESSES).toEqual(["codictate", "wispr-flow"]);
    expect(HARNESS_CODICTATE).toBe("codictate");
    expect(HARNESS_WISPR_FLOW).toBe("wispr-flow");
  });

  test("the guard accepts both and nothing else", () => {
    for (const harness of MEASURING_HARNESSES) {
      expect(isMeasuringHarness(harness)).toBe(true);
    }
    for (const nonHarness of [
      "wispr flow",
      "wisprflow",
      "Codictate",
      "external-product",
      "crispasr",
      "",
      null,
      undefined,
      7,
    ]) {
      expect(isMeasuringHarness(nonHarness)).toBe(false);
    }
  });

  test("an ASR Harness is not a Measuring Harness", () => {
    // Both fields were `string`, so `harness: "crispasr"` was assignable to
    // `RunRecordV2.harness`. They answer different questions - which binary executed a
    // Speech Engine, versus which harness took the measurement - and mixing them files a
    // measurement under a harness that never ran it.
    expect(isMeasuringHarness("crispasr")).toBe(false);
    expect(isMeasuringHarness("whisper-cli")).toBe(false);
  });
});

describe("the external product has two spellings", () => {
  test("both are recognised", () => {
    // v2 records say `wispr-flow`; the v1 results tree keys by ASR Harness label and an
    // external product has none, so its flattened leaf says `external-product`.
    expect(V1_EXTERNAL_PRODUCT_LABEL).toBe("external-product");
    expect(isExternalProduct(HARNESS_WISPR_FLOW)).toBe(true);
    expect(isExternalProduct(V1_EXTERNAL_PRODUCT_LABEL)).toBe(true);
    expect(isExternalProduct(HARNESS_CODICTATE)).toBe(false);
    expect(isExternalProduct("something-else")).toBe(false);
  });
});

describe("when the asymmetry sentence is required", () => {
  test("both products present, in either spelling", () => {
    expect(spansBothProducts([HARNESS_CODICTATE, HARNESS_WISPR_FLOW])).toBe(
      true,
    );
    // The regression witness: this pairing used to answer false and suppress the sentence.
    expect(
      spansBothProducts([HARNESS_CODICTATE, V1_EXTERNAL_PRODUCT_LABEL]),
    ).toBe(true);
    expect(
      requiresAsymmetryLabel([HARNESS_CODICTATE, V1_EXTERNAL_PRODUCT_LABEL]),
    ).toBe(true);
  });

  test("one product alone does not require it", () => {
    expect(spansBothProducts([HARNESS_CODICTATE])).toBe(false);
    expect(
      spansBothProducts([HARNESS_WISPR_FLOW, V1_EXTERNAL_PRODUCT_LABEL]),
    ).toBe(false);
    expect(spansBothProducts([])).toBe(false);
  });

  test("it works on a Set and on repeated values", () => {
    expect(
      spansBothProducts(new Set([HARNESS_CODICTATE, HARNESS_CODICTATE])),
    ).toBe(false);
    expect(
      spansBothProducts([
        HARNESS_CODICTATE,
        HARNESS_CODICTATE,
        V1_EXTERNAL_PRODUCT_LABEL,
        "crispasr",
      ]),
    ).toBe(true);
  });

  test("an unknown identifier neither triggers nor suppresses it", () => {
    expect(spansBothProducts(["some-future-product"])).toBe(false);
    expect(spansBothProducts([HARNESS_CODICTATE, "some-future-product"])).toBe(
      false,
    );
  });
});
