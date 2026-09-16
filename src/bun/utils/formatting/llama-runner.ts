import { requireRuntimeBinary } from '../../platform/binaries'
// Spawns the vendored `llama-completion` binary with constrained JSON output.
// Drops in as the replacement for the Swift `CodictateFormatterHelper`.
//
// Standard llama.cpp (llama-completion binary) with --json-schema constrained decoding.

import { existsSync } from 'fs'
import { getFormatterModelConfig } from '../../platform/runtime'
import type { FormatterModelTier } from '../../../shared/types'
import { log } from '../logger'

export class FormatterModelNotInstalledError extends Error {
  readonly kind = 'model-not-installed' as const
  constructor(public readonly modelPath: string) {
    super(`Formatter model not installed at ${modelPath}`)
    this.name = 'FormatterModelNotInstalledError'
  }
}

export class FormatterBinaryNotFoundError extends Error {
  readonly kind = 'binary-not-found' as const
  constructor(message: string) {
    super(message)
    this.name = 'FormatterBinaryNotFoundError'
  }
}

export class FormatterRuntimeError extends Error {
  readonly kind = 'runtime-error' as const
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number | null
  ) {
    super(message)
    this.name = 'FormatterRuntimeError'
  }
}

export interface RunLlamaFormatterOptions {
  systemPrompt: string
  userPrompt: string
  schema: object
  modelTier: FormatterModelTier
  /** Max tokens to generate. Defaults to 512 (plenty for any formatting output). */
  maxTokens?: number
  /** Sampling temperature. Defaults to 0.1 for near-deterministic formatting output. */
  temperature?: number
  /** Log tag for correlating this run in logs. */
  debugTag?: string
}

/**
 * Spawns llama-completion with --json-schema constrained decoding. Resolves to the
 * parsed JSON object, or throws a typed error (model missing / binary missing /
 * runtime failure) so the caller can decide whether to fall back to raw text.
 */
export async function runLlamaFormatter<T extends object>(
  opts: RunLlamaFormatterOptions
): Promise<T> {
  const modelConfig = getFormatterModelConfig(opts.modelTier)

  let binary: string
  try {
    binary = await requireRuntimeBinary('llama')
  } catch (err) {
    throw new FormatterBinaryNotFoundError(String(err))
  }

  if (!existsSync(modelConfig.path)) {
    throw new FormatterModelNotInstalledError(modelConfig.path)
  }

  // Qwen3 outputs a <think>...</think> reasoning block before the answer.
  // Prepending /no_think to the user message disables this behaviour so we
  // get the JSON output directly without the thinking overhead.
  const userPrompt = modelConfig.noThink
    ? `/no_think\n\n${opts.userPrompt}`
    : opts.userPrompt

  // Notes on flags:
  //  --single-turn           one chat round then exit (conversation mode, not raw completion)
  //  --no-display-prompt     skip echoing the prompt back on stdout
  //  --json-schema <json>    constrained decoding (internally generates GBNF grammar)
  //  -ngl 99                 offload all layers to Metal/CUDA/Vulkan
  //  --no-warmup             skip the 200ms warm-up pass (we never reuse context)
  // Conversation mode (no -no-cnv) is required so the model's embedded chat
  // template is applied — instruct models hallucinate without it.
  const args = [
    '-m',
    modelConfig.path,
    '-sys',
    opts.systemPrompt,
    '-p',
    userPrompt,
    '--json-schema',
    JSON.stringify(opts.schema),
    '-n',
    String(opts.maxTokens ?? 512),
    '--temp',
    String(opts.temperature ?? 0.1),
    '-ngl',
    '99',
    '--no-display-prompt',
    '--no-warmup',
    '--single-turn',
  ]

  log('formatter', 'spawning llama-completion', {
    tag: opts.debugTag,
    binary,
    modelPath: modelConfig.path,
    maxTokens: opts.maxTokens ?? 512,
  })

  const proc = Bun.spawn([binary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode !== 0) {
    // Surface the tail of stderr in the message so debug logs are useful even
    // without stderr access (dyld errors, missing dylibs, model load failures).
    const stderrTail = stderrText.trim().split('\n').slice(-6).join(' | ')
    throw new FormatterRuntimeError(
      `llama-completion exited with code ${proc.exitCode}: ${stderrTail || '(no stderr)'}`,
      stderrText,
      proc.exitCode ?? null
    )
  }

  // llama-completion emits some runtime info before/after the generated text even with
  // --log-disable (e.g. EOS markers, tokens/sec footers). Extract the first
  // well-formed JSON object from stdout.
  const parsed = extractJsonObject(stdoutText)
  if (!parsed) {
    throw new FormatterRuntimeError(
      'llama-completion produced no parseable JSON object',
      stderrText,
      proc.exitCode ?? null
    )
  }
  return parsed as T
}

function extractJsonObject(text: string): object | null {
  const firstBrace = text.indexOf('{')
  if (firstBrace < 0) return null
  // Walk forward to the matching closing brace, respecting string literals.
  let depth = 0
  let inString = false
  let escape = false
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(firstBrace, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {
          return null
        }
      }
    }
  }
  return null
}
