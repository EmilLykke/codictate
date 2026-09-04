/**
 * Clip identity: the one string that says *which audio file* a measurement is about.
 *
 * Before this module a measurement was located by an integer offset into a
 * deterministically ordered manifest (`benchmarks/stt/sample-cursor.ts`), and nothing
 * on disk recorded which clip produced which number - `ModelDatasetResult` carries a
 * rate, a denominator and a count, and no identity at all. An offset is enough to say
 * "this Combination has been measured 400 clips deep" and not enough for anything
 * else: two Benchmark Runs cannot be pooled without double-counting, an overlapping
 * rerun cannot replace only the clips it re-measured, and a resumed run cannot tell a
 * clip it already transcribed from one it has not reached. Benchmark v2 stores a
 * `clipId` per Sample so all three become set operations.
 *
 * The **clipId is the audio file's corpus-relative POSIX path**, relative to
 * `<codictate>/benchmarks/datasets`:
 *
 * ```
 * fleurs/da_dk/audio/test/12149430079508542992.wav
 * librispeech/wav/test-clean/1272-128104-0000.wav
 * ```
 *
 * Chosen rather than invented, because that exact string already exists in two
 * places and a third spelling would have to be reconciled with both:
 *
 * - `dictation-product-benchmark/src/portable-paths.ts::portableAudioPath()` writes it
 *   into every committed external run record, to keep the measuring machine out of the
 *   file. Verified by reading that function: it is `relative(datasetsRoot, audioPath)`
 *   over the same absolute paths `benchmarks/scripts/build-manifests.ts` builds -
 *   `join(datasetsDir, "fleurs", locale, "audio", "test", fileName)` and
 *   `join(datasetsDir, "librispeech", "wav", split, id + ".wav")` - so on POSIX it
 *   yields character-for-character what `fleursClipId` and `librispeechClipId` below
 *   return. `benchmarks/contract/clip-identity.test.ts` pins the two strings so a
 *   change here fails rather than silently forking the external archive.
 * - the datasets directory itself, which is the only place a reader can go to listen
 *   to the clip behind a number.
 *
 * No I/O here, on purpose. This module is copied into - or imported by - the external
 * harness, which has no Codictate checkout at type-check time and must not need one.
 */

/**
 * FLEURS ships one split per locale and the benchmark downloads only `test`, so the
 * split is a constant rather than a parameter. `benchmarks/scripts/download-fleurs.ts`
 * fetches the test split alone; a second split would need a second manifest builder
 * and a new derivation here, which is the point at which it should become an argument.
 */
export const FLEURS_SPLIT = "test";

/** `C:\clips\17.wav`, `\\share\clips`: absolute, but not to POSIX `isAbsolute`. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * The canonical clipId for an audio path already relative to the datasets root.
 *
 * A clipId is compared by string equality across three repositories and several storage
 * formats, so every accepted spelling of one path has to collapse to one string here.
 * Identity is the single thing in this system that must not have two spellings, and the
 * failure is silent in both directions: one clip pooling as two halves its measured
 * depth, two clips pooling as one publishes a rate over a sample nobody selected.
 *
 * **Normalised**, because these are pure path syntax and no filesystem gives them a
 * meaning of their own:
 *
 * - `\` becomes `/`.
 * - A leading `./` or `/` goes.
 * - An **interior** `/./` goes, and repeated slashes collapse. `fleurs/./a.wav`,
 *   `fleurs//a.wav` and `fleurs/a.wav` are one clip; before this they were three, and
 *   identically three in all three repositories, so nothing disagreed loudly enough to
 *   notice.
 *
 * **Refused**, because normalising would be a guess:
 *
 * - `..` anywhere. Not collapsed: a `..` means the caller built the path against a
 *   different root, and resolving it yields a plausible-looking id for a clip outside the
 *   corpus.
 * - Leading or trailing **whitespace**, on the whole string or on any segment. This one
 *   is deliberately not trimmed, which is the opposite of the usual advice: a POSIX
 *   filename may legitimately begin or end with a space, so trimming would either make a
 *   real file unaddressable or silently merge two genuinely different clips. A caller
 *   holding `" a.wav"` has either a real oddity or a parsing bug, and only the caller can
 *   tell which.
 */
export function clipIdFromRelativeAudioPath(relativePath: string): string {
  const posix = relativePath.replace(/\\/g, "/");
  if (WINDOWS_ABSOLUTE.test(relativePath)) {
    throw new Error(
      `clipId must be relative to benchmarks/datasets, got the absolute path "${relativePath}". ` +
        `Use clipIdFromAbsoluteAudioPath(audioPath, datasetsRoot) instead.`,
    );
  }

  const segments = posix.split("/");
  if (segments.includes("..")) {
    throw new Error(
      `clipId must not escape the datasets root, got "${relativePath}".`,
    );
  }
  // Drops leading and interior `.` segments and every empty segment, which is what
  // collapses `./a`, `a/./b` and `a//b` onto one spelling.
  const kept = segments.filter(
    (segment) => segment.length > 0 && segment !== ".",
  );

  for (const segment of kept) {
    if (segment !== segment.trim()) {
      throw new Error(
        `clipId segment "${segment}" in "${relativePath}" has leading or trailing ` +
          `whitespace. It is not trimmed, because a file name may legitimately contain ` +
          `one: normalise it at the source, where it is known whether the space is real.`,
      );
    }
  }

  const normalised = kept.join("/");
  if (normalised.length === 0) {
    throw new Error(`clipId must not be empty, got "${relativePath}".`);
  }
  return normalised;
}

/**
 * The canonical clipId for the absolute path a manifest entry carries.
 *
 * The runner keeps absolute paths in memory - it has to open the WAV files - so this
 * is the seam between "a file on this machine" and "a clip every reader can name".
 *
 * Throws when the path is not under the root, where `portableAudioPath` falls back to
 * the bare file name. That fallback is right for its job (a record written on Windows
 * still shows something useful) and wrong for identity: a bare `1272-128104-0000.wav`
 * would pool as a different clip from the same file named properly, so the two
 * measurements of one clip would both be counted.
 */
export function clipIdFromAbsoluteAudioPath(
  audioPath: string,
  datasetsRoot: string,
): string {
  const path = audioPath.replace(/\\/g, "/");
  const root = datasetsRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path.startsWith(`${root}/`)) {
    throw new Error(
      `"${audioPath}" is not under the datasets root "${datasetsRoot}", so it has no clipId. ` +
        `Every measured clip must live in <codictate>/benchmarks/datasets.`,
    );
  }
  return clipIdFromRelativeAudioPath(path.slice(root.length + 1));
}

/**
 * The clipId for one FLEURS utterance.
 *
 * `fileName` is **TSV column index 1** (`file_name`), and only ever that. Column 0 is
 * the *sentence* id: FLEURS reads several recordings of the same sentence, so column 0
 * repeats - Danish `test.tsv` has 930 rows and 350 distinct column-0 values, Spanish
 * 908 and 348, Hungarian 905 and 348 (measured, see
 * `benchmarks/contract/fleurs-identity.manual.ts`). Keying identity on column 0 would
 * silently collapse 930 clips to 350: two thirds of a Danish run would look like
 * duplicate measurements of clips already done, a resume would skip them, and a pool
 * would keep one recording per sentence and discard the rest.
 *
 * Column 0 survives as `sentenceId` on the Sample - it is the right key for "did the
 * model get this *sentence* right across speakers" - but it is never identity, never a
 * dedup key and never a fingerprint input.
 */
export function fleursClipId(locale: string, fileName: string): string {
  return clipIdFromRelativeAudioPath(
    `fleurs/${locale}/audio/${FLEURS_SPLIT}/${fileName}`,
  );
}

/**
 * The clipId for one LibriSpeech utterance.
 *
 * The utterance id (`1272-128104-0000`) is already unique across the corpus, but the
 * clipId is still the relative wav path: one derivation for both datasets means the
 * pooling and resume code never asks which corpus a clipId came from, and the string
 * still points at a file a reader can play. `.wav` is appended if the caller passed a
 * bare id and left alone otherwise, so passing `entry.id` or `basename(entry.audioPath)`
 * both give the same id.
 */
export function librispeechClipId(split: string, utteranceId: string): string {
  const id = utteranceId.endsWith(".wav")
    ? utteranceId.slice(0, -".wav".length)
    : utteranceId;
  return clipIdFromRelativeAudioPath(`librispeech/wav/${split}/${id}.wav`);
}

/**
 * First occurrence of each value, later duplicates dropped, order otherwise untouched.
 *
 * The de-duplication half of the v2 fingerprint (see `schema.ts::fingerprintV2`), and
 * the reason the fingerprint of a plan is stable under an accidental repeat: order is
 * significant, multiplicity is not.
 */
export function uniqueInOrder<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Refuses a clip list that names the same clip twice, saying which clip and at which
 * indices.
 *
 * Called on every Run Plan rather than left to the fingerprint's `uniqueInOrder`,
 * because the two want opposite things. The fingerprint has to be tolerant so a plan
 * and its own de-duplicated re-derivation agree; a plan has to be strict, because a
 * duplicate in it means the *selection* is wrong - the adapter would be invoked twice
 * on one clip and the run would claim a depth it does not have. Acceptance gate 1 is
 * exactly this: a 400-clip range invokes the adapter 400 times on 400 distinct files.
 *
 * The indices are in the message because the duplicate is almost never visible in the
 * clipId itself: the FLEURS file names are 20-digit hashes, and the interesting fact is
 * that positions 12 and 511 of the plan are the same clip.
 */
export function assertUniqueClipIds(
  clipIds: readonly string[],
  label = "clip list",
): void {
  const firstIndex = new Map<string, number>();
  for (let index = 0; index < clipIds.length; index++) {
    const clipId = clipIds[index];
    const previous = firstIndex.get(clipId);
    if (previous !== undefined) {
      throw new Error(
        `${label} names the same clip twice: "${clipId}" at index ${previous} and index ${index}. ` +
          `A clipId is the identity of one audio file, so a repeat means the selection is wrong.`,
      );
    }
    firstIndex.set(clipId, index);
  }
}
