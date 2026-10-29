// Mirrors the ekko Danish models into Codictate-owned Hugging Face repos.
//
// WHY THIS EXISTS
// A Mirror (see GLOSSARY.md) is a copy Codictate hosts itself, so a download never
// depends on RyeAI keeping its repository unchanged. Each Mirror here is a byte copy of
// pinned files at a pinned source revision, checked against a pinned size and sha256
// before anything is staged. One Mirror per upstream repo: the upstreams ship different
// `NOTICE` / `MODEL_LICENSE.md` / `LICENSES/*` at their roots, copied unchanged, so two
// upstreams cannot share a Mirror root.
//
// Today that is ekko-pnc, the Punctuation Model. ekko-v1-tiny (#90, #101) is added as a
// second entry in MIRRORS, with its own destination repo.
//
// YOU RUN THIS, NOT THE AGENT
// The upload needs a Hugging Face *write* token, which must never be pasted into an agent
// conversation or committed. The script only ever reads it from the environment:
//
//   read -s HF_WRITE_TOKEN && export HF_WRITE_TOKEN   # write access to the destination
//   bun run scripts/mirror-ekko.ts --dry-run
//   bun run scripts/mirror-ekko.ts
//
// The sources are ungated, so no read token is needed. The write token is not printed,
// logged, or passed on a command line: it reaches the `hf` CLI through its environment
// only, and only for the create and upload calls. See docs/EKKO_MIRROR.md.

import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { createHash } from 'node:crypto'

export type MirrorFile = {
  /** Path in the source repo, kept unchanged in the Mirror. */
  path: string
  bytes: number
  sha256: string
}

export type Mirror = {
  /** What `--only` selects. */
  id: string
  sourceRepo: string
  /** Pinned so a later push to the source cannot reach a rebuilt Mirror unnoticed. */
  sourceRevision: string
  destRepo: string
  /** Every file the Mirror carries besides its README, verified before staging. */
  files: readonly MirrorFile[]
  commitMessage: string
  readme: () => string
}

const EKKO_PNC_SOURCE_REPO = 'RyeAI/ekko-pnc'
/**
 * Re-checked 2026-10-29: `main` has moved since, but every runtime file is byte-identical
 * there, so the Mirror keeps this revision (#89).
 */
const EKKO_PNC_SOURCE_REVISION = 'd3129544e4e0155093e192cac58a9e69a4dea1ff'

/**
 * Sizes from the Hugging Face tree API and sha256 from the source's own `SHA256SUMS`, both
 * at EKKO_PNC_SOURCE_REVISION. `calibration.json` is left out on purpose: it is already
 * folded into the classifier bias of `pnc.int8.onnx`. The FP32 export, `vocab.txt` and
 * the training artefacts are not runtime files.
 */
const EKKO_PNC_FILES: readonly MirrorFile[] = [
  {
    path: 'pnc.int8.onnx',
    bytes: 22424741,
    sha256: '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527',
  },
  {
    path: 'tokenizer.json',
    bytes: 2301084,
    sha256: 'a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502',
  },
  {
    path: 'tokenizer_config.json',
    bytes: 1269,
    sha256: '69661a09d8db6efe1114ad1247626d362b710d8ddd16ffe015aad74017ad5e81',
  },
  {
    // Its `id2label` is the label table the Punctuation Restorer renders.
    path: 'config.json',
    bytes: 1062,
    sha256: 'dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca',
  },
  {
    path: 'NOTICE',
    bytes: 445,
    sha256: 'bc86a9b47ff32a3ab29bb0ff8f414ae8b2ef1932ccf8bae2e4dacb5a6812ba8d',
  },
  {
    path: 'MODEL_LICENSE.md',
    bytes: 502,
    sha256: '590f820521961c89e7795bd3f46575794f4cbdcb02cc9db682e825c0afc874aa',
  },
  {
    path: 'LICENSES/CC-BY-4.0.txt',
    bytes: 18657,
    sha256: '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411',
  },
  {
    path: 'LICENSES/CC0-1.0.txt',
    bytes: 7048,
    sha256: 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
  },
  {
    path: 'LICENSES/CORAL-LICENSE',
    bytes: 14112,
    sha256: 'ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd',
  },
  {
    path: 'LICENSES/FTSPEECH-LICENSE.md',
    bytes: 486,
    sha256: '39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a',
  },
]

/**
 * Null when a downloaded file is the pinned one, else the sentence to fail with. A Mirror
 * is a byte copy, so any difference means the source moved, never a refresh.
 */
export function checkMirrorFile(
  file: MirrorFile,
  actual: { bytes: number; sha256: string },
): string | null {
  if (actual.bytes === file.bytes && actual.sha256 === file.sha256) return null
  return (
    `${file.path} is not the pinned file.\n` +
    `  expected ${file.bytes} bytes, sha256 ${file.sha256}\n` +
    `  actual   ${actual.bytes} bytes, sha256 ${actual.sha256}\n` +
    '  Different bytes are a new model, not a refresh: re-pin deliberately, regenerate\n' +
    '  the parity fixtures, and update the app table and docs/EKKO_MIRROR.md together.'
  )
}

/** The Mirror's own model card, written beside the copied files. */
export const README_PATH = 'README.md'

/**
 * What is wrong with a staged upload directory, given every file path in it (relative,
 * `/`-separated). It must hold the mirrored files and the README and nothing else, so a
 * stray download cache or an unpinned upstream file can never reach the Mirror.
 */
export function stagedUploadProblems(mirror: Mirror, stagedPaths: readonly string[]): string[] {
  const expected = new Set([README_PATH, ...mirror.files.map((f) => f.path)])
  const staged = new Set(stagedPaths)
  const problems: string[] = []
  for (const path of staged) {
    if (!expected.has(path)) problems.push(`unexpected file staged: ${path}`)
  }
  for (const path of expected) {
    if (!staged.has(path)) problems.push(`missing from the stage: ${path}`)
  }
  return problems
}

type Env = Record<string, string | undefined>

/**
 * The environment for one `hf` CLI call. The token goes in as HF_TOKEN, which is the only
 * way it reaches the CLI: never argv, where `ps` would show it, and never this script's
 * output. With no token (the ungated download) neither variable survives, so a token the
 * shell happens to hold is not sent where nothing needs it.
 */
export function hfEnv(base: Env, token: string | null): Env {
  const env: Env = { ...base, HF_HUB_DISABLE_TELEMETRY: '1' }
  delete env.HF_TOKEN
  delete env.HF_WRITE_TOKEN
  if (token) env.HF_TOKEN = token
  return env
}

/**
 * The write token, read from HF_WRITE_TOKEN only. A dry run uploads nothing and needs
 * none. Throws when a publish has none, with a message that names the variable and
 * never a token.
 */
export function writeTokenFor(env: Env, options: { dryRun: boolean }): string | null {
  if (options.dryRun) return null
  const token = env.HF_WRITE_TOKEN?.trim()
  if (!token) {
    throw new Error(
      'HF_WRITE_TOKEN is not set. It needs write access to the destination repo.\n' +
        '  read -s HF_WRITE_TOKEN && export HF_WRITE_TOKEN\n' +
        '  Create one at https://huggingface.co/settings/tokens\n' +
        '  Keep it out of shell history, source control, and agent conversations.',
    )
  }
  return token
}

export const MIRRORS: readonly Mirror[] = [
  {
    id: 'ekko-pnc',
    sourceRepo: EKKO_PNC_SOURCE_REPO,
    sourceRevision: EKKO_PNC_SOURCE_REVISION,
    /** Override with EKKO_PNC_MIRROR_REPO to publish under a different account. */
    destRepo: process.env.EKKO_PNC_MIRROR_REPO?.trim() || 'emillykkegrann/ekko-pnc-ONNX',
    files: EKKO_PNC_FILES,
    commitMessage: `Mirror ekko-pnc int8 ONNX from ${EKKO_PNC_SOURCE_REPO}@${EKKO_PNC_SOURCE_REVISION.slice(0, 7)} (CC BY 4.0)`,
    readme: ekkoPncReadme,
  },
]

/** The Mirrors to run: all of them, or the one `--only <id>` names. */
export function selectMirrors(argv: readonly string[]): Mirror[] {
  const at = argv.indexOf('--only')
  if (at === -1) return [...MIRRORS]
  const id = argv[at + 1]
  if (!id || id.startsWith('--')) {
    throw new Error(`--only needs a Mirror id: ${MIRRORS.map((m) => m.id).join(', ')}`)
  }
  const mirror = MIRRORS.find((m) => m.id === id)
  if (!mirror) {
    throw new Error(
      `No Mirror is called ${id}. Known: ${MIRRORS.map((m) => m.id).join(', ')}`,
    )
  }
  return [mirror]
}

function ekkoPncReadme(): string {
  const source = `https://huggingface.co/${EKKO_PNC_SOURCE_REPO}`
  return `---
license: cc-by-4.0
base_model: ${EKKO_PNC_SOURCE_REPO}
pipeline_tag: token-classification
tags:
  - punctuation-restoration
  - truecasing
  - danish
  - onnx
language:
  - da
---

# ekko-pnc int8 ONNX (mirror)

This is an **unmodified mirror** of the int8 ONNX runtime files of
[\`${EKKO_PNC_SOURCE_REPO}\`](${source}) at revision \`${EKKO_PNC_SOURCE_REVISION}\`, made by
[RyeAI](https://huggingface.co/RyeAI). All credit for the model belongs to them.

It exists so [Codictate](https://github.com/EmilLykke/codictate) can add punctuation and
capitals to Danish dictation without depending on the upstream repository staying
unchanged. Every file is a byte-for-byte copy; nothing was converted or retrained.

## Licence

Released under **CC BY 4.0**, the same licence as the original, and subject to the CoRal
restrictions in section 4 of \`LICENSES/CORAL-LICENSE\`. The upstream \`MODEL_LICENSE.md\`,
\`NOTICE\` and \`LICENSES/\` are copied here unchanged and are the terms that apply. Codictate
is free and open source software with no paid version.

- Original model: [\`${EKKO_PNC_SOURCE_REPO}\`](${source})
- Original author: [RyeAI](https://huggingface.co/RyeAI)
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), see \`MODEL_LICENSE.md\`

## Files

| File | Bytes | sha256 |
| --- | --- | --- |
${EKKO_PNC_FILES.map((f) => `| \`${f.path}\` | ${f.bytes} | \`${f.sha256}\` |`).join('\n')}

The sha256 values match the upstream \`SHA256SUMS\` at that revision. \`calibration.json\` is
not mirrored: it is already folded into the weights of \`pnc.int8.onnx\`. For the FP32 export,
the training details and the evaluation, see the original repository.

## Requests

If RyeAI would like the attribution worded differently, or would prefer this mirror taken
down, open an issue on the Codictate repository and it will be removed.
`
}

// --- Running it -----------------------------------------------------------------------

const ROOT = join(import.meta.dir, '..')
const WORK_ROOT = join(ROOT, '.tmp', 'ekko-mirror')

function fail(message: string): never {
  console.error(`\n[mirror-ekko] ${message}`)
  process.exit(1)
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

/** Every argv here is built without a token; tokens travel in `hfEnv` only. */
function runHf(
  cli: string,
  args: string[],
  token: string | null,
): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: hfEnv(process.env, token),
  })
  const stdout = proc.stdout.toString()
  if (stdout.trim()) console.log(stdout.trimEnd())
  return { ok: proc.exitCode === 0, stdout, stderr: proc.stderr.toString() }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Every file under `dir`, relative and `/`-separated. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => rel.split(sep).join('/'))
}

async function mirrorOne(
  mirror: Mirror,
  cli: string,
  writeToken: string | null,
  dryRun: boolean,
): Promise<void> {
  console.log(`=== ${mirror.id} ===`)
  console.log(`Source:      ${mirror.sourceRepo} @ ${mirror.sourceRevision}`)
  console.log(`Destination: ${mirror.destRepo}`)
  console.log('')

  const workDir = join(WORK_ROOT, mirror.id)
  const downloadDir = join(workDir, 'download')
  const uploadDir = join(workDir, 'upload')

  // Step 1: the pinned files at the pinned revision. Ungated, so no token.
  console.log('--- Downloading from the source repo ---')
  const download = runHf(
    cli,
    [
      'download',
      mirror.sourceRepo,
      ...mirror.files.map((f) => f.path),
      '--revision',
      mirror.sourceRevision,
      '--local-dir',
      downloadDir,
    ],
    null,
  )
  if (!download.ok) {
    fail(`Download from ${mirror.sourceRepo} failed.\n\n${download.stderr.slice(0, 1500)}`)
  }

  // Step 2: a Mirror is a byte copy, so every file must be exactly the pinned one.
  console.log('--- Verifying size and sha256 against the pins ---')
  for (const file of mirror.files) {
    const path = join(downloadDir, file.path)
    if (!existsSync(path)) fail(`Expected ${path} after download, but it is missing.`)
    const actual = { bytes: statSync(path).size, sha256: await sha256Of(path) }
    console.log(`  ${file.path}: ${actual.bytes} bytes, ${actual.sha256}`)
    const problem = checkMirrorFile(file, actual)
    if (problem) fail(problem)
  }
  console.log('')

  // Step 3: stage exactly the verified files and the model card, nothing else (the
  // download dir also holds hf's own `.cache/huggingface` metadata).
  rmSync(uploadDir, { recursive: true, force: true })
  for (const file of mirror.files) {
    const target = join(uploadDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(downloadDir, file.path), target)
  }
  writeFileSync(join(uploadDir, README_PATH), mirror.readme())
  const problems = stagedUploadProblems(mirror, listFiles(uploadDir))
  if (problems.length > 0) fail(`The staged upload is wrong:\n  ${problems.join('\n  ')}`)
  console.log(`--- Staged the upload in ${uploadDir} ---`)
  console.log('')

  if (dryRun || !writeToken) return

  // Step 4: create the destination repo, then upload, with the write token in env only.
  console.log(`--- Creating ${mirror.destRepo} if it does not exist ---`)
  // `hf repo` is deprecated in favour of `hf repos`; older huggingface_hub only has the former.
  const createArgs = ['create', mirror.destRepo, '--repo-type', 'model', '--exist-ok']
  let create = runHf(cli, ['repos', ...createArgs], writeToken)
  if (!create.ok) create = runHf(cli, ['repo', ...createArgs], writeToken)
  if (!create.ok && !/exists/i.test(create.stderr)) {
    fail(`Failed to create ${mirror.destRepo}.\n\n${create.stderr.slice(0, 1500)}`)
  }

  console.log(`--- Uploading to ${mirror.destRepo} ---`)
  const upload = runHf(
    cli,
    [
      'upload',
      mirror.destRepo,
      uploadDir,
      '.',
      '--repo-type',
      'model',
      '--commit-message',
      mirror.commitMessage,
    ],
    writeToken,
  )
  if (!upload.ok) fail(`Upload failed.\n\n${upload.stderr.slice(0, 1500)}`)

  // The app pins the Mirror commit, not `main`, so name it for the doc.
  const info = await fetch(
    `https://huggingface.co/api/models/${mirror.destRepo}/revision/main`,
  ).then((r) => (r.ok ? (r.json() as Promise<{ sha?: string }>) : null), () => null)
  console.log('')
  console.log(`Done: https://huggingface.co/${mirror.destRepo}`)
  console.log(
    info?.sha
      ? `Mirror commit: ${info.sha}\nRecord it in docs/EKKO_MIRROR.md.`
      : 'Could not read the Mirror commit; take it from the upload output above.',
  )
  console.log('')
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  let mirrors: Mirror[]
  try {
    mirrors = selectMirrors(argv)
  } catch (err) {
    fail((err as Error).message)
  }

  // Lets the model cards be reviewed without a download or a token.
  if (argv.includes('--print-readme')) {
    for (const mirror of mirrors) console.log(mirror.readme())
    return
  }

  let writeToken: string | null
  try {
    writeToken = writeTokenFor(process.env, { dryRun })
  } catch (err) {
    fail((err as Error).message)
  }

  if (dryRun) console.log('Mode: DRY RUN (nothing is uploaded)\n')
  const cli = resolveHfCli()
  for (const mirror of mirrors) await mirrorOne(mirror, cli, writeToken, dryRun)

  if (dryRun) {
    console.log('Dry run complete. Nothing was uploaded.')
    console.log(`Review the staged README.md under ${WORK_ROOT}, then re-run without --dry-run.`)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
