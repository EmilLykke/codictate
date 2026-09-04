/**
 * Clip identity in the manifest builders: what a measurement is keyed by, and what the
 * FLEURS TSV's first column is *not*.
 *
 * Worth pinning because the failure is silent and enormous. `ManifestEntry.id` is
 * `<locale>_<TSV column 0>`, column 0 is a *sentence* id, and FLEURS reads several
 * speakers per sentence - so `da_dk` has 930 recordings under 350 distinct ids. Every
 * v2 consumer keys on identity: a resume skips clips whose identity it has seen, a pool
 * keeps one measurement per identity, coverage counts identities. With identity taken
 * from column 0, two thirds of a Danish run would read as repeats of clips already
 * done, the run would finish, the WER would look plausible, and nothing anywhere would
 * say 580 clips were never transcribed.
 *
 * The rule is asserted here on a synthetic mirror of the real TSV's shape, because
 * `benchmarks/datasets/` is git-ignored - the corpora are gigabytes - and a test that
 * read the real file would turn `bun test` red on a fresh checkout with nothing broken.
 * The real numbers are pinned below as a constant and witnessed against the corpus by
 * `benchmarks/contract/fleurs-identity.manual.ts`.
 */

import { describe, expect, test } from "bun:test";
import { fleursEntriesFromTsv, hydrateDurations } from "./build-manifests";
import { fleursClipId, uniqueInOrder } from "../contract";

/**
 * FLEURS as measured on 2026-09-04, from the three downloaded locales.
 *
 * Pinned rather than read: this is the fact that makes column 0 unusable as identity,
 * and it has to be legible in a suite that cannot open the corpus. `distinctSentenceIds`
 * being a third of `recordings` is the whole defect.
 */
const FLEURS_MEASURED = {
  da_dk: { recordings: 930, distinctSentenceIds: 350 },
  es_419: { recordings: 908, distinctSentenceIds: 348 },
  hu_hu: { recordings: 905, distinctSentenceIds: 348 },
} as const;

/**
 * A TSV row in the real column order: `id, file_name, raw_transcription,
 * transcription, num_samples, gender`.
 */
function row(
  sentenceId: string,
  fileName: string,
  raw: string,
  normalized: string,
): string {
  return [sentenceId, fileName, raw, normalized, "160000", "MALE"].join("\t");
}

/**
 * Three sentences read by three speakers each: nine recordings, three sentence ids.
 * The same 930/350 shape the Danish corpus has, small enough to read.
 */
const NINE_RECORDINGS_THREE_SENTENCES = [
  row("101", "1000000000000000001.wav", "Han sagde det.", "han sagde det"),
  row("101", "1000000000000000002.wav", "Han sagde det.", "han sagde det"),
  row("101", "1000000000000000003.wav", "Han sagde det.", "han sagde det"),
  row("102", "1000000000000000004.wav", "Hun kom hjem.", "hun kom hjem"),
  row("102", "1000000000000000005.wav", "Hun kom hjem.", "hun kom hjem"),
  row("102", "1000000000000000006.wav", "Hun kom hjem.", "hun kom hjem"),
  row("103", "1000000000000000007.wav", "Vi gik ud.", "vi gik ud"),
  row("103", "1000000000000000008.wav", "Vi gik ud.", "vi gik ud"),
  row("103", "1000000000000000009.wav", "Vi gik ud.", "vi gik ud"),
].join("\n");

describe("FLEURS clip identity is TSV column 1, not column 0", () => {
  test("nine recordings of three sentences are nine clips", () => {
    const entries = fleursEntriesFromTsv(
      "da_dk",
      NINE_RECORDINGS_THREE_SENTENCES,
    );

    expect(entries.length).toBe(9);
    // Nine distinct identities out of three distinct sentence ids. This is the
    // assertion the harness did not have: keying on `id` would have yielded three.
    expect(uniqueInOrder(entries.map((e) => e.clipId)).length).toBe(9);
    expect(uniqueInOrder(entries.map((e) => e.sentenceId!)).length).toBe(3);
    expect(uniqueInOrder(entries.map((e) => e.id)).length).toBe(3);
  });

  test("the clipId is the corpus-relative audio path the contract derives", () => {
    const entries = fleursEntriesFromTsv(
      "da_dk",
      NINE_RECORDINGS_THREE_SENTENCES,
    );

    expect(entries[0].clipId).toBe(
      "fleurs/da_dk/audio/test/1000000000000000001.wav",
    );
    // Derived through the contract rather than assembled here, so this repository and
    // `dictation-product-benchmark` cannot spell one clip two ways.
    expect(entries[0].clipId).toBe(
      fleursClipId("da_dk", "1000000000000000001.wav"),
    );
  });

  test("the sentence id survives as metadata, next to the identity", () => {
    const entries = fleursEntriesFromTsv(
      "da_dk",
      NINE_RECORDINGS_THREE_SENTENCES,
    );

    // Metadata, because "did the model get this sentence right across speakers" is a
    // real question. Never identity, never a dedup key, never a fingerprint input.
    expect(entries[0].sentenceId).toBe("101");
    expect(entries[1].sentenceId).toBe("101");
    expect(entries[0].clipId).not.toBe(entries[1].clipId);
  });

  test("the legacy id is still the sentence-derived one, on purpose", () => {
    const entries = fleursEntriesFromTsv(
      "da_dk",
      NINE_RECORDINGS_THREE_SENTENCES,
    );

    // Frozen, not fixed. `manifestFingerprint` in stt/sample-cursor.ts is computed over
    // this string and the resulting token is recorded in every archived leaf's
    // `sampleRange`. Recomputing it over `clipId` would change the token for every
    // dataset, and `manifestFingerprintConflicts` would then refuse every run.
    expect(entries[0].id).toBe("da_dk_101");
    expect(entries[1].id).toBe("da_dk_101");
  });

  test("a TSV that really does repeat column 1 is refused", () => {
    // Not a hypothetical: this is the shape a re-export or a bad merge produces, and it
    // is the one case where two measurements would land under one identity. Refused at
    // build time, because nothing downstream can tell the two apart afterwards.
    const duplicated = [
      row("101", "1000000000000000001.wav", "Han sagde det.", "han sagde det"),
      row("102", "1000000000000000001.wav", "Hun kom hjem.", "hun kom hjem"),
    ].join("\n");

    expect(() => fleursEntriesFromTsv("da_dk", duplicated)).toThrow(
      /names the same clip twice/,
    );
  });

  test("a header row is skipped and does not become a clip", () => {
    const withHeader = [
      "id\tfile_name\traw_transcription\ttranscription\tnum_samples\tgender",
      row("101", "1000000000000000001.wav", "Han sagde det.", "han sagde det"),
    ].join("\n");

    const entries = fleursEntriesFromTsv("da_dk", withHeader);
    expect(entries.length).toBe(1);
    expect(entries[0].clipId).toBe(
      "fleurs/da_dk/audio/test/1000000000000000001.wav",
    );
  });

  test("a row whose wav is missing contributes no clip", () => {
    const entries = fleursEntriesFromTsv(
      "da_dk",
      NINE_RECORDINGS_THREE_SENTENCES,
      {
        audioDir: "/corpus/fleurs/da_dk/audio/test",
        hasAudio: (audioPath) => !audioPath.endsWith("1000000000000000005.wav"),
      },
    );

    expect(entries.length).toBe(8);
    expect(entries.map((e) => e.clipId)).not.toContain(
      "fleurs/da_dk/audio/test/1000000000000000005.wav",
    );
  });

  test("the measured corpus shape is the reason any of this matters", () => {
    // Read as a sentence: 930 Danish recordings, 350 sentence ids. Identity on column 0
    // would have collapsed 930 clips to 350 and skipped 580 of them on the next resume.
    for (const measured of Object.values(FLEURS_MEASURED)) {
      expect(measured.distinctSentenceIds).toBeLessThan(measured.recordings);
    }
    expect(FLEURS_MEASURED.da_dk.recordings).toBe(930);
    expect(FLEURS_MEASURED.da_dk.distinctSentenceIds).toBe(350);
  });
});

describe("hydrateDurations", () => {
  test("an entry that already has a duration is returned untouched", () => {
    const [entry] = hydrateDurations([
      {
        id: "da_dk_101",
        clipId: "fleurs/da_dk/audio/test/1000000000000000001.wav",
        sentenceId: "101",
        audioPath: "/nowhere/1000000000000000001.wav",
        transcript: "han sagde det",
        language: "da",
        audioDurationSec: 4.25,
      },
    ]);

    // No read, so no throw on a path that does not exist: the guard is what keeps a
    // whole-pool manifest from reading a gigabyte of audio it will not transcribe.
    expect(entry.audioDurationSec).toBe(4.25);
    expect(entry.clipId).toBe(
      "fleurs/da_dk/audio/test/1000000000000000001.wav",
    );
  });
});
