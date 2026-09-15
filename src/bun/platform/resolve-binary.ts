import { existsSync } from 'node:fs'

export type BinaryExists = (path: string) => boolean
export type AsyncBinaryExists = (path: string) => Promise<boolean>

/** Resolve the first existing candidate, preserving the caller's priority order. */
export function resolveBinary(
  candidates: readonly string[],
  exists: BinaryExists = existsSync
): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/** Async counterpart for callers that already use Bun's file API. */
export async function resolveBinaryAsync(
  candidates: readonly string[],
  exists: AsyncBinaryExists = async (path) => Bun.file(path).exists()
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return null
}

/** Keep each binary's established remediation while sharing resolution mechanics. */
export function requireBinary(
  resolved: string | null,
  remediation: string
): string {
  if (resolved !== null) return resolved
  throw new Error(remediation)
}
