// Builds the Edda v0.2 GGML weights and mirrors them into a Codictate-owned Hugging Face repo.
//
// WHY THIS EXISTS
// `danish-foundation-models/edda-v0.2` is ungated and Apache-2.0, but it ships fp16
// safetensors only, which crispasr cannot read. Unlike the hviske Mirror (a byte copy),
// this one is a conversion Codictate makes itself: GGML f16 with CrispASR's
// convert-h5-to-ggml.py, then q8_0 and q5_0 with CrispASR's legacy Whisper quantizer. The
// sha256 of each result is pinned in src/shared/speech-models.ts and checked on download,
// so a rebuild that produces different bytes stops here rather than shipping.
//
// YOU RUN THIS, NOT THE AGENT
// The upload needs a Hugging Face *write* token, which must never be pasted into an agent
// conversation or committed. The script only ever reads it from the environment:
//
//   export HF_WRITE_TOKEN=hf_...   # write access, for your own destination repo
//   export EDDA_PYTHON=/path/to/python   # a Python with torch, transformers, numpy
//   bun run scripts/mirror-edda.ts --dry-run
//   bun run scripts/mirror-edda.ts
//
// The token is not printed, logged, or passed on a command line: it is handed to the
// `hf` CLI through its environment only.
//
// Needs git, cmake and a C++ toolchain (to build the quantizer from CrispASR's source; the
// prebuilt `crispasr-quantize` is GGUF-only and cannot read Whisper GGML). See
// docs/EDDA_MIRROR.md.

import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EDDA_MIRROR_REPO_ID, getSpeechModel } from '../src/shared/speech-models'

const SOURCE_REPO = 'danish-foundation-models/edda-v0.2'
const SOURCE_REVISION = '98ec5eee028b111a19733890fe32ea65267b662b'
const SOURCE_URL = `https://huggingface.co/${SOURCE_REPO}`
/** Override with EDDA_MIRROR_REPO to publish under a different account. */
const DEST_REPO = process.env.EDDA_MIRROR_REPO?.trim() || EDDA_MIRROR_REPO_ID

/** The converter and quantizer come from the crispasr release Codictate ships. */
const CRISPASR_REPO = 'https://github.com/CrispStrobe/CrispASR.git'
const CRISPASR_TAG = 'v0.8.29'
/** Only `whisper/assets/mel_filters.npz` is read, so any commit carrying it works; pinned anyway. */
const WHISPER_REPO = 'https://github.com/openai/whisper.git'
const WHISPER_COMMIT = '86098128c0b4f24f0e2aa2994de830614b474227'

/** Largest first. Each `modelId` is the catalog entry whose sha256 the build must match. */
const FILES = [
  { modelId: 'edda-v0.2-f16', quant: null, note: 'full precision, largest and slowest' },
  { modelId: 'edda-v0.2-q8_0', quant: 'q8_0', note: 'about half the size of f16' },
  { modelId: 'edda-v0.2-q5_0', quant: 'q5_0', note: 'smallest and fastest' },
] as const

const ROOT = join(import.meta.dir, '..')
const WORK_DIR = join(ROOT, '.tmp', 'edda-mirror')
const UPLOAD_DIR = join(WORK_DIR, 'upload')

const dryRun = process.argv.includes('--dry-run')
const printReadmeOnly = process.argv.includes('--print-readme')

function fail(message: string): never {
  console.error(`\n[mirror-edda] ${message}`)
  process.exit(1)
}

function run(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): void {
  const proc = Bun.spawnSync(argv, {
    cwd: options.cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, ...options.env },
  })
  if (proc.exitCode !== 0) fail(`Command failed (${proc.exitCode}): ${argv.join(' ')}`)
}

/** Resolve the `hf` CLI (renamed from `huggingface-cli`). */
function resolveHfCli(): string {
  for (const candidate of ['hf', 'huggingface-cli']) {
    const which = Bun.spawnSync(['which', candidate], { stdout: 'pipe' })
    if (which.exitCode === 0) {
      const path = which.stdout.toString().trim()
      if (path) return path
    }
  }
  fail('Hugging Face CLI not found. Install it with: pip install -U huggingface_hub')
}

function artifactName(modelId: string): string {
  const model = getSpeechModel(modelId)
  if (!model) throw new Error(`${modelId} is not in the Speech Model catalog`)
  return model.artifactName
}

function expectedSha256(modelId: string): string {
  const sha = getSpeechModel(modelId)?.sha256
  if (!sha) throw new Error(`${modelId} has no sha256 in the Speech Model catalog`)
  return sha
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function mib(path: string): string {
  return `${Math.round(statSync(path).size / 1024 / 1024)} MiB`
}

function buildReadme(): string {
  const primary = artifactName('edda-v0.2-q5_0')
  return `---
license: apache-2.0
base_model: ${SOURCE_REPO}
tags:
  - automatic-speech-recognition
  - whisper
  - danish
  - ggml
language:
  - da
---

# Edda v0.2 GGML

GGML conversions of [\`${SOURCE_REPO}\`](${SOURCE_URL}) at revision
\`${SOURCE_REVISION}\`, for [whisper.cpp](https://github.com/ggml-org/whisper.cpp)-compatible
runtimes. Edda is by the [Alexandra Institute](https://alexandra.dk), trained within the CoRal
project and released by [Danish Foundation Models](https://huggingface.co/danish-foundation-models).
All credit for the model belongs to them.

This repository exists so [Codictate](https://github.com/EmilLykke/codictate) can offer
Edda as a Danish speech model. It is not affiliated with or endorsed by the authors.

## Licence

Released under the **Apache License 2.0**, the same licence as the original (see
\`LICENSE\`). Edda is a fine-tune of \`openai/whisper-large-v3-turbo\`, which is MIT-licensed
(see \`LICENSE-whisper\`). Attribution and the modification notice are in \`NOTICE\`.

## What was changed

The weights were converted, not retrained:

1. fp16 safetensors to GGML f16 with CrispASR ${CRISPASR_TAG}'s \`models/convert-h5-to-ggml.py\`.
   The source repo ships only \`tokenizer.json\`, so \`vocab.json\` and \`added_tokens.json\` were
   derived from it for the converter; both are identical to \`openai/whisper-large-v3-turbo\`'s.
   Because \`added_tokens.json\` is present, the file's vocabulary carries the 1,609 special-token
   strings (\`<|da|>\`, \`<|0.00|>\`, ...) that whisper.cpp's own conversions leave for the runtime
   to generate. That is the only difference from a stock conversion: 20,164 bytes of header,
   tensors unchanged.
2. f16 to q8_0 and q5_0 with CrispASR's legacy Whisper quantizer (\`crispasr-legacy-quantize\`).

## Files

| File | Notes |
| --- | --- |
${FILES.map((f) => `| \`${artifactName(f.modelId)}\` | ${f.note} |`).join('\n')}

Codictate's own measurements on FLEURS \`da_dk\` are in its repository. \`${primary}\` is the
place to start.

## Runtime

These are legacy GGML Whisper files. They load in whisper.cpp and in
[CrispASR](https://github.com/CrispStrobe/CrispASR)'s default Whisper backend. Pass
\`--language da\`: the model is Danish only.

## Requests

If the Alexandra Institute or Danish Foundation Models would like the attribution worded
differently, or would prefer this mirror taken down, open an issue on the Codictate
repository and it will be removed.
`
}

async function main() {
  if (printReadmeOnly) {
    console.log(buildReadme())
    return
  }

  console.log('=== Build and mirror Edda v0.2 GGML ===')
  console.log(`Source:      ${SOURCE_REPO} @ ${SOURCE_REVISION} (apache-2.0)`)
  console.log(`Destination: ${DEST_REPO}`)
  if (dryRun) console.log('Mode:        DRY RUN (nothing is uploaded)')
  console.log('')

  const python = process.env.EDDA_PYTHON?.trim()
  if (!python) {
    fail(
      'EDDA_PYTHON is not set. It must point at a Python with torch, transformers and numpy:\n' +
        '  python3 -m venv .tmp/edda-mirror/venv\n' +
        '  .tmp/edda-mirror/venv/bin/pip install torch transformers numpy safetensors\n' +
        '  export EDDA_PYTHON=$PWD/.tmp/edda-mirror/venv/bin/python',
    )
  }

  const writeToken = process.env.HF_WRITE_TOKEN?.trim()
  if (!writeToken && !dryRun) {
    fail(
      'HF_WRITE_TOKEN is not set. It needs write access to ' +
        `${DEST_REPO}.\n` +
        '  export HF_WRITE_TOKEN=hf_...\n' +
        '  Create one at https://huggingface.co/settings/tokens\n' +
        '  Keep it out of shell history, source control, and agent conversations.',
    )
  }

  const cli = resolveHfCli()
  mkdirSync(WORK_DIR, { recursive: true })

  // Step 1: the source weights, at the pinned revision. Ungated, so no token.
  const sourceDir = join(WORK_DIR, 'edda-src')
  console.log('--- Downloading the source weights ---')
  run(
    [
      cli,
      'download',
      SOURCE_REPO,
      '--revision',
      SOURCE_REVISION,
      '--local-dir',
      sourceDir,
    ],
    {
      env: { HF_HUB_DISABLE_TELEMETRY: '1' },
    },
  )

  // Step 2: the converter, the quantizer and the mel filters.
  const crispasrDir = join(WORK_DIR, 'crispasr-src')
  if (!existsSync(crispasrDir)) {
    console.log(`--- Cloning CrispASR ${CRISPASR_TAG} ---`)
    run([
      'git',
      'clone',
      '--depth',
      '1',
      '--branch',
      CRISPASR_TAG,
      CRISPASR_REPO,
      crispasrDir,
    ])
    run(
      [
        'git',
        'submodule',
        'update',
        '--init',
        '--depth',
        '1',
        'ggml',
        'third_party/c2pa-audio',
      ],
      {
        cwd: crispasrDir,
      },
    )
  }
  const quantizer = join(crispasrDir, 'build', 'bin', 'crispasr-legacy-quantize')
  if (!existsSync(quantizer)) {
    console.log('--- Building crispasr-legacy-quantize ---')
    run(['cmake', '-B', 'build', '-DCMAKE_BUILD_TYPE=Release'], { cwd: crispasrDir })
    run(
      ['cmake', '--build', 'build', '--target', 'crispasr-legacy-quantize', '-j', '8'],
      {
        cwd: crispasrDir,
      },
    )
  }
  const whisperDir = join(WORK_DIR, 'whisper-src')
  if (!existsSync(whisperDir)) {
    console.log('--- Fetching openai/whisper for the mel filters ---')
    mkdirSync(whisperDir, { recursive: true })
    run(['git', 'init', '-q'], { cwd: whisperDir })
    run(['git', 'fetch', '-q', '--depth', '1', WHISPER_REPO, WHISPER_COMMIT], {
      cwd: whisperDir,
    })
    run(['git', 'checkout', '-q', 'FETCH_HEAD'], { cwd: whisperDir })
  }

  // Step 3: a staging directory the converter can read. It wants vocab.json and
  // added_tokens.json, which the source repo does not ship, so both are derived from its
  // tokenizer.json. They come out identical to openai/whisper-large-v3-turbo's.
  const stageDir = join(WORK_DIR, 'stage')
  mkdirSync(stageDir, { recursive: true })
  for (const name of [
    'config.json',
    'generation_config.json',
    'model.safetensors',
    'tokenizer.json',
  ]) {
    const link = join(stageDir, name)
    if (!existsSync(link)) symlinkSync(join(sourceDir, name), link)
  }
  run([
    python!,
    '-I',
    '-c',
    [
      'import json, sys',
      'src, out = sys.argv[1], sys.argv[2]',
      'tok = json.load(open(f"{src}/tokenizer.json", encoding="utf8"))',
      'vocab = tok["model"]["vocab"]',
      'added = {t["content"]: t["id"] for t in tok["added_tokens"] if t["content"] not in vocab}',
      'json.dump(vocab, open(f"{out}/vocab.json", "w", encoding="utf8"), ensure_ascii=False)',
      'json.dump(added, open(f"{out}/added_tokens.json", "w", encoding="utf8"), ensure_ascii=False)',
    ].join('\n'),
    sourceDir,
    stageDir,
  ])

  // Step 4: convert, then quantize.
  mkdirSync(UPLOAD_DIR, { recursive: true })
  const f16Path = join(UPLOAD_DIR, artifactName('edda-v0.2-f16'))
  if (!existsSync(f16Path)) {
    console.log('--- Converting to GGML f16 ---')
    const convertOut = join(WORK_DIR, 'convert-out')
    mkdirSync(convertOut, { recursive: true })
    run([
      python!,
      join(crispasrDir, 'models', 'convert-h5-to-ggml.py'),
      stageDir,
      whisperDir,
      convertOut,
    ])
    renameSync(join(convertOut, 'ggml-model.bin'), f16Path)
  }
  for (const file of FILES) {
    if (!file.quant) continue
    const out = join(UPLOAD_DIR, artifactName(file.modelId))
    if (existsSync(out)) continue
    console.log(`--- Quantizing ${file.quant} ---`)
    run([quantizer, f16Path, out, file.quant])
  }

  // Step 5: every artifact must be byte-identical to what the catalog pins, or the app
  // would refuse the download. A mismatch is a different build, not a mirror refresh.
  console.log('--- Verifying sha256 against src/shared/speech-models.ts ---')
  for (const file of FILES) {
    const path = join(UPLOAD_DIR, artifactName(file.modelId))
    const actual = await sha256Of(path)
    const expected = expectedSha256(file.modelId)
    console.log(`  ${artifactName(file.modelId)}: ${mib(path)}, ${actual}`)
    if (actual !== expected) {
      fail(
        `${artifactName(file.modelId)} does not match the catalog.\n` +
          `  expected ${expected}\n  actual   ${actual}\n` +
          '  If the change is intended, update sha256 (and downloadSizeMB) in\n' +
          '  src/shared/speech-models.ts in the same change, and re-benchmark.',
      )
    }
  }
  console.log('')

  // Step 6: the README, the licence texts and the NOTICE ship with the weights.
  writeFileSync(join(UPLOAD_DIR, 'README.md'), buildReadme())
  copyFileSync(
    join(ROOT, 'docs', 'licenses', 'edda', 'LICENSE'),
    join(UPLOAD_DIR, 'LICENSE'),
  )
  copyFileSync(
    join(ROOT, 'docs', 'licenses', 'edda', 'LICENSE-whisper'),
    join(UPLOAD_DIR, 'LICENSE-whisper'),
  )
  copyFileSync(
    join(ROOT, 'docs', 'licenses', 'edda', 'NOTICE'),
    join(UPLOAD_DIR, 'NOTICE'),
  )
  console.log(`--- Staged the upload in ${UPLOAD_DIR} ---`)
  console.log('')

  if (dryRun) {
    console.log('Dry run complete. Nothing was uploaded.')
    console.log(`Review ${join(UPLOAD_DIR, 'README.md')}, then re-run without --dry-run.`)
    return
  }

  console.log(`--- Creating ${DEST_REPO} if it does not exist ---`)
  const hfEnv = { HF_TOKEN: writeToken!, HF_HUB_DISABLE_TELEMETRY: '1' }
  const createArgs = ['create', DEST_REPO, '--repo-type', 'model', '--exist-ok']
  // `hf repo` is deprecated in favour of `hf repos`; older huggingface_hub only has the former.
  let create = Bun.spawnSync([cli, 'repos', ...createArgs], {
    stderr: 'pipe',
    env: { ...process.env, ...hfEnv },
  })
  if (create.exitCode !== 0) {
    create = Bun.spawnSync([cli, 'repo', ...createArgs], {
      stderr: 'pipe',
      env: { ...process.env, ...hfEnv },
    })
  }
  if (create.exitCode !== 0 && !/exists/i.test(create.stderr.toString())) {
    fail(`Failed to create ${DEST_REPO}.\n\n${create.stderr.toString().slice(0, 1500)}`)
  }

  console.log(`--- Uploading to ${DEST_REPO} ---`)
  run(
    [
      cli,
      'upload',
      DEST_REPO,
      UPLOAD_DIR,
      '.',
      '--repo-type',
      'model',
      '--commit-message',
      `Edda v0.2 GGML (f16, q8_0, q5_0) from ${SOURCE_REPO}@${SOURCE_REVISION.slice(0, 7)}`,
    ],
    { env: hfEnv },
  )

  console.log('')
  console.log(`Done: https://huggingface.co/${DEST_REPO}`)
  console.log(
    'Then run: bun test ./src/bun/utils/whisper/model-download-reachability.manual.ts',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
