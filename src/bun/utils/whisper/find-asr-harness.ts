import {
  DEFAULT_ASR_HARNESS,
  type AsrHarnessId,
} from '../../../shared/asr-harness'
import { requireRuntimeBinary } from '../../platform/binaries'

export async function findAsrHarnessBinary(
  harness: AsrHarnessId = DEFAULT_ASR_HARNESS
): Promise<string> {
  return requireRuntimeBinary(harness)
}
