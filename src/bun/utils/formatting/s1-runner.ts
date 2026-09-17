import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireRuntimeBinary } from '../../platform/binaries'
import { superviseProcess } from '../whisper/engines/process-supervisor'
import {
  buildS1Prompt,
  parseS1Completion,
  splitS1Transcript,
  type S1Controls,
} from './s1-protocol'

export interface RunS1FormatterOptions extends S1Controls {
  transcript: string
  modelPath: string
}

export async function runS1Formatter(
  opts: RunS1FormatterOptions
): Promise<string> {
  if (!existsSync(opts.modelPath)) throw new Error('S1-mini is not installed')
  const binary = await requireRuntimeBinary('llama')
  const directory = await mkdtemp(join(tmpdir(), 'codictate-s1-'))
  const promptPath = join(directory, 'prompt.txt')
  try {
    const outputs: string[] = []
    for (const chunk of splitS1Transcript(opts.transcript)) {
      await writeFile(promptPath, buildS1Prompt(chunk, opts), { mode: 0o600 })
      const proc = Bun.spawn(
        [
          binary,
          '-m',
          opts.modelPath,
          // --file removes a trailing newline, breaking the trained assistant prefix.
          '-bf',
          promptPath,
          '--no-escape',
          '-no-cnv',
          '--temp',
          '0',
          '-n',
          '3072',
          '-c',
          '8192',
          '-ngl',
          '99',
          '--no-display-prompt',
          '--no-warmup',
          '--simple-io',
          '--color',
          'off',
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
      )
      const result = await superviseProcess(proc, {
        stdout: proc.stdout,
        stderr: proc.stderr,
      })
      if (result.status === 'timed_out') throw new Error('S1-mini timed out')
      if (result.exitCode !== 0 || !result.outputComplete) {
        throw new Error(`S1-mini failed (exit ${result.exitCode})`)
      }
      outputs.push(parseS1Completion(new TextDecoder().decode(result.stdout)))
    }
    return outputs.filter(Boolean).join('\n\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
