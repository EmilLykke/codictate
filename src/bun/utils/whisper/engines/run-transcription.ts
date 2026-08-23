/**
 * The Speech Engine Adapter, dispatched.
 *
 * One call for both callers: the Dictation pipeline derives its Request from a Dictation
 * Plan, the benchmark builds one by hand, and neither picks an implementation. The
 * discriminant is the Request's own `engineId`, so there is no engine question left to ask
 * here and no settings read to make.
 */

import { PARAKEET_ENGINE_ID } from '../../../../shared/speech-models'
import { transcribeWithCrispasr } from './crispasr-engine'
import { transcribeWithParakeet } from './parakeet-engine'
import type { TranscriptionRequest, TranscriptionResult } from './transcription'

export async function runTranscription(
  request: TranscriptionRequest
): Promise<TranscriptionResult> {
  return request.engineId === PARAKEET_ENGINE_ID
    ? transcribeWithParakeet(request)
    : transcribeWithCrispasr(request)
}
