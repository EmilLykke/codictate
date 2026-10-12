/**
 * The running app's version, channel and bundle identifier.
 *
 * All three come from `Resources/version.json`, which Electrobun writes into every build,
 * dev included (`bun run start` runs `build/dev-*`), and which `Updater.getLocalInfo()`
 * reads. The `codictate` client reads the same file in the bundle it ships in, so both sides
 * derive the socket name from one value. Not imported by tests: `electrobun/bun` loads the
 * native layer.
 */

import { Updater } from 'electrobun/bun'
import type { AppIdentity } from './handlers'

/** What a source run with no readable `version.json` calls itself: the dev identifier. */
const FALLBACK_IDENTITY: AppIdentity = {
  version: '0.0.0',
  channel: 'dev',
  identifier: 'app.codictate.dev',
}

export async function resolveAppIdentity(): Promise<AppIdentity> {
  const info = await Updater.getLocalInfo()
  return {
    version: info.version || FALLBACK_IDENTITY.version,
    channel: info.channel || FALLBACK_IDENTITY.channel,
    identifier: info.identifier || FALLBACK_IDENTITY.identifier,
  }
}
