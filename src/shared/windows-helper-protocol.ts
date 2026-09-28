export type WindowsHelperCommand =
  | { command: 'configure'; swallow: Record<string, unknown>[] }
  | { command: 'set_clipboard'; text: string }
  | { command: 'paste_text'; text: string }
  | { command: 'replace_text'; deleteText: string; text: string }
  | { command: 'check_permissions' }
  | { command: 'request_input_monitoring' }
  | { command: 'prompt_accessibility' }
  | { command: 'request_microphone' }
  /** Linux only: ask for the desktop's own key bindings (answered by `desktop_bindings`). */
  | { command: 'list_desktop_bindings' }
