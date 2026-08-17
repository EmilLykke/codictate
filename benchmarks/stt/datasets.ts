/** LibriSpeech test splits the benchmark can run. Dataset keys in result files. */
export const LIBRISPEECH_SPLITS = ["test-clean", "test-other"] as const;

export type LibriSpeechSplit = (typeof LIBRISPEECH_SPLITS)[number];

export function isLibriSpeechSplit(value: string): value is LibriSpeechSplit {
  return (LIBRISPEECH_SPLITS as readonly string[]).includes(value);
}
