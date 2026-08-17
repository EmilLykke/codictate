#!/usr/bin/env bash
#
# Upload built artifacts to a GitHub Release, resolving the release by id.
#
# WHY THIS EXISTS
# `gh release upload <tag>` resolves the release through
# `/repos/{owner}/{repo}/releases/tags/{tag}`, and that endpoint only matches
# *published* releases. Our release flow uploads into a draft (see release.yml:
# create-release makes a draft, both build jobs upload into it, publish un-drafts it
# at the end). A draft is not bound to a tag - GitHub gives it an `untagged-<hash>`
# slug - so the tag lookup 404s and gh reports the confusing "release not found"
# even though the release plainly exists.
#
# Older gh (2.88) hid this by falling back to listing releases and matching
# `tag_name`. Newer gh on the runners (2.97+) does not, which broke the v0.0.54
# release: the Windows build succeeded and then threw its binaries away twice
# because the upload could not find the draft.
#
# So resolve the id from the list endpoint, which does return drafts, and upload
# against the id. `gh release upload` is kept as a fallback so this script is never
# worse than the single command it replaces.
#
# Usage: upload-release-assets.sh <tag> <glob-prefix>
#   e.g. upload-release-assets.sh v0.0.54 artifacts/stable-
#
# Requires GH_TOKEN in the environment. GITHUB_REPOSITORY is used when set,
# otherwise pass REPO explicitly.

set -euo pipefail

TAG="${1:?usage: upload-release-assets.sh <tag> <glob-prefix>}"
PREFIX="${2:?usage: upload-release-assets.sh <tag> <glob-prefix>}"
REPO="${REPO:-${GITHUB_REPOSITORY:?REPO or GITHUB_REPOSITORY must be set}}"

shopt -s nullglob
files=("${PREFIX}"*)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  echo "No files matched ${PREFIX}* - nothing to upload." >&2
  exit 1
fi

echo "Found ${#files[@]} artifact(s) matching ${PREFIX}*"

# The list endpoint includes drafts; /releases/tags/<tag> does not.
release_id=$(
  gh api "repos/${REPO}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"${TAG}\") | .id" | head -1
)

if [ -z "${release_id}" ]; then
  echo "No release (draft or published) found with tag ${TAG} in ${REPO}." >&2
  echo "create-release should have made one before this job ran." >&2
  exit 1
fi

echo "Resolved tag ${TAG} to release id ${release_id}"

# Asset uploads go to uploads.github.com, not api.github.com, so the absolute URL
# is deliberate here.
upload_via_api() {
  local file="$1" name="$2" existing

  # Replicate `--clobber`: the API rejects a duplicate asset name outright.
  existing=$(
    gh api "repos/${REPO}/releases/${release_id}/assets?per_page=100" \
      --jq ".[] | select(.name == \"${name}\") | .id" | head -1
  )
  if [ -n "${existing}" ]; then
    echo "  replacing existing asset ${name}"
    gh api --method DELETE "repos/${REPO}/releases/assets/${existing}" >/dev/null
  fi

  gh api --method POST \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/${REPO}/releases/${release_id}/assets?name=${name}" \
    --input "${file}" >/dev/null
}

failed_via_api=false
for file in "${files[@]}"; do
  [ -f "${file}" ] || continue
  name=$(basename "${file}")
  if upload_via_api "${file}" "${name}"; then
    echo "  uploaded ${name}"
  else
    echo "  API upload failed for ${name}" >&2
    failed_via_api=true
    break
  fi
done

if [ "${failed_via_api}" = true ]; then
  echo "Falling back to 'gh release upload' for the whole set." >&2
  gh release upload "${TAG}" "${files[@]}" --clobber --repo "${REPO}"
fi

echo "Upload complete for ${TAG}"
