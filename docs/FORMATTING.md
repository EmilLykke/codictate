# Output Formatting

Codictate can reshape raw transcriptions into structured output before pasting — for example, turning spoken words into a properly formatted email. Two backends are available depending on your platform.

## Backends

### llama.cpp (Qwen) — macOS and Windows

Cross-platform. Uses the `llama-completion` binary from upstream llama.cpp with constrained JSON decoding (`--json-schema`).

Two model tiers, downloaded in-app:

| Tier | Model | Size |
|------|-------|------|
| Fast | Qwen2.5 3B Instruct Q4_K_M | ~2 GB |
| Quality | Qwen3 4B Q4_K_M | ~2.5 GB |

Models are stored in the app data directory (`~/Library/Application Support/codictate/models/` on macOS, `%LOCALAPPDATA%\codictate\models\` on Windows). GPU-accelerated via Metal (macOS) or Vulkan (Windows).

Qwen3 outputs a `<think>` reasoning block by default. The runner prepends `/no_think` to suppress it and get JSON output directly.

### Apple Intelligence — macOS 26+ only

Uses Apple's `FoundationModels` framework (`LanguageModelSession`) via a Swift helper process (`CodictateFormatterHelper`). No model download — runs on-device via Apple's XPC service. Requires Apple Intelligence to be enabled in System Settings.

Falls back to raw transcript if the binary is missing, the OS is older than macOS 26, or Apple Intelligence is disabled.

## Architecture

Before invoking either backend, the Bun process captures the frontmost application via `osascript`. This context is included in the prompt and drives **auto-select** — when enabled, Codictate switches automatically to email mode when a recognised mail client is in focus (Mail, Outlook, Spark, Superhuman, Mimestream, etc.).

## Settings

Stored in `~/Library/Application Support/codictate/main-config.json`.

| Setting | Key | Default |
|---------|-----|---------|
| Format mode | `formattingModeId` | `none` |
| Auto-select in mail apps | `formattingAutoSelectEnabled` | `false` |
| Greeting style | `formattingEmailGreetingStyle` | `auto` |
| Custom greeting | `formattingEmailCustomGreeting` | `""` |
| Closing style | `formattingEmailClosingStyle` | `auto` |
| Custom closing | `formattingEmailCustomClosing` | `""` |
| Include sender name | `formattingEmailIncludeSenderName` | `false` |
| User display name | `userDisplayName` | `""` |

