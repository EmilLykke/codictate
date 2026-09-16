import { requireRuntimeBinary } from '../../platform/binaries'

export const findMicRecorderBinary = async (): Promise<string> =>
  requireRuntimeBinary('microphone')
