export type FormattingModeId = 'email' | 'imessage' | 'slack' | 'document'

export interface FormattingMode {
  id: FormattingModeId
  label: string
  tagline: string
  description: string
}

/**
 * Stable evaluation order at runtime. Whichever enabled mode's app-detector
 * matches first wins — order encodes preference in the rare case where a single
 * app could plausibly match more than one detector.
 */
export const FORMATTING_MODE_ORDER: readonly FormattingModeId[] = [
  'email',
  'imessage',
  'slack',
  'document',
] as const

export const FORMATTING_MODES: FormattingMode[] = [
  {
    id: 'email',
    label: 'Email',
    tagline: 'Clean email structure',
    description:
      'Adds greeting, body, and sign-off. Applies in Mail, Outlook, Spark, Superhuman.',
  },
  {
    id: 'imessage',
    label: 'Messages',
    tagline: 'Light cleanup or full polish',
    description:
      'Casual, human phrasing suited for texting. Applies in the Messages app.',
  },
  {
    id: 'slack',
    label: 'Slack',
    tagline: 'Light cleanup or richer formatting',
    description:
      'Tight paragraphs, optional markdown + emoji. Applies in the Slack app.',
  },
  {
    id: 'document',
    label: 'Document',
    tagline: 'Light cleanup or structured polish',
    description:
      'Clean written prose with proper paragraphing. Applies in Notes, Pages, Word.',
  },
]

const VALID_IDS = new Set<FormattingModeId>(FORMATTING_MODE_ORDER)

export function isValidFormattingModeId(
  value: unknown
): value is FormattingModeId {
  return typeof value === 'string' && VALID_IDS.has(value as FormattingModeId)
}

export function formattingModeLabel(id: FormattingModeId): string {
  return FORMATTING_MODES.find((m) => m.id === id)?.label ?? id
}

// ─── Per-mode behavior option types ────────────────────────────────────────

export type FormattingEmailGreetingStyle =
  'auto' | 'hi' | 'hello' | 'custom' | 'none'
export type FormattingEmailClosingStyle =
  'auto' | 'best-regards' | 'thanks' | 'kind-regards' | 'custom' | 'none'

export type FormattingImessageTone = 'casual' | 'neutral' | 'formal'

export type FormattingSlackTone = 'casual' | 'neutral' | 'professional'

export type FormattingDocumentTone = 'casual' | 'neutral' | 'formal'
export type FormattingDocumentStructure = 'prose' | 'bulleted'

const IMESSAGE_TONES = new Set<FormattingImessageTone>([
  'casual',
  'neutral',
  'formal',
])
export function isValidImessageTone(v: unknown): v is FormattingImessageTone {
  return (
    typeof v === 'string' && IMESSAGE_TONES.has(v as FormattingImessageTone)
  )
}

const SLACK_TONES = new Set<FormattingSlackTone>([
  'casual',
  'neutral',
  'professional',
])
export function isValidSlackTone(v: unknown): v is FormattingSlackTone {
  return typeof v === 'string' && SLACK_TONES.has(v as FormattingSlackTone)
}

const DOCUMENT_TONES = new Set<FormattingDocumentTone>([
  'casual',
  'neutral',
  'formal',
])
export function isValidDocumentTone(v: unknown): v is FormattingDocumentTone {
  return (
    typeof v === 'string' && DOCUMENT_TONES.has(v as FormattingDocumentTone)
  )
}

const DOCUMENT_STRUCTURES = new Set<FormattingDocumentStructure>([
  'prose',
  'bulleted',
])
export function isValidDocumentStructure(
  v: unknown
): v is FormattingDocumentStructure {
  return (
    typeof v === 'string' &&
    DOCUMENT_STRUCTURES.has(v as FormattingDocumentStructure)
  )
}

const EMAIL_GREETING_STYLES = new Set<FormattingEmailGreetingStyle>([
  'auto',
  'hi',
  'hello',
  'custom',
  'none',
])
export function isValidEmailGreetingStyle(
  v: unknown
): v is FormattingEmailGreetingStyle {
  return (
    typeof v === 'string' &&
    EMAIL_GREETING_STYLES.has(v as FormattingEmailGreetingStyle)
  )
}

const EMAIL_CLOSING_STYLES = new Set<FormattingEmailClosingStyle>([
  'auto',
  'best-regards',
  'thanks',
  'kind-regards',
  'custom',
  'none',
])
export function isValidEmailClosingStyle(
  v: unknown
): v is FormattingEmailClosingStyle {
  return (
    typeof v === 'string' &&
    EMAIL_CLOSING_STYLES.has(v as FormattingEmailClosingStyle)
  )
}

/** Overall writing vibe chosen during product onboarding → per-format tone defaults. */
export type OnboardingWritingStyle = 'casual' | 'natural' | 'formal'

export function formattingTonesFromOnboardingStyle(
  style: OnboardingWritingStyle
): {
  imessage: FormattingImessageTone
  slack: FormattingSlackTone
  document: FormattingDocumentTone
} {
  switch (style) {
    case 'casual':
      return { imessage: 'casual', slack: 'casual', document: 'casual' }
    case 'natural':
      return {
        imessage: 'neutral',
        slack: 'neutral',
        document: 'neutral',
      }
    case 'formal':
      return { imessage: 'formal', slack: 'professional', document: 'formal' }
  }
}
