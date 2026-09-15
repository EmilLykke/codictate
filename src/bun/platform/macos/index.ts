import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { PlatformProvider, PermissionType } from '../types'
import { FORMATTER_MODEL_PATH } from '../runtime'
import {
  requireBinary,
  resolveBinary,
  resolveBinaryAsync,
} from '../resolve-binary'

const PERMISSION_URLS: Record<PermissionType, string> = {
  inputMonitoring:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  microphone:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  documents:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
}

export class MacOSPlatformProvider implements PlatformProvider {
  getDataDir(): string {
    return join(homedir(), 'Library', 'Application Support', 'codictate')
  }

  getTempPath(filename: string): string {
    return join(tmpdir(), filename)
  }

  playSound(filePath: string): void {
    Bun.spawn(['afplay', filePath])
  }

  openUrl(url: string): void {
    Bun.spawn(['open', url])
  }

  getPermissionSettingsUrl(type: PermissionType): string | null {
    return PERMISSION_URLS[type] ?? null
  }

  isFormattingAvailable(): boolean {
    return resolveBinary(this.llamaBinaryCandidates()) !== null
  }

  private llamaBinaryCandidates(): string[] {
    return [
      join(import.meta.dir, '../native-helpers/llama-completion'),
      join(process.cwd(), 'vendors/llama/llama-completion'),
    ]
  }

  findKeyListenerBinary(): string {
    // Production: Bun bundle dir → ../native-helpers/
    // Dev: beside the compiled Swift source
    const candidates = [
      join(import.meta.dir, '../native-helpers/KeyListener'),
      join(import.meta.dir, '../../utils/keyboard/KeyListener'),
    ]
    return requireBinary(
      resolveBinary(candidates),
      'KeyListener not found. Run `bun run build:native` so src/bun/utils/keyboard/KeyListener exists, then rebuild.'
    )
  }

  async findMicRecorderBinary(): Promise<string> {
    const candidates = [
      join(import.meta.dir, '../native-helpers/MicRecorder'),
      join(import.meta.dir, '../../utils/audio/MicRecorder'),
    ]
    return requireBinary(
      await resolveBinaryAsync(candidates),
      'MicRecorder not found. Run `bun run build:native` so src/bun/utils/audio/MicRecorder exists, then rebuild.'
    )
  }

  findWindowHelperBinary(): string | null {
    const candidates = [
      join(import.meta.dir, '../native-helpers/CodictateWindowHelper'),
      join(process.cwd(), 'vendors/window-helper/CodictateWindowHelper'),
    ]
    return resolveBinary(candidates)
  }

  findObserverHelperBinary(): string | null {
    const candidates = [
      join(import.meta.dir, '../native-helpers/CodictateObserverHelper'),
      join(process.cwd(), 'vendors/observer/CodictateObserverHelper'),
    ]
    return resolveBinary(candidates)
  }

  async findLlamaBinary(): Promise<string> {
    return requireBinary(
      await resolveBinaryAsync(this.llamaBinaryCandidates()),
      'llama-completion not found. Run `bun scripts/pre-build.ts --llama-only` or `bun scripts/pre-build.ts`.'
    )
  }

  getFormatterModelPath(): string {
    return FORMATTER_MODEL_PATH
  }

  findParakeetHelperBinary(): string {
    const candidates = [
      join(import.meta.dir, '../native-helpers/CodictateParakeetHelper'),
      join(process.cwd(), 'vendors/parakeet/CodictateParakeetHelper'),
    ]
    return requireBinary(
      resolveBinary(candidates),
      'CodictateParakeetHelper not found. Run `scripts/pre-build.ts` to build it.'
    )
  }
}
