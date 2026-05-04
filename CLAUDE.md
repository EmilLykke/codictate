# Codictate

Local-first voice dictation for macOS and Windows. Users press a global shortcut, speak, and transcribed text is pasted at the cursor — no cloud, no account.

Built with **Electrobun** (NOT Electron — never use Electron APIs or patterns), **Bun**, **React 19**, **Tailwind CSS v4**, and **Vite**.

@AGENTS.md

## Quick reference

| Command | Purpose |
|---------|---------|
| `bun run start` | Dev mode (macOS) |
| `bun run dev:hmr` | Dev with HMR (macOS) |
| `bun run start:windows` | Dev mode (Windows) |
| `bun run lint:fix` | ESLint fix |
| `bun run tsc` | Type-check both tsconfigs |

## Font sizing — important

The app uses **Iceland** (`font-sans`) as body text and **Iceberg** (`font-brand`) for branding. Both fonts render extremely small at standard sizes. Always use larger-than-typical font sizes when displaying text — the base body size is `23px` (see `src/mainview/index.css`). When adding new UI, follow this convention: sizes that look correct in other fonts will be too small here. Scale up.

## Key conventions

- **Electrobun imports**: main process uses `import { ... } from "electrobun/bun"`, browser context uses `import { ... } from "electrobun/view"`
- **Views**: loaded via `views://` URLs; must be registered in `electrobun.config.ts`
- **Platform code**: `src/bun/platform/` has `macos/`, `windows/`, and `linux/` subdirectories — platform-specific logic lives there
- **Shared types**: `src/shared/` contains types and constants used by both main process and frontend
- **Styling**: Tailwind v4 with custom theme tokens defined in `src/mainview/index.css` (`--color-codictate-*`, `--font-sans`, `--font-brand`)
- **Animation**: uses `motion` (Framer Motion) — already a dependency
- **Data fetching**: `@tanstack/react-query` is the data-fetching layer
- **App stays in tray**: `exitOnLastWindowClosed: false` — the app lives in the system tray
