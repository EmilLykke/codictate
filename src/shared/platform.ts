export type PlatformRuntime = 'macos' | 'windows' | 'linux'

export interface PlatformCapabilities {
  platform: PlatformRuntime
  supportsMacPermissionFlow: boolean
  supportsStreamMode: boolean
  supportsFormatting: boolean
  supportsCorrectionObserver: boolean
  supportsNativeIndicator: boolean
}

export function platformDisplayName(platform: PlatformRuntime): string {
  switch (platform) {
    case 'macos':
      return 'macOS'
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
  }
}
