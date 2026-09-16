export type PermissionType =
  'inputMonitoring' | 'microphone' | 'accessibility' | 'documents'

export interface PlatformProvider {
  /** Platform-specific user data directory (config files, downloaded models). */
  getDataDir(): string

  /** Absolute path for a temp file by name — uses the OS temp directory. */
  getTempPath(filename: string): string

  /** Fire-and-forget audio file playback. */
  playSound(filePath: string): void

  /** Open a URL in the default handler (browser, system settings, etc.). */
  openUrl(url: string): void

  /**
   * URL to open the OS permission settings pane for a given permission type.
   * Returns null if the platform has no equivalent (Linux, Windows).
   */
  getPermissionSettingsUrl(type: PermissionType): string | null

  /**
   * Absolute path the formatter model should live at (user app-data dir).
   * File is only present if the user has downloaded it; callers must
   * check `existsSync(path)` before use.
   */
  getFormatterModelPath(): string
}
