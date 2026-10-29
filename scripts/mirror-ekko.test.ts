import { describe, expect, test } from 'bun:test'
import {
  MIRRORS,
  checkMirrorFile,
  hfEnv,
  selectMirrors,
  stagedUploadProblems,
  writeTokenFor,
} from './mirror-ekko'

const ekkoPnc = () => {
  const mirror = MIRRORS.find((m) => m.id === 'ekko-pnc')
  if (!mirror) throw new Error('ekko-pnc is not a Mirror')
  return mirror
}

describe('the ekko-pnc Mirror', () => {
  test('copies the runtime and licence files from the pinned revision, and not calibration.json', () => {
    const mirror = ekkoPnc()
    expect(mirror.sourceRepo).toBe('RyeAI/ekko-pnc')
    expect(mirror.sourceRevision).toBe('d3129544e4e0155093e192cac58a9e69a4dea1ff')
    expect(mirror.files.map((f) => f.path).sort()).toEqual(
      [
        'pnc.int8.onnx',
        'tokenizer.json',
        'tokenizer_config.json',
        'config.json',
        'NOTICE',
        'MODEL_LICENSE.md',
        'LICENSES/CC-BY-4.0.txt',
        'LICENSES/CC0-1.0.txt',
        'LICENSES/CORAL-LICENSE',
        'LICENSES/FTSPEECH-LICENSE.md',
      ].sort(),
    )
  })
})

describe('checking a downloaded file', () => {
  const onnx = () => {
    const file = ekkoPnc().files.find((f) => f.path === 'pnc.int8.onnx')
    if (!file) throw new Error('pnc.int8.onnx is not mirrored')
    return file
  }

  test('pnc.int8.onnx is pinned to the hash ekko-pnc publishes for its int8 runtime', () => {
    expect(onnx().sha256).toBe(
      '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527',
    )
    expect(onnx().bytes).toBe(22424741)
  })

  test('accepts the pinned bytes', () => {
    expect(
      checkMirrorFile(onnx(), {
        bytes: 22424741,
        sha256: '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527',
      }),
    ).toBeNull()
  })

  test('refuses a different sha256 and names both hashes', () => {
    const wrong = '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266528'
    const problem = checkMirrorFile(onnx(), { bytes: 22424741, sha256: wrong })
    expect(problem).toContain('pnc.int8.onnx')
    expect(problem).toContain(wrong)
    expect(problem).toContain(
      '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527',
    )
  })

  test('refuses a different size even when the hash is right', () => {
    const problem = checkMirrorFile(onnx(), {
      bytes: 22424740,
      sha256: '46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527',
    })
    expect(problem).toContain('22424740')
  })
})

describe('the staged upload', () => {
  const staged = [
    'README.md',
    'pnc.int8.onnx',
    'tokenizer.json',
    'tokenizer_config.json',
    'config.json',
    'NOTICE',
    'MODEL_LICENSE.md',
    'LICENSES/CC-BY-4.0.txt',
    'LICENSES/CC0-1.0.txt',
    'LICENSES/CORAL-LICENSE',
    'LICENSES/FTSPEECH-LICENSE.md',
  ]

  test('is accepted when it holds the mirrored files and the README', () => {
    expect(stagedUploadProblems(ekkoPnc(), staged)).toEqual([])
  })

  test('is refused when it holds a file the Mirror does not carry', () => {
    const problems = stagedUploadProblems(ekkoPnc(), [
      ...staged,
      'calibration.json',
      '.cache/huggingface/download/pnc.int8.onnx.metadata',
    ])
    expect(problems.join('\n')).toContain('calibration.json')
    expect(problems.join('\n')).toContain('.cache/huggingface')
  })

  test('is refused when a mirrored file is missing', () => {
    const problems = stagedUploadProblems(
      ekkoPnc(),
      staged.filter((p) => p !== 'LICENSES/CORAL-LICENSE'),
    )
    expect(problems.join('\n')).toContain('LICENSES/CORAL-LICENSE')
  })
})

describe('choosing what to mirror', () => {
  test('every Mirror runs by default', () => {
    expect(selectMirrors([]).map((m) => m.id)).toEqual(MIRRORS.map((m) => m.id))
  })

  test('--only picks one Mirror by id', () => {
    expect(selectMirrors(['--dry-run', '--only', 'ekko-pnc']).map((m) => m.id)).toEqual([
      'ekko-pnc',
    ])
  })

  test('--only with an unknown id stops and lists the known ones', () => {
    expect(() => selectMirrors(['--only', 'ekko-v9'])).toThrow(/ekko-v9.*ekko-pnc/s)
  })

  test('--only with no id stops', () => {
    expect(() => selectMirrors(['--only'])).toThrow(/--only/)
  })
})

describe('tokens', () => {
  const shell = {
    PATH: '/usr/bin',
    HF_TOKEN: 'hf_read_from_hviske',
    HF_WRITE_TOKEN: 'hf_write_secret',
  }

  test('a download from the ungated source carries no token at all', () => {
    const env = hfEnv(shell, null)
    expect(env.HF_TOKEN).toBeUndefined()
    expect(env.HF_WRITE_TOKEN).toBeUndefined()
    expect(Object.values(env)).not.toContain('hf_write_secret')
    expect(env.PATH).toBe('/usr/bin')
  })

  test('the upload hands the write token to the hf CLI as HF_TOKEN, through the environment', () => {
    const env = hfEnv(shell, 'hf_write_secret')
    expect(env.HF_TOKEN).toBe('hf_write_secret')
    expect(env.HF_WRITE_TOKEN).toBeUndefined()
  })

  test('a dry run needs no write token', () => {
    expect(writeTokenFor({}, { dryRun: true })).toBeNull()
  })

  test('a publish without HF_WRITE_TOKEN stops and says how to set it', () => {
    expect(() => writeTokenFor({ HF_WRITE_TOKEN: '  ' }, { dryRun: false })).toThrow(
      /HF_WRITE_TOKEN is not set/,
    )
  })

  test('a publish reads the write token from HF_WRITE_TOKEN only', () => {
    expect(
      writeTokenFor({ HF_WRITE_TOKEN: ' hf_write_secret\n' }, { dryRun: false }),
    ).toBe('hf_write_secret')
    expect(() => writeTokenFor({ HF_TOKEN: 'hf_read' }, { dryRun: false })).toThrow()
  })
})
