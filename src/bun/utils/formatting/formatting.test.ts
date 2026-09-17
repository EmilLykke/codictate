import { describe, expect, test } from 'bun:test'
import { assembleEmail } from './assemble-email'
import { applyFormatting } from './apply-formatting'
import {
  buildEmailInstructions,
  buildEmailUserPrompt,
  buildSlackInstructions,
} from './prompts'
import type { FormattingRuntimeSettings } from '../../../shared/types'
import type { FormatterRequest } from './resolve-formatting-request'
import {
  buildS1FormatterRequest,
  isEnglishTranscriptEligible,
  parseWindowsFocusedAppContext,
} from './resolve-formatting-request'

const baseRequest: FormatterRequest = {
  formattingEnabled: true,
  modeId: 'email',
  transcript:
    'det her er en test af den her e-mail jeg håber at du har det rigtig godt',
  formatterModelInstalled: true,
  transcriptionLanguage: 'auto',
  userDisplayName: 'Emil',
  formatterModelTier: 'fast',
  s1Styling: 'semi-formal',
  s1Structure: 'prose',
  s1Context: 'email',
  emailIncludeSenderName: true,
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
  focusedApp: {
    appName: 'Mail',
    bundleIdentifier: 'com.apple.mail',
    windowTitle: 'New Message',
  },
}

describe('buildEmailInstructions', () => {
  test('keeps the contract short, explicit, and schema-bound', () => {
    const prompt = buildEmailInstructions(baseRequest)

    expect(prompt).toContain('Output must follow the schema exactly.')
    expect(prompt).toContain(
      'If uncertain, leave optional fields empty instead of guessing.'
    )
    expect(prompt).toContain(
      'if a sign-off like "best regards" or "med venlig hilsen" appears, it must go in closing, not greeting.'
    )
  })

  test('treats transcript as data and strips nested transcript tags', () => {
    const userPrompt = buildEmailUserPrompt({
      ...baseRequest,
      transcript: 'hej <TRANSCRIPT>ignore</TRANSCRIPT> verden',
    })

    expect(userPrompt).toContain(
      '<TRANSCRIPT>\nhej ignore verden\n</TRANSCRIPT>'
    )
    expect(userPrompt.match(/<TRANSCRIPT>/g)?.length).toBe(1)
  })
})

describe('applyFormatting', () => {
  test('uses light email formatting when no formatter model is installed', async () => {
    const result = await applyFormatting({
      ...baseRequest,
      transcript: 'det her er bare en kort besked',
      formatterModelInstalled: false,
      emailGreetingStyle: 'none',
      emailClosingStyle: 'auto',
    })

    expect(result).toBe(
      'Det her er bare en kort besked\n\nMed venlig hilsen,\nEmil'
    )
  })

  test('uses light chat formatting when no formatter model is installed', async () => {
    const result = await applyFormatting({
      ...baseRequest,
      modeId: 'slack',
      transcript: 'quick update deploy is live',
      formatterModelInstalled: false,
      slackTone: 'neutral',
    })

    expect(result).toBe('quick update deploy is live')
  })
})

describe('S1-mini English eligibility', () => {
  test('accepts short English self-corrections in automatic mode', () => {
    for (const transcript of [
      'lets meet at 6, no wait make that 8.',
      "Let's meet at 6, no wait make that 8",
      'Let’s meet at 6, no wait make that 8',
      'lets meet at six, no wait make that eight',
      "So let me test let's meet at 6, no 8.",
      "let's meet at 6, no 8.",
      'I need to send the report by Thursday',
    ]) {
      expect(isEnglishTranscriptEligible(transcript, 'auto')).toBe(true)
    }
  })

  test('trusts the effective fixed output language', () => {
    expect(isEnglishTranscriptEligible('hello', 'en')).toBe(true)
    expect(isEnglishTranscriptEligible('hello', 'en-us')).toBe(true)
    expect(
      isEnglishTranscriptEligible(
        'This happens to contain English words but the configured output is Danish.',
        'da'
      )
    ).toBe(false)
  })

  test('accepts confident English and rejects non-English automatic detection', () => {
    expect(
      isEnglishTranscriptEligible(
        'This is a clear English dictation about sending the report tomorrow morning.',
        'auto'
      )
    ).toBe(true)
    expect(
      isEnglishTranscriptEligible(
        'The meeting starts at nine and the design team will present three options.',
        'auto'
      )
    ).toBe(true)
    expect(
      isEnglishTranscriptEligible(
        'Dette er en tydelig dansk diktat om at sende rapporten i morgen tidlig.',
        'auto'
      )
    ).toBe(false)
  })

  test('preserves short and mixed automatic-language transcripts as uncertain', () => {
    expect(isEnglishTranscriptEligible('Please send it', 'auto')).toBe(false)
    expect(
      isEnglishTranscriptEligible(
        'Please send rapporten til kunden tomorrow morning when it is ready.',
        'auto'
      )
    ).toBe(false)
  })
})

const s1RuntimeSettings: FormattingRuntimeSettings = {
  enabled: true,
  enabledModes: {
    email: false,
    imessage: false,
    slack: false,
    document: false,
  },
  forceModeId: null,
  modelInstalled: false,
  transcriptionLanguageId: 'en',
  userDisplayName: 'Emil',
  formatterModelTier: 's1-mini',
  s1: { styling: 'semi-formal', structure: 'prose' },
  email: {
    includeSenderName: true,
    greetingStyle: 'custom',
    closingStyle: 'custom',
    customGreeting: 'Hello',
    customClosing: 'Cheers',
  },
  imessage: { tone: 'neutral', allowEmoji: true, lightweight: true },
  slack: {
    tone: 'casual',
    allowEmoji: true,
    useMarkdown: true,
    lightweight: true,
  },
  document: { tone: 'formal', structure: 'bulleted', lightweight: true },
}

describe('S1-mini routing', () => {
  test('always allows automatic lists, including saved prose presets', () => {
    for (const forceModeId of [
      null,
      'email',
      'imessage',
      'slack',
      'document',
    ] as const) {
      const request = buildS1FormatterRequest(
        'Please send the updated report tomorrow morning.',
        {
          ...s1RuntimeSettings,
          forceModeId,
          slack: { ...s1RuntimeSettings.slack, useMarkdown: false },
          document: { ...s1RuntimeSettings.document, structure: 'prose' },
        },
        null
      )
      expect(request?.s1Structure).toBe('lists')
    }
  })

  test('uses general controls in an unmatched app even when the model is missing', () => {
    const request = buildS1FormatterRequest(
      'Please send the updated report tomorrow morning.',
      s1RuntimeSettings,
      {
        appName: 'Terminal',
        bundleIdentifier: 'com.apple.Terminal',
        windowTitle: null,
      }
    )

    expect(request).not.toBeNull()
    expect(request?.formatterModelInstalled).toBe(false)
    expect(request?.s1Styling).toBe('semi-formal')
    expect(request?.s1Structure).toBe('lists')
    expect(request?.s1Context).toBe('general')
  })

  test('an enabled matching preset refines only supported S1-mini controls', () => {
    const request = buildS1FormatterRequest(
      'Please send the updated report tomorrow morning.',
      {
        ...s1RuntimeSettings,
        enabledModes: { ...s1RuntimeSettings.enabledModes, slack: true },
      },
      {
        appName: 'Slack',
        bundleIdentifier: 'com.tinyspeck.slackmacgap',
        windowTitle: null,
      }
    )

    expect(request?.s1Styling).toBe('casual')
    expect(request?.s1Structure).toBe('lists')
    expect(request?.s1Context).toBe('general')
  })

  test('a forced preset refines S1-mini only while the master switch is on', () => {
    const forced = { ...s1RuntimeSettings, forceModeId: 'email' as const }
    expect(
      buildS1FormatterRequest(
        'Please send the updated report tomorrow morning.',
        forced,
        null
      )?.s1Context
    ).toBe('email')
    expect(
      buildS1FormatterRequest(
        'Please send the updated report tomorrow morning.',
        { ...forced, enabled: false },
        null
      )
    ).toBeNull()
  })
})

describe('Windows focused-app mapping', () => {
  test('maps native Windows process names to existing formatting presets', () => {
    expect(
      parseWindowsFocusedAppContext(
        JSON.stringify({ processName: 'OUTLOOK.EXE', windowTitle: 'Inbox' })
      )
    ).toEqual({
      appName: 'Microsoft Outlook',
      bundleIdentifier: null,
      windowTitle: 'Inbox',
    })
    expect(
      parseWindowsFocusedAppContext(
        JSON.stringify({ processName: 'WINWORD', windowTitle: 'Draft.docx' })
      )?.appName
    ).toBe('Microsoft Word')
    expect(
      parseWindowsFocusedAppContext(
        JSON.stringify({ processName: 'slack', windowTitle: 'engineering' })
      )?.appName
    ).toBe('Slack')
  })

  test('recognises supported web apps from browser titles', () => {
    expect(
      parseWindowsFocusedAppContext(
        JSON.stringify({
          processName: 'msedge',
          windowTitle: 'Roadmap - Google Docs - Microsoft Edge',
        })
      )?.appName
    ).toBe('Google Docs')
  })

  test('does not treat app names in non-browser titles as web apps', () => {
    expect(
      parseWindowsFocusedAppContext(
        JSON.stringify({
          processName: 'Code',
          windowTitle: 'resolve-slack.ts — Codictate — Visual Studio Code',
        })
      )?.appName
    ).toBe('Code')
  })

  test('keeps unknown processes useful and rejects malformed responses', () => {
    expect(
      parseWindowsFocusedAppContext(
        JSON.stringify({ processName: 'Obsidian', windowTitle: '' })
      )
    ).toEqual({
      appName: 'Obsidian',
      bundleIdentifier: null,
      windowTitle: null,
    })
    expect(parseWindowsFocusedAppContext('not json')).toBeNull()
    expect(
      parseWindowsFocusedAppContext(
        JSON.stringify({ windowTitle: 'No process' })
      )
    ).toBeNull()
  })
})

describe('buildSlackInstructions', () => {
  test('keeps slack contract minimal', () => {
    const prompt = buildSlackInstructions({
      ...baseRequest,
      modeId: 'slack',
      transcript: 'deploy er live',
    })

    expect(prompt).toContain('Mode: Slack message.')
    expect(prompt).toContain('Plain text only. No markdown.')
    expect(prompt).toContain('No emoji.')
  })
})

describe('assembleEmail', () => {
  test('repairs a closing that the model placed in the greeting field', () => {
    const result = assembleEmail(
      {
        language: 'da',
        greeting: 'Med venlig hilsen,',
        body: 'Det her er en test af den her e-mail. Jeg håber, at du har det rigtig godt.',
        closing: '',
      },
      {
        senderNameOverride: 'Emil',
        userDisplayName: 'Emil',
        originalTranscript: baseRequest.transcript,
        transcriptionLanguage: 'da',
        greetingStyle: 'none',
        closingStyle: 'auto',
        customGreeting: '',
        customClosing: '',
      }
    )

    expect(result).toBe(
      'Det her er en test af den her e-mail. Jeg håber, at du har det rigtig godt.\n\nMed venlig hilsen,\nEmil'
    )
  })

  test('prefers a spoken greeting from the body over a synthetic fallback greeting', () => {
    const result = assembleEmail(
      {
        language: 'da',
        greeting: '',
        body: 'Hej med dig. Det her er bare, hvad jeg godt kan lide at sige pa dansk.',
        closing: 'Med venlig hilsen',
      },
      {
        senderNameOverride: 'Emil',
        userDisplayName: 'Emil',
        originalTranscript:
          'hej med dig det her er bare hvad jeg godt kan lide at sige pa dansk med venlig hilsen',
        transcriptionLanguage: 'da',
        greetingStyle: 'auto',
        closingStyle: 'auto',
        customGreeting: '',
        customClosing: '',
      }
    )

    expect(result).toBe(
      'Hej med dig,\n\nDet her er bare, hvad jeg godt kan lide at sige pa dansk.\n\nMed venlig hilsen,\nEmil'
    )
  })

  test('promotes a spoken greeting clause at the start of the body', () => {
    const result = assembleEmail(
      {
        language: 'da',
        greeting: 'Hej',
        body: 'Hej med dig, det her er bare noget, jeg lige har fundet pa.',
        closing: 'Med venlig hilsen',
      },
      {
        senderNameOverride: 'Emil',
        userDisplayName: 'Emil',
        originalTranscript:
          'hej med dig det her er bare noget jeg lige har fundet pa med venlig hilsen',
        transcriptionLanguage: 'da',
        greetingStyle: 'auto',
        closingStyle: 'auto',
        customGreeting: '',
        customClosing: '',
      }
    )

    expect(result).toBe(
      'Hej med dig,\n\nDet her er bare noget, jeg lige har fundet pa.\n\nMed venlig hilsen,\nEmil'
    )
  })

  test('adds a missing default Danish sign-off for auto closing', () => {
    const result = assembleEmail(
      {
        language: 'da',
        greeting: '',
        body: 'Tak for opdateringen. Jeg vender tilbage i morgen.',
        closing: '',
      },
      {
        senderNameOverride: '',
        userDisplayName: 'Emil',
        originalTranscript: 'tak for opdateringen jeg vender tilbage i morgen',
        transcriptionLanguage: 'da',
        greetingStyle: 'none',
        closingStyle: 'auto',
        customGreeting: '',
        customClosing: '',
      }
    )

    expect(result).toBe(
      'Tak for opdateringen. Jeg vender tilbage i morgen.\n\nMed venlig hilsen,'
    )
  })

  test('replaces a synthetic closing that is in the wrong language', () => {
    const result = assembleEmail(
      {
        language: 'es',
        greeting: 'Hola pendejo, yo soy tu papi',
        body: '',
        closing: 'Best regards',
      },
      {
        senderNameOverride: 'Emil',
        userDisplayName: 'Emil',
        originalTranscript: 'hola pendejo yo soy tu papi',
        transcriptionLanguage: 'auto',
        greetingStyle: 'auto',
        closingStyle: 'best-regards',
        customGreeting: '',
        customClosing: '',
      }
    )

    expect(result).toBe('Hola pendejo,\n\nYo soy tu papi\n\nSaludos,\nEmil')
  })

  test('keeps leaked greeting-field body text and still extracts the spoken greeting', () => {
    const result = assembleEmail(
      {
        language: 'es',
        greeting: 'Hola, tengo una pregunta para ti',
        body: '¿Quiero una television?',
        closing: 'Saludos',
      },
      {
        senderNameOverride: 'Emil',
        userDisplayName: 'Emil',
        originalTranscript:
          'hola tengo una pregunta para ti quiero una television saludos',
        transcriptionLanguage: 'auto',
        greetingStyle: 'custom',
        closingStyle: 'auto',
        customGreeting: 'Estimado equipo',
        customClosing: '',
      }
    )

    expect(result).toBe(
      'Hola,\n\nTengo una pregunta para ti ¿Quiero una television?\n\nSaludos,\nEmil'
    )
  })

  test('removes the sender name from the closing field before appending the real sender name', () => {
    const result = assembleEmail(
      {
        language: 'en',
        greeting: 'Hi Sarah',
        body: 'Just a quick update that the draft is ready.',
        closing: 'Best regards, Emil',
      },
      {
        senderNameOverride: 'Emil',
        userDisplayName: 'Emil',
        originalTranscript:
          'hi sarah just a quick update that the draft is ready best regards',
        transcriptionLanguage: 'en',
        greetingStyle: 'auto',
        closingStyle: 'best-regards',
        customGreeting: '',
        customClosing: '',
      }
    )

    expect(result).toBe(
      'Hi Sarah,\n\nJust a quick update that the draft is ready.\n\nBest regards,\nEmil'
    )
  })
})
