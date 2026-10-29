/**
 * What the Punctuation Model (ekko-pnc) is pinned to: the Mirror commit and every file with
 * its size and sha256. Plain data, so the window can read the download size from the same
 * table the download uses. Where it installs and whether it is on disk live in
 * `src/bun/utils/punctuation/punctuation-model-files.ts`.
 */

export const PUNCTUATION_MODEL_MIRROR_REPO_ID = 'emillykkegrann/ekko-pnc-ONNX'

/** The Mirror commit, never `main`. Moving it is a new model: regenerate the parity fixture. */
export const PUNCTUATION_MODEL_MIRROR_REVISION =
  '44b0483333423a31d36907f1d71dee7e71045a42'

export interface PunctuationModelFile {
  /** Path inside the Mirror repo, and inside `PUNCTUATION_MODEL_DIR`. */
  path: string
  bytes: number
  sha256: string
  /**
   * Read by Punctuation Restoration (`ekko-pnc-model.ts`), so the Punctuation Model counts as
   * installed only with it. The rest are the Mirror's licence and notice files: installed
   * beside the weights, but the app bundle carries its own copies for attribution, and
   * `tokenizer_config.json` is a file the Python reference does not read either.
   */
  runtime: boolean
}

/**
 * Every file of the Mirror except its generated README, at `PUNCTUATION_MODEL_MIRROR_REVISION`.
 * Sizes and sha256 as docs/EKKO_MIRROR.md records them (a test holds the two together).
 */
export const PUNCTUATION_MODEL_FILES: readonly PunctuationModelFile[] = [
  {
    path: 'pnc.int8.onnx',
    bytes: 22424741,
    sha256: '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527',
    runtime: true,
  },
  {
    path: 'tokenizer.json',
    bytes: 2301084,
    sha256: 'a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502',
    runtime: true,
  },
  {
    path: 'tokenizer_config.json',
    bytes: 1269,
    sha256: '69661a09d8db6efe1114ad1247626d362b710d8ddd16ffe015aad74017ad5e81',
    runtime: false,
  },
  {
    path: 'config.json',
    bytes: 1062,
    sha256: 'dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca',
    runtime: true,
  },
  {
    path: 'NOTICE',
    bytes: 445,
    sha256: 'bc86a9b47ff32a3ab29bb0ff8f414ae8b2ef1932ccf8bae2e4dacb5a6812ba8d',
    runtime: false,
  },
  {
    path: 'MODEL_LICENSE.md',
    bytes: 502,
    sha256: '590f820521961c89e7795bd3f46575794f4cbdcb02cc9db682e825c0afc874aa',
    runtime: false,
  },
  {
    path: 'LICENSES/CC-BY-4.0.txt',
    bytes: 18657,
    sha256: '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411',
    runtime: false,
  },
  {
    path: 'LICENSES/CC0-1.0.txt',
    bytes: 7048,
    sha256: 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
    runtime: false,
  },
  {
    path: 'LICENSES/CORAL-LICENSE',
    bytes: 14112,
    sha256: 'ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd',
    runtime: false,
  },
  {
    path: 'LICENSES/FTSPEECH-LICENSE.md',
    bytes: 486,
    sha256: '39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a',
    runtime: false,
  },
]

/** What turning Add punctuation on downloads, in MB (MiB, as Speech Model sizes are). */
export const PUNCTUATION_MODEL_DOWNLOAD_MB = Math.round(
  PUNCTUATION_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0) / 2 ** 20
)
