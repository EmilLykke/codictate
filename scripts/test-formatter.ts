// Smoke test: exercises the real apply-formatting → llama-runner → prompts
// path with a hand-built FormatterRequest. Validates wiring, not quality.
// Run: bun scripts/test-formatter.ts

import { applyFormatting } from '../src/bun/utils/formatting/apply-formatting'
import type { FormatterRequest } from '../src/bun/utils/formatting/resolve-formatting-request'

const baseRequest: Omit<FormatterRequest, 'modeId' | 'transcript'> = {
  formattingEnabled: true,
  formatterModelInstalled: true,
  transcriptionLanguage: 'auto',
  userDisplayName: '',
  emailIncludeSenderName: false,
  emailGreetingStyle: 'auto',
  emailClosingStyle: 'auto',
  emailCustomGreeting: '',
  emailCustomClosing: '',
  imessageTone: 'neutral',
  imessageAllowEmoji: false,
  imessageLightweight: false,
  slackTone: 'neutral',
  slackAllowEmoji: false,
  slackUseMarkdown: false,
  slackLightweight: false,
  documentTone: 'neutral',
  documentStructure: 'prose',
  documentLightweight: false,
  formatterModelTier: 'fast',
  s1Styling: 'semi-formal',
  s1Structure: 'prose',
  s1Context: 'general',
  focusedApp: null,
}

const cases: { label: string; request: FormatterRequest }[] = [
  {
    label: 'imessage — casual dictation',
    request: {
      ...baseRequest,
      modeId: 'imessage',
      transcript: 'hey can you pick up some milk on the way home also we need bread',
    },
  },
  {
    label: 'slack — status ping',
    request: {
      ...baseRequest,
      modeId: 'slack',
      transcript:
        "quick update the build finished it is deployed to staging let me know if you see any regressions",
    },
  },
  {
    label: 'email — short note',
    request: {
      ...baseRequest,
      modeId: 'email',
      transcript:
        'hi sarah just a quick note that the delivery should be here by friday let me know if you need anything changed thanks',
    },
  },
  {
    label: 'document — paragraph',
    request: {
      ...baseRequest,
      modeId: 'document',
      transcript:
        'the team agreed on the roadmap design leads on the ui pass engineering wraps the api review on friday',
    },
  },
]

for (const c of cases) {
  console.log('\n===', c.label, '===')
  const t0 = Date.now()
  const out = await applyFormatting(c.request)
  const elapsed = Date.now() - t0
  console.log(`(${elapsed}ms)`)
  console.log(out)
}
