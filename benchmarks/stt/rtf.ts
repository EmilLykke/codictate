export function computeRtf(
  wallClockSec: number,
  audioDurationSec: number,
): number {
  if (audioDurationSec <= 0) return 0;
  return wallClockSec / audioDurationSec;
}
