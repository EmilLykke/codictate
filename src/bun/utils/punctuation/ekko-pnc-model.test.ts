import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ekkoPncModelLoader } from './ekko-pnc-model'

// Only the failure paths: they are decided before ONNX Runtime loads, so no weights are
// needed. Loading the real weights is ekko-pnc-parity.manual.ts.

const folders: string[] = []

function folderWith(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), 'ekko-pnc-model-'))
  folders.push(folder)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(folder, name), content)
  }
  return folder
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})

describe('ekkoPncModelLoader', () => {
  test('rejects, naming the file, when the folder has no tokenizer.json', async () => {
    const folder = folderWith({ 'config.json': '{"id2label":{"0":"O"}}' })
    await expect(ekkoPncModelLoader(folder)()).rejects.toThrow(
      join(folder, 'tokenizer.json')
    )
  })

  test('rejects a config.json without id2label', async () => {
    const folder = folderWith({ 'tokenizer.json': '{}', 'config.json': '{}' })
    await expect(ekkoPncModelLoader(folder)()).rejects.toThrow(
      `invalid PnC config in ${folder}: no id2label`
    )
  })

  test('rejects an id2label key Python could not use as a label id', async () => {
    const folder = folderWith({
      'tokenizer.json': '{}',
      'config.json': '{"id2label":{"0":"O","x":","}}',
    })
    await expect(ekkoPncModelLoader(folder)()).rejects.toThrow(
      `invalid PnC config in ${folder}`
    )
  })
})
