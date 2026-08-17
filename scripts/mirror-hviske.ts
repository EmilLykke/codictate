// Mirrors the hviske-v5-tiny GGUF weights into a Codictate-owned Hugging Face repo.
//
// WHY THIS EXISTS
// `syvai/hviske-v5-tiny` is `gated: manual`, so end users cannot download from it
// inside the app. A Mirror (see CONTEXT.md) is a copy Codictate hosts itself.
// CC BY-NC 4.0 permits non-commercial redistribution with attribution, which is why
// the destination README keeps the licence unchanged and credits syvai. This is not
// legal advice, and syvai gated the repo deliberately, so ask them first.
//
// YOU RUN THIS, NOT THE AGENT
// It needs a Hugging Face *write* token, which must never be pasted into an agent
// conversation or committed. The script only ever reads it from the environment:
//
//   export HF_TOKEN=hf_...        # read access, for the gated source repo
//   export HF_WRITE_TOKEN=hf_...        # write access, for your own destination repo
//   bun run scripts/mirror-hviske.ts --dry-run
//   bun run scripts/mirror-hviske.ts
//
// Neither token is printed, logged, or passed on a command line: both are handed to
// the `hf` CLI through its environment only.

import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE_REPO = 'syvai/hviske-v5-tiny'
const SOURCE_URL = `https://huggingface.co/${SOURCE_REPO}`
const DEST_REPO = 'emillykkegrann/hviske-v5-tiny-GGUF'
const LICENSE_ID = 'cc-by-nc-4.0'

/**
 * Both quantizations ship so the benchmark can settle which to default to. The model
 * card lists identical WER (10.51) for the two, and f16 is the chosen primary.
 */
const FILES = [
  {
    sourcePath: 'gguf/hviske-v5-tiny-f16.gguf',
    name: 'hviske-v5-tiny-f16.gguf',
    approxSize: '527 MB',
    note: 'primary',
  },
  {
    sourcePath: 'gguf/hviske-v5-tiny-q4_k.gguf',
    name: 'hviske-v5-tiny-q4_k.gguf',
    approxSize: '160 MB',
    note: 'smallest',
  },
]

const WORK_DIR = join(import.meta.dir, '..', '.tmp', 'hviske-mirror')

const dryRun = process.argv.includes('--dry-run')
const printReadmeOnly = process.argv.includes('--print-readme')

function fail(message: string): never {
  console.error(`\n[mirror-hviske] ${message}`)
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
  fail(
    'Hugging Face CLI not found. Install it with: pip install -U huggingface_hub',
  )
}

/**
 * Run the CLI with tokens supplied through the environment only, so neither token
 * reaches argv (where `ps` would expose it) or this script's output.
 */
function runHf(
  cli: string,
  args: string[],
  token: string,
): { ok: boolean; stderr: string } {
  const proc = Bun.spawnSync([cli, ...args], {
    stdout: 'inherit',
    stderr: 'pipe',
    env: { ...process.env, HF_TOKEN: token, HF_HUB_DISABLE_TELEMETRY: '1' },
  })
  return { ok: proc.exitCode === 0, stderr: proc.stderr.toString() }
}

function buildReadme(): string {
  const primary = FILES[0].name
  return `---
license: ${LICENSE_ID}
base_model: ${SOURCE_REPO}
tags:
  - automatic-speech-recognition
  - danish
  - gguf
language:
  - da
---

# hviske-v5-tiny GGUF (mirror)

This is an **unmodified mirror** of the GGUF conversions of
[\`${SOURCE_REPO}\`](${SOURCE_URL}), created by
[syvai](https://huggingface.co/syvai). All credit for the model belongs to them.

The original repository is gated, which means applications cannot download from it
on a user's behalf. This mirror exists so [Codictate](https://github.com/EmilLykke/codictate)
can offer hviske-v5-tiny as a Danish speech model. Nothing about the weights has
been changed.

## Licence

Released under **CC BY-NC 4.0**, the same licence as the original. Non-commercial
use only, attribution required. Codictate is free and open source software with no
paid version and no commercial use.

- Original model: [\`${SOURCE_REPO}\`](${SOURCE_URL})
- Original author: [syvai](https://huggingface.co/syvai)
- Licence: [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

## Files

| File | Size | Notes |
| --- | --- | --- |
${FILES.map((f) => `| \`${f.name}\` | ${f.approxSize} | ${f.note} |`).join('\n')}

\`${primary}\` is the default Codictate uses.

## Runtime

These GGUFs load only under [CrispASR](https://github.com/CrispStrobe/CrispASR)'s
\`cohere\` backend (\`--backend cohere\`). whisper.cpp and llama.cpp cannot read them.

## Requests

If syvai would like the attribution worded differently, or would prefer this mirror
taken down, open an issue on the Codictate repository and it will be removed.
`
}

async function main() {
  // Lets the model card be reviewed without a 690 MB download first.
  if (printReadmeOnly) {
    console.log(buildReadme())
    return
  }

  console.log('=== Mirror hviske-v5-tiny GGUF ===')
  console.log(`Source:      ${SOURCE_REPO} (gated, ${LICENSE_ID})`)
  console.log(`Destination: ${DEST_REPO}`)
  console.log(`Files:       ${FILES.map((f) => f.name).join(', ')}`)
  if (dryRun) console.log('Mode:        DRY RUN (nothing is uploaded)')
  console.log('')

  console.log('Before running this, confirm all of the following:')
  console.log('  1. syvai has been asked whether mirroring is acceptable.')
  console.log('  2. The destination repo stays CC BY-NC 4.0 with attribution.')
  console.log('  3. Codictate remains free, with no commercial use.')
  console.log('')

  const readToken = process.env.HF_TOKEN?.trim()
  if (!readToken) {
    fail(
      'HF_TOKEN is not set. It needs read access to the gated source repo.\n' +
        '  export HF_TOKEN=hf_...',
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

  // Step 1: pull the weights from the gated source with the read token.
  console.log('--- Downloading from the gated source repo ---')
  for (const file of FILES) {
    const localPath = join(WORK_DIR, file.name)
    if (existsSync(localPath)) {
      console.log(`  ${file.name}: already downloaded`)
      continue
    }
    console.log(`  ${file.name} (${file.approxSize})...`)
    const result = runHf(
      cli,
      [
        'download',
        SOURCE_REPO,
        file.sourcePath,
        '--local-dir',
        WORK_DIR,
      ],
      readToken,
    )
    if (!result.ok) {
      fail(
        `Failed to download ${file.sourcePath}.\n` +
          '  If this is a 401 or 403, your HF_TOKEN account has not been granted\n' +
          `  access to ${SOURCE_REPO} yet. Request it at ${SOURCE_URL}\n\n` +
          result.stderr.slice(0, 1500),
      )
    }
    // `hf download` preserves the repo's directory layout, so flatten gguf/ out.
    const nested = join(WORK_DIR, file.sourcePath)
    if (existsSync(nested) && !existsSync(localPath)) {
      Bun.spawnSync(['mv', nested, localPath])
    }
  }

  for (const file of FILES) {
    const localPath = join(WORK_DIR, file.name)
    if (!existsSync(localPath)) {
      fail(`Expected ${localPath} after download, but it is missing.`)
    }
    const mb = Math.round(statSync(localPath).size / 1024 / 1024)
    console.log(`  ${file.name}: ${mb} MB on disk`)
  }
  console.log('')

  // Step 2: the README carries the attribution and licence, so it ships too.
  const readmePath = join(WORK_DIR, 'README.md')
  writeFileSync(readmePath, buildReadme())
  console.log(`--- Wrote model card to ${readmePath} ---`)
  console.log('')

  if (dryRun) {
    console.log('Dry run complete. Nothing was uploaded.')
    console.log(`Review ${readmePath}, then re-run without --dry-run.`)
    return
  }

  // Step 3: create the destination repo, then upload.
  console.log(`--- Creating ${DEST_REPO} if it does not exist ---`)
  // `hf repo` is deprecated in favour of `hf repos`, but older huggingface_hub
  // releases only have the singular form, so try the current name first.
  const createArgs = ['create', DEST_REPO, '--repo-type', 'model', '--exist-ok']
  let create = runHf(cli, ['repos', ...createArgs], writeToken!)
  if (!create.ok) {
    create = runHf(cli, ['repo', ...createArgs], writeToken!)
  }
  if (!create.ok && !/exists/i.test(create.stderr)) {
    fail(`Failed to create ${DEST_REPO}.\n\n${create.stderr.slice(0, 1500)}`)
  }

  console.log(`--- Uploading to ${DEST_REPO} ---`)
  const upload = runHf(
    cli,
    [
      'upload',
      DEST_REPO,
      WORK_DIR,
      '.',
      '--repo-type',
      'model',
      '--commit-message',
      `Mirror ${FILES.map((f) => f.name).join(' and ')} from ${SOURCE_REPO} (CC BY-NC 4.0)`,
    ],
    writeToken!,
  )
  if (!upload.ok) {
    fail(`Upload failed.\n\n${upload.stderr.slice(0, 1500)}`)
  }

  console.log('')
  console.log(`Done: https://huggingface.co/${DEST_REPO}`)
  console.log('Check that the model card renders and the licence shows CC BY-NC 4.0.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
