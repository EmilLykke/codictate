import { log } from '../logger'
import { assembleEmail } from './assemble-email'
import {
  FormatterBinaryNotFoundError,
  FormatterModelNotInstalledError,
  runLlamaFormatter,
} from './llama-runner'
import {
  buildDocumentInstructions,
  buildDocumentUserPrompt,
  buildEmailInstructions,
  buildEmailUserPrompt,
  buildIMessageInstructions,
  buildIMessageUserPrompt,
  buildSlackInstructions,
  buildSlackUserPrompt,
} from './prompts'
import type { FormatterRequest } from './resolve-formatting-request'
import { getFormatterModelConfig } from '../../platform/runtime'
import { runS1Formatter } from './s1-runner'
import {
  documentSchema,
  emailSchema,
  imessageSchema,
  slackSchema,
  type FormattedDocument,
  type FormattedEmail,
  type FormattedIMessage,
  type FormattedSlack,
} from './schemas'

function normaliseLightweightChatText(text: string): string {
  return text
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

function capitaliseFirst(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return trimmed.replace(/^\p{Ll}/u, (char) => char.toLocaleUpperCase())
}

function normaliseLightweightEmailBody(text: string): string {
  return capitaliseFirst(normaliseLightweightChatText(text))
}

function applyDeterministicChatStyle(
  text: string,
  request: FormatterRequest
): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed

  if (request.modeId === 'imessage' && request.imessageTone === 'casual') {
    return trimmed.toLocaleLowerCase()
  }

  if (request.modeId === 'slack' && request.slackTone === 'casual') {
    return trimmed.toLocaleLowerCase()
  }

  if (request.modeId === 'document' && request.documentTone === 'casual') {
    return trimmed.toLocaleLowerCase()
  }

  return trimmed
}

function shouldUseLightFormatting(request: FormatterRequest): boolean {
  if (request.formatterModelTier === 's1-mini') return false
  if (!request.formatterModelInstalled) return true
  return (
    (request.modeId === 'imessage' && request.imessageLightweight) ||
    (request.modeId === 'slack' && request.slackLightweight) ||
    (request.modeId === 'document' && request.documentLightweight)
  )
}

function applyLightFormatting(request: FormatterRequest): string {
  switch (request.modeId) {
    case 'email': {
      const senderNameOverride = request.emailIncludeSenderName
        ? request.userDisplayName.trim()
        : ''
      return assembleEmail(
        {
          language:
            request.transcriptionLanguage === 'auto'
              ? ''
              : request.transcriptionLanguage.split('-')[0].toLowerCase(),
          greeting: '',
          body: normaliseLightweightEmailBody(request.transcript),
          closing: '',
        },
        {
          senderNameOverride,
          userDisplayName: request.userDisplayName.trim(),
          originalTranscript: request.transcript,
          transcriptionLanguage: request.transcriptionLanguage,
          greetingStyle: request.emailGreetingStyle,
          closingStyle: request.emailClosingStyle,
          customGreeting: request.emailCustomGreeting,
          customClosing: request.emailCustomClosing,
        }
      )
    }
    case 'imessage':
    case 'slack':
    case 'document': {
      return (
        applyDeterministicChatStyle(
          normaliseLightweightChatText(request.transcript),
          request
        ) || request.transcript
      )
    }
  }
}

async function runModelForMode(request: FormatterRequest): Promise<string> {
  switch (request.modeId) {
    case 'email': {
      const result = await runLlamaFormatter<FormattedEmail>({
        systemPrompt: buildEmailInstructions(request),
        userPrompt: buildEmailUserPrompt(request),
        schema: emailSchema,
        modelTier: request.formatterModelTier,
        debugTag: 'email',
      })
      // Sender is fully user-controlled: their display name when they opted
      // in, otherwise none. The model never gets to invent one.
      const senderNameOverride = request.emailIncludeSenderName
        ? request.userDisplayName.trim()
        : ''
      return assembleEmail(result, {
        senderNameOverride,
        userDisplayName: request.userDisplayName.trim(),
        originalTranscript: request.transcript,
        transcriptionLanguage: request.transcriptionLanguage,
        greetingStyle: request.emailGreetingStyle,
        closingStyle: request.emailClosingStyle,
        customGreeting: request.emailCustomGreeting,
        customClosing: request.emailCustomClosing,
      })
    }
    case 'imessage': {
      const result = await runLlamaFormatter<FormattedIMessage>({
        systemPrompt: buildIMessageInstructions(request),
        userPrompt: buildIMessageUserPrompt(request),
        schema: imessageSchema,
        modelTier: request.formatterModelTier,
        debugTag: 'imessage',
      })
      return result.message.trim()
    }
    case 'slack': {
      const result = await runLlamaFormatter<FormattedSlack>({
        systemPrompt: buildSlackInstructions(request),
        userPrompt: buildSlackUserPrompt(request),
        schema: slackSchema,
        modelTier: request.formatterModelTier,
        debugTag: 'slack',
      })
      return result.message.trim()
    }
    case 'document': {
      const result = await runLlamaFormatter<FormattedDocument>({
        systemPrompt: buildDocumentInstructions(request),
        userPrompt: buildDocumentUserPrompt(request),
        schema: documentSchema,
        modelTier: request.formatterModelTier,
        debugTag: 'document',
      })
      const title = result.title.trim()
      const body = result.body.trim()
      if (title && body) return `${title}\n\n${body}`
      return body || request.transcript
    }
  }
}

/**
 * Reformats `request.transcript` via the local llama.cpp formatter model.
 * Returns the formatted text on success, or the original transcript on any
 * failure (missing binary, missing model, runtime error, parse failure).
 */
export async function applyFormatting(
  request: FormatterRequest
): Promise<string> {
  if (!request.transcript.trim()) {
    return request.transcript
  }

  if (shouldUseLightFormatting(request)) {
    const lightweight = applyLightFormatting(request)
    log('formatter', 'using light formatting', {
      modeId: request.modeId,
      formatterModelInstalled: request.formatterModelInstalled,
      imessageLightweight: request.imessageLightweight,
      slackLightweight: request.slackLightweight,
      documentLightweight: request.documentLightweight,
    })
    return lightweight || request.transcript
  }

  try {
    log('formatter', 'invoking llama-cli', {
      modeId: request.modeId,
      focusedApp: request.focusedApp?.appName,
    })

    if (request.formatterModelTier === 's1-mini') {
      const formatted = await runS1Formatter({
        transcript: request.transcript,
        styling: request.s1Styling,
        structure: request.s1Structure,
        context: request.s1Context,
        modelPath: getFormatterModelConfig('s1-mini').path,
      })
      log('formatter', 'S1-mini cleanup complete', {
        originalLength: request.transcript.length,
        formattedLength: formatted.length,
      })
      // Empty is a valid S1-mini result for filler-only or noise-only input.
      return formatted
    }

    const rawOutput = await runModelForMode(request)
    const formatted = applyDeterministicChatStyle(rawOutput, request)
    if (!formatted) {
      log('formatter', 'empty output from model — using raw transcript')
      return request.transcript
    }
    log('formatter', 'formatting complete', {
      originalLength: request.transcript.length,
      formattedLength: formatted.length,
    })
    return formatted
  } catch (err) {
    if (err instanceof FormatterModelNotInstalledError) {
      log('formatter', 'model not installed — using raw transcript', {
        path: err.modelPath,
      })
    } else if (err instanceof FormatterBinaryNotFoundError) {
      log('formatter', 'llama-cli missing — using raw transcript', {
        error: err.message,
      })
    } else {
      log('formatter', 'llama-cli run failed — using raw transcript', {
        error: String(err),
      })
    }
    return request.transcript
  }
}
