/**
 * The measuring-harness vocabulary: which *thing that takes measurements* produced a
 * record.
 *
 * Three repositories name the same two harnesses, and until now each named them with an
 * independent string literal. One of the three had `"external-product"` where the
 * external harness writes `"wispr-flow"`, and the consequence was not a crash: the
 * instrumentation-asymmetry sentence simply never rendered, permanently, on the one
 * surface that shows both products. A comparison that quietly stops disclosing how its two
 * numbers were measured is worse than one that fails to build, so the vocabulary is a
 * closed union with a guard and a mismatch is a type error.
 *
 * **"Harness" is overloaded in this repository and the two senses must not meet:**
 *
 * - **Measuring Harness** (this module) - what ran the benchmark: `codictate` or
 *   `wispr-flow`. It is `RunRecordV2.harness` and a component of `compatibilityKey`.
 * - **ASR Harness** (`src/shared/asr-harness.ts`, `benchmarks/stt/results-schema.ts`) -
 *   the binary and CLI contract that executes a Speech Engine inside Codictate:
 *   `crispasr`, and the retired `whisper-cli`. It is `RecordedRange.harness` in
 *   `benchmarks/stt/sample-cursor.ts` and the Harness key in the v1 results tree.
 *
 * Both were `string`, so `harness: "crispasr"` and `harness: "codictate"` were assignable
 * to each other's fields. They answer different questions and mixing them silently files a
 * measurement under a harness that never ran it. See `docs/adr/0002-asr-harness-abstraction.md`
 * for the ASR Harness sense.
 */

/** Codictate measuring its own Speech Models through its Speech Engine Adapter. */
export const HARNESS_CODICTATE = "codictate";

/** Wispr Flow measured through its user interface, because it cannot be called. */
export const HARNESS_WISPR_FLOW = "wispr-flow";

export const MEASURING_HARNESSES = [
  HARNESS_CODICTATE,
  HARNESS_WISPR_FLOW,
] as const;

export type MeasuringHarness = (typeof MEASURING_HARNESSES)[number];

export function isMeasuringHarness(value: unknown): value is MeasuringHarness {
  return (
    typeof value === "string" &&
    (MEASURING_HARNESSES as readonly string[]).includes(value)
  );
}

/**
 * The v1 results tree keys leaves by **ASR Harness** label, and an external product has
 * no ASR Harness - so its leaves are filed under this pseudo-label instead.
 *
 * A second spelling of "the external product", which is why it is exported next to
 * `HARNESS_WISPR_FLOW` rather than left as a literal in a flattening function. Any
 * surface deciding whether both products are present has to accept **either** spelling,
 * because the v2 record says `wispr-flow` and the v1-shaped leaf it flattens into says
 * `external-product`.
 */
export const V1_EXTERNAL_PRODUCT_LABEL = "external-product";

/** Either spelling of "this measurement came from the external product". */
export function isExternalProduct(value: unknown): boolean {
  return value === HARNESS_WISPR_FLOW || value === V1_EXTERNAL_PRODUCT_LABEL;
}

/**
 * Whether a set of harness identifiers spans both products.
 *
 * The predicate behind the published-label requirement: when this is true, the surface
 * **must** print `timing.ts::INSTRUMENTATION_ASYMMETRY_LABEL`. It accepts both spellings
 * of the external product on purpose - a reader that knew only one of them is precisely
 * how the sentence went missing - and it takes plain strings rather than
 * `MeasuringHarness`, because the values arrive off disk from three writers and the whole
 * job of this function is to answer correctly for whatever they actually said.
 */
export function spansBothProducts(harnesses: Iterable<string>): boolean {
  let codictate = false;
  let external = false;
  for (const harness of harnesses) {
    if (harness === HARNESS_CODICTATE) codictate = true;
    else if (isExternalProduct(harness)) external = true;
  }
  return codictate && external;
}
