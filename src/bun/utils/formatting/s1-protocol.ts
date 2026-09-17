export interface S1Controls {
  styling: 'casual' | 'semi-casual' | 'semi-formal' | 'formal'
  structure: 'prose' | 'lists'
  context: 'general' | 'email'
}

// This wording and the empty thinking block are part of S1-mini's training format.
export const S1_SYSTEM_PROMPT =
  'You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.'

export function buildS1Prompt(
  transcript: string,
  controls: S1Controls
): string {
  if (transcript.includes('<|') || transcript.includes('|>')) {
    throw new Error('Transcript contains model control-token delimiters')
  }
  return `<|im_start|>system\n${S1_SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n[Styling: ${controls.styling}] [Structure: ${controls.structure}] [Context: ${controls.context}]\n${transcript}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
}

/** The pinned completion CLI appends this marker only after generating EOS. */
export function parseS1Completion(stdout: string): string {
  const match = / \[end of text\]\s*$/.exec(stdout)
  if (!match) throw new Error('S1-mini did not finish its output')
  const result = stdout.slice(0, match.index).trim()
  if (/<\|[^>]+\|>|<\/?think>/.test(result)) {
    throw new Error('S1-mini returned unexpected control tokens')
  }
  return result
}

/** Bound prompts by UTF-8 bytes, preferring sentence boundaries over word boundaries. */
export function splitS1Transcript(transcript: string): string[] {
  const chunks: string[] = []
  let remaining = transcript.trim()
  while (remaining) {
    let bytes = 0
    let end = 0
    for (const char of remaining) {
      const size = new TextEncoder().encode(char).length
      if (bytes + size > 2400) break
      bytes += size
      end += char.length
    }
    if (end < remaining.length) {
      const prefix = remaining.slice(0, end)
      const boundaries = [...prefix.matchAll(/[.!?]\s+|\n+/g)]
      const last = boundaries[boundaries.length - 1]
      const word = prefix.lastIndexOf(' ')
      if (last && last.index > end / 2) end = last.index + last[0].length
      else if (word > end / 2) end = word
    }
    chunks.push(remaining.slice(0, end).trim())
    remaining = remaining.slice(end).trim()
  }
  return chunks
}
