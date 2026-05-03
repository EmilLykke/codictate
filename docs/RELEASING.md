# Releasing

## How it works

1. Run a release command locally (see below)
2. The script bumps the version, commits, and pushes a git tag
3. The tag triggers `.github/workflows/release.yml`, which:
   - Creates a draft GitHub Release (skipped if already exists)
   - Builds macOS and Windows in parallel (skips macOS if already uploaded)
   - Wraps the Windows bundle with Inno Setup so the `.exe` registers a normal uninstaller
   - Publishes the release once both builds are done

## Commands

```bash
bun run release:canary          # v0.0.34-canary.1, CI builds both platforms
bun run release:canary --local  # same, but build Mac locally + upload; CI only builds Windows
bun run release:stable          # v0.0.34, CI builds both platforms
bun run release:stable --local  # same, but build Mac locally + upload; CI only builds Windows
bun run release                 # both channels at the same version
```

`--local` is useful when you want faster Mac turnaround (no CI queue). The Mac and Windows artifacts always land in the same GitHub Release.

## Channels

| Channel | Tag format | GitHub Release |
|---------|-----------|----------------|
| Stable | `v0.0.34` | Regular release, shown as "Latest" |
| Canary | `v0.0.34-canary.1` | Pre-release, not shown as "Latest" |

`version.json` tracks `baseVersion` and `canaryBuild`. The release script updates it automatically.

## First-time CI setup

The CI workflow requires these secrets set in **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|-------|
| `MACOS_CERTIFICATE` | Base64-encoded Developer ID `.p12` — `base64 -i cert.p12` |
| `MACOS_CERTIFICATE_PWD` | Password for the `.p12` |
| `ELECTROBUN_DEVELOPER_ID` | `Developer ID Application: Your Name (TEAMID)` |
| `ELECTROBUN_TEAMID` | 10-character Apple Team ID (developer.apple.com → Membership) |
| `ELECTROBUN_APPLEID` | Apple ID email |
| `ELECTROBUN_APPLEIDPASS` | App-specific password from appleid.apple.com |

Windows builds require no secrets. CI installs Inno Setup with Chocolatey before packaging the Windows installer.

## Manual builds (no release)

To build without publishing, use the manual workflows in GitHub Actions:

- **Actions → Build macOS → Run workflow**
- **Actions → Build Windows → Run workflow**

Artifacts are uploaded as a zip to the workflow run — useful for testing before a real release.

Windows workflow artifacts include the Electrobun update/archive zip and an Inno Setup installer named like `stable-windows-x64-Codictate-Setup.exe`. The Inno installer is the user-facing download because it appears in Windows Installed apps and uninstalls cleanly.

## Re-running a failed build

If one platform fails after the tag is already pushed, re-run just the failed job from the Actions UI. The draft release stays open until the publish job succeeds.

If the release itself needs to be deleted, do it from GitHub before re-pushing the tag.
