# The ekko Mirrors

`RyeAI/ekko-pnc` is the Danish Punctuation Model behind Punctuation Restoration, and
`RyeAI/ekko-v1-tiny` is the Danish Speech Model the ekko Speech Engine runs. Both
repositories are ungated and need no conversion, but a download from either would depend
on RyeAI keeping it unchanged under a shipped release. So Codictate hosts a **Mirror** of
each: a byte-for-byte copy of the pinned files at a pinned revision.

`scripts/mirror-ekko.ts` builds and uploads both, and is what you re-run if one ever has
to be rebuilt. It is one script for every ekko Mirror, one entry per Mirror in its
`MIRRORS` table, each published to a repo of its own.

## ekko-pnc

The Mirror repo is **`emillykkegrann/ekko-pnc-ONNX`**, never the ekko-v1-tiny repo: both
upstreams ship a different `NOTICE`, `MODEL_LICENSE.md` and `LICENSES/*` at their roots,
copied unchanged, so they cannot share a root.

Mirror commit: `44b0483333423a31d36907f1d71dee7e71045a42` (published 2026-10-29; every file verified
against the table below at that commit). The app pins this commit, not `main`.

### Contents

Copied from the source at revision `d3129544e4e0155093e192cac58a9e69a4dea1ff`. On
2026-10-29 the source's `main` had moved past it, but every runtime file was
byte-identical there, so the pin stays. Sizes from the Hugging Face tree API, sha256 from
the source's own `SHA256SUMS`, and both re-measured on a dry run of the script the same
day:

| File | Bytes | sha256 |
| --- | --- | --- |
| `pnc.int8.onnx` | 22424741 | `46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527` |
| `tokenizer.json` | 2301084 | `a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502` |
| `tokenizer_config.json` | 1269 | `69661a09d8db6efe1114ad1247626d362b710d8ddd16ffe015aad74017ad5e81` |
| `config.json` | 1062 | `dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca` |
| `NOTICE` | 445 | `bc86a9b47ff32a3ab29bb0ff8f414ae8b2ef1932ccf8bae2e4dacb5a6812ba8d` |
| `MODEL_LICENSE.md` | 502 | `590f820521961c89e7795bd3f46575794f4cbdcb02cc9db682e825c0afc874aa` |
| `LICENSES/CC-BY-4.0.txt` | 18657 | `9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411` |
| `LICENSES/CC0-1.0.txt` | 7048 | `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` |
| `LICENSES/CORAL-LICENSE` | 14112 | `ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd` |
| `LICENSES/FTSPEECH-LICENSE.md` | 486 | `39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a` |

The Mirror also carries a `README.md` the script writes: attribution to RyeAI, the
source repo and revision, and this table. `config.json` is where the label table lives
(`id2label`).

Not mirrored: `calibration.json`, which is already folded into the classifier bias of
`pnc.int8.onnx`; the FP32 export (`pnc.onnx`, `pnc.onnx.data`, `model.safetensors`); and
the upstream README, cover image, `vocab.txt` and export reports, none of which the
runtime reads.

### Licence position

CC BY 4.0, derived from `jonfd/electra-small-nordic` (also CC BY 4.0), and subject to the
CoRal restrictions in section 4 of `LICENSES/CORAL-LICENSE`, which `MODEL_LICENSE.md`
incorporates. Training-source notices for FT Speech and NST are in `NOTICE` and
`LICENSES/`. All of them are copied unchanged. The app bundles the same files in the
Punctuation Restoration change (#89). This is not legal advice.

## ekko-v1-tiny

The Mirror repo is **`emillykkegrann/ekko-v1-tiny-GGUF`**, never the ekko-pnc repo, for
the same reason: its `NOTICE`, `MODEL_LICENSE.md` and `LICENSES/*` differ from ekko-pnc's.

Mirror commit: `d60b91ae714fdccf4ecd7a9f22a06b349c87ffc1` (published 2026-10-29; the GGUF's
size and sha256 verified against the table below at that commit). The app pins this commit,
not `main` (`EKKO_V1_TINY_MIRROR_REVISION` in `src/shared/speech-models.ts`).

### Contents

Copied from the source at revision `3658535e7b2fa98d5d9aad8114573c0fab1e6203` (still
`main` on 2026-10-29). The GGUF moves from `gguf-parakeet.cpp/` to the Mirror root; every
other file keeps its path. Sizes from the Hugging Face tree API, the GGUF's sha256 from its
upstream LFS oid, the licence hashes measured on the files at that revision, and all of
them re-measured on a dry run of the script the same day:

| File | Upstream path | Bytes | sha256 |
| --- | --- | --- | --- |
| `ekko-v1-tiny-q5_0.gguf` | `gguf-parakeet.cpp/ekko-v1-tiny-q5_0.gguf` | 134710976 | `f5380485d80d552ae46313185126d7ade54b2e7360cb0d15b91f1ab26ced7791` |
| `NOTICE` | same | 391 | `1d720ec5fac9815e9374778a39406cb23a775b44c7fb0185709461cc597affef` |
| `MODEL_LICENSE.md` | same | 1078 | `3f0c10a453c459d4342fe0f079c98677fd733f9a49b5ad2084b5e2e159370c07` |
| `LICENSES/CC-BY-4.0.txt` | same | 18657 | `9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411` |
| `LICENSES/CORAL-LICENSE` | same | 14112 | `ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd` |
| `LICENSES/FTSPEECH-LICENSE.md` | same | 486 | `39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a` |
| `LICENSES/NVIDIA-OPEN-MODEL-LICENSE.pdf` | same | 79005 | `4d2fb590aa9b30c47f2058bff17291df7fa2aa0c1bd775a20703da9bb267cfab` |

The Mirror also carries a `README.md` the script writes: attribution to RyeAI, the source
repo and revision, and this table.

Not mirrored, q5_0 only (#78): the other GGUF Quantizations (f32, f16, q8_0, q6_k, q5_k,
q4_k, q4_0), the `.nemo` checkpoint, `onnx-sherpa/`, and the upstream README and images.

### Licence position

Derived from `nvidia/parakeet-rnnt-110m-da-dk` and licensed by NVIDIA Corporation under the
NVIDIA Open Model License (`LICENSES/NVIDIA-OPEN-MODEL-LICENSE.pdf`). RyeAI applies CC BY
4.0 to the modifications it can license; the CoRal restrictions in `LICENSES/CORAL-LICENSE`
and the FT Speech statement apply in addition, as `MODEL_LICENSE.md` sets out. All of them
are copied unchanged. This is not legal advice.

The app bundles the same `NOTICE`, `MODEL_LICENSE.md` and `LICENSES/*`, byte for byte, from
`docs/licenses/ekko-v1-tiny/` (`licenses/ekko-v1-tiny` in the app), like Edda's; the
electrobun config test pins their sha256 to the table above, and the reachability manual
check compares their sizes with the Mirror's.

### Download

Downloading ekko in the app (or `codictate models download ekko-v1-tiny-q5_0`) fetches the
GGUF from this Mirror through the single-file path, sha256 checked, then ekko-pnc from its
Mirror when it is missing, as one download. ekko counts as installed only with both on
disk, and deleting it removes the GGUF only.

## Re-running the mirror script

```bash
# HF_WRITE_TOKEN needs write access to the destination namespace. The sources are
# ungated, so no read token is needed.
read -s HF_WRITE_TOKEN && export HF_WRITE_TOKEN

bun run scripts/mirror-ekko.ts --print-readme              # review the model card
bun run scripts/mirror-ekko.ts --dry-run                   # download, verify, stage; upload nothing
bun run scripts/mirror-ekko.ts --only ekko-pnc             # create the repo and upload
bun run scripts/mirror-ekko.ts --only ekko-v1-tiny         # the same for ekko-v1-tiny
```

Without `--only` every Mirror in the table runs. `EKKO_PNC_MIRROR_REPO` and
`EKKO_V1_TINY_MIRROR_REPO` publish to a different repo.

The script downloads from the source at its pinned revision, never `main`, and stops
before staging if any file differs from its pinned size or sha256. It stages only the
pinned files and the README, and refuses an upload directory holding anything else. The
write token reaches the `hf` CLI through its environment only, for the create and upload
calls; it is never printed or put on a command line, and the download runs with no
token at all.

An upload makes a new Mirror commit: record it above and move the app's pinned Mirror
commit to it in the same change. Different bytes are a new model, not a refresh: re-pin
deliberately and regenerate the parity fixtures.
