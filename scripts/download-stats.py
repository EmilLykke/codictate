#!/usr/bin/env python3
"""
Fetches Codictate GitHub release download stats and estimates installs and usage.

Usage:
    python3 scripts/download-stats.py
    python3 scripts/download-stats.py --json

Set GITHUB_TOKEN (or GH_TOKEN) to lift the 60 requests/hour anonymous rate limit.

What each asset kind measures (asset names are `{channel}-{os}-{arch}-{rest}`):

  installer    .dmg / -Setup.exe / -Setup.zip. One download per fresh install or
               reinstall. The release workflow curls every stable DMG once to hash
               it for the Homebrew cask; those fetches are subtracted.
  update.json  Fetched by the in-app updater from `releases/latest/download`, so
               hits land on whichever stable release was latest at the time. A
               running app checks 10 s after launch and every 4 hours
               (src/bun/index.ts), and twice per check while an update is pending,
               so this measures app uptime, not people.
  patch        Delta update from the previous version. One per install updated.
  .tar.zst     Full update bundle, downloaded when no patch fits. One per install
               updated (plus the rare patch that fails to apply).

So "patch + .tar.zst" in a release is the number of installs that updated to it,
and installer + updates is the number of installs that reached that version.
"""

import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

REPO = "EmilLykke/codictate"
API_URL = f"https://api.github.com/repos/{REPO}/releases?per_page=100"

ASSET_RE = re.compile(r"^(?P<channel>stable|canary)-(?P<os>macos|win|windows)-[a-z0-9]+-(?P<rest>.+)$")
PLATFORMS = {"macos": "macOS", "win": "Windows", "windows": "Windows"}

# The Homebrew cask job in .github/workflows/release.yml downloads the stable
# DMG once per stable release, starting with this one.
HOMEBREW_CI_FIRST_TAG = "v0.0.37"

# A continuously running app checks every 4 hours.
UPDATE_CHECKS_PER_DAY = 6


def fetch_releases():
    headers = {"User-Agent": "codictate-stats", "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    releases = []
    url = API_URL
    while url:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            releases.extend(json.load(resp))
            url = next_page_url(resp.headers.get("Link", ""))
    return [r for r in releases if not r["draft"]]


def next_page_url(link_header):
    match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
    return match.group(1) if match else None


def parse_version(tag):
    match = re.match(r"v(\d+)\.(\d+)\.(\d+)", tag)
    return tuple(int(n) for n in match.groups()) if match else (0, 0, 0)


def parse_time(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def classify_asset(name):
    """Returns (channel, platform, kind), or None for an asset outside the scheme.

    The channel comes from the asset name, not the release tag: early stable
    releases also carried the canary assets.
    """
    match = ASSET_RE.match(name)
    if not match:
        return None
    rest = match["rest"]
    if rest == "update.json":
        kind = "update_check"
    elif rest.endswith(".patch"):
        kind = "patch"
    elif rest.endswith(".tar.zst"):
        kind = "full_update"
    elif rest.endswith(".dmg") or "Setup" in rest:
        kind = "installer"
    else:
        kind = "other"
    return match["channel"], PLATFORMS[match["os"]], kind


def latest_windows(releases, now):
    """Maps each stable tag to the days it was the latest release.

    The updater only ever reads the latest stable release, so update.json,
    patch and .tar.zst hits on a release all fall inside this window.
    """
    stable = sorted(
        (r for r in releases if not r["prerelease"]),
        key=lambda r: parse_time(r["published_at"]),
    )
    windows = {}
    for i, release in enumerate(stable):
        start = parse_time(release["published_at"])
        end = parse_time(stable[i + 1]["published_at"]) if i + 1 < len(stable) else now
        windows[release["tag_name"]] = (end - start).total_seconds() / 86400
    return windows


def analyze(releases, now):
    windows = latest_windows(releases, now)
    first_ci_version = parse_version(HOMEBREW_CI_FIRST_TAG)

    # channel -> platform -> kind -> count
    totals = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    ci_dmg_fetches = 0
    per_release = []

    for release in releases:
        tag = release["tag_name"]
        counts = defaultdict(lambda: defaultdict(int))  # platform -> kind -> count (stable assets)

        for asset in release["assets"]:
            classified = classify_asset(asset["name"])
            if classified is None:
                continue
            channel, platform, kind = classified
            count = asset["download_count"]

            if (
                kind == "installer"
                and channel == "stable"
                and asset["name"].endswith(".dmg")
                and not release["prerelease"]
                and parse_version(tag) >= first_ci_version
                and count > 0
            ):
                count -= 1
                ci_dmg_fetches += 1

            totals[channel][platform][kind] += count
            if channel == "stable":
                counts[platform][kind] += count

        if release["prerelease"]:
            continue

        days_latest = windows[tag]
        row = {
            "tag": tag,
            "published_at": release["published_at"],
            "days_latest": round(days_latest, 2),
            "platforms": {},
        }
        for platform in ("macOS", "Windows"):
            c = counts[platform]
            updates = c["patch"] + c["full_update"]
            row["platforms"][platform] = {
                "installs": c["installer"],
                "updates": updates,
                "patch_updates": c["patch"],
                "reached": c["installer"] + updates,
                "update_checks": c["update_check"],
                "update_checks_per_day": round(c["update_check"] / days_latest, 1)
                if days_latest > 0
                else 0,
            }
        per_release.append(row)

    per_release.sort(key=lambda r: parse_time(r["published_at"]), reverse=True)
    return totals, per_release, ci_dmg_fetches


def summarize(totals, per_release, ci_dmg_fetches):
    installs = {
        channel: {p: totals[channel][p]["installer"] for p in ("macOS", "Windows")}
        for channel in ("stable", "canary")
    }
    latest = per_release[0]
    running = {
        p: round(latest["platforms"][p]["update_checks_per_day"] / UPDATE_CHECKS_PER_DAY, 1)
        for p in ("macOS", "Windows")
    }
    return {
        "installer_downloads": installs,
        "installer_downloads_total": sum(sum(v.values()) for v in installs.values()),
        "ci_dmg_fetches_excluded": ci_dmg_fetches,
        "latest_release": latest["tag"],
        "installs_on_latest": {p: latest["platforms"][p]["reached"] for p in ("macOS", "Windows")},
        "avg_running_apps_on_latest": running,
    }


def print_report(totals, per_release, summary):
    width = 78
    print("=" * width)
    print(f"  Codictate Download Stats  ({len(per_release)} stable releases)")
    print("=" * width)

    print("\nInstaller downloads (fresh installs and reinstalls):")
    for channel in ("stable", "canary"):
        for platform in ("macOS", "Windows"):
            print(f"  {platform:<8} {channel:<7} {summary['installer_downloads'][channel][platform]:>6}")
    print(f"  {'Total':<16} {summary['installer_downloads_total']:>6}")
    print(f"  ({summary['ci_dmg_fetches_excluded']} Homebrew CI DMG fetches excluded)")

    print("\nUpdates delivered (patch + full bundle), stable:")
    for platform in ("macOS", "Windows"):
        t = totals["stable"][platform]
        updates = t["patch"] + t["full_update"]
        share = f"{100 * t['patch'] / updates:.0f}% via patch" if updates else ""
        print(f"  {platform:<8} {updates:>6}  {share}")

    print("\nRecent stable releases:")
    print(
        f"  {'':<9} {'':>6}  {'macOS':^28}  {'Windows':^28}\n"
        f"  {'Tag':<9} {'Days':>6}  {'inst':>5} {'upd':>5} {'reach':>5} {'chk/d':>7}"
        f"  {'inst':>5} {'upd':>5} {'reach':>5} {'chk/d':>7}"
    )
    for r in per_release[:10]:
        cells = "  ".join(
            f"{p['installs']:>5} {p['updates']:>5} {p['reached']:>5} {p['update_checks_per_day']:>7}"
            for p in (r["platforms"]["macOS"], r["platforms"]["Windows"])
        )
        print(f"  {r['tag']:<9} {r['days_latest']:>6.1f}  {cells}")
    print("  inst = installer downloads, upd = installs updated to it,")
    print("  reach = inst + upd, chk/d = update.json hits per day while latest")

    latest = summary["latest_release"]
    print("\nEstimates:")
    print(f"  Installs ever (installer downloads)      ~{summary['installer_downloads_total']}  (upper bound: reinstalls count)")
    on_latest = summary["installs_on_latest"]
    print(f"  Installs that reached {latest:<9}         macOS {on_latest['macOS']}, Windows {on_latest['Windows']}")
    running = summary["avg_running_apps_on_latest"]
    print(
        f"  Avg apps running since {latest:<9}        macOS ~{running['macOS']}, Windows ~{running['Windows']}"
        f"  (chk/d / {UPDATE_CHECKS_PER_DAY}; launches inflate it)"
    )
    print("=" * width)


def main():
    as_json = "--json" in sys.argv

    releases = fetch_releases()
    now = datetime.now(timezone.utc)
    totals, per_release, ci_dmg_fetches = analyze(releases, now)
    summary = summarize(totals, per_release, ci_dmg_fetches)

    if as_json:
        print(
            json.dumps(
                {
                    "generated_at": now.isoformat(),
                    "summary": summary,
                    "totals": {
                        channel: {platform: dict(kinds) for platform, kinds in platforms.items()}
                        for channel, platforms in totals.items()
                    },
                    "per_release": per_release,
                },
                indent=2,
            )
        )
    else:
        print_report(totals, per_release, summary)


if __name__ == "__main__":
    main()
