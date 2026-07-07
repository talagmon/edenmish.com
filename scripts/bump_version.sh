#!/usr/bin/env bash
# bump_version.sh
#
# Bumps the X.Y.Z version in the repo-root VERSION file based on
# Conventional Commits (https://www.conventionalcommits.org) since the
# last `v*` git tag. Writes the new version back to VERSION and optionally
# creates a `vX.Y.Z` tag.
#
# Bump rules:
#   - BREAKING CHANGE footer  OR  <type>!:` header  →  MAJOR
#   - feat:                                           →  MINOR
#   - fix:, perf:, refactor:, build:, ci:, docs:,...  →  PATCH
#   - chore:, test: only (no feat/fix)                →  no bump
#
# Usage:
#   scripts/bump_version.sh                # bump VERSION file in place
#   scripts/bump_version.sh --tag          # also create + push a v* tag
#   scripts/bump_version.sh --dry-run      # print what would happen, no writes
#
# Environment:
#   DRY_RUN=1    same as --dry-run
#
# This script is safe to run locally and idempotent (running twice with no
# new commits produces no change). CI invokes it from the release workflow
# (release.yml) on every push to main; CI commits VERSION back and pushes
# the tag.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

dry_run=0
do_tag=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --tag)     do_tag=1 ;;
    *) echo "usage: $0 [--dry-run] [--tag]" >&2; exit 1 ;;
  esac
done
if [[ "${DRY_RUN:-0}" == "1" ]]; then dry_run=1; fi

if [[ ! -f VERSION ]]; then
  echo "error: VERSION file not found at repo root" >&2
  exit 1
fi

current=$(tr -d '[:space:]' < VERSION)
if ! [[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: VERSION '$current' is not X.Y.Z" >&2
  exit 1
fi

IFS='.' read -r major minor patch <<< "$current"

# Find the last v* tag (e.g. v0.2.0). If none, scan all commits.
last_tag=$(git tag --list 'v*' --sort=-version:refname 2>/dev/null | head -n1 || true)

if [[ -n "$last_tag" ]]; then
  range="${last_tag}..HEAD"
else
  range="HEAD"
  echo "warn: no v* tag found; scanning all commits up to HEAD" >&2
fi

# Pull commit subjects + bodies since the last tag.
# Skip merge commits — they just enumerate their children.
commit_log=$(git log --no-merges --pretty=format:'%s%n%b%n---' "$range" 2>/dev/null || true)

bump="none"
if [[ -n "$commit_log" ]]; then
  if echo "$commit_log" | grep -Eq 'BREAKING[[:space:]]+CHANGE:|^[a-z]+(\([^)]+\))?!:'; then
    bump="major"
  elif echo "$commit_log" | grep -Eq '^feat(\([^)]+\))?:'; then
    bump="minor"
  elif echo "$commit_log" | grep -Eq '^(fix|perf|refactor|build|ci|docs|style)(\([^)]+\))?:'; then
    bump="patch"
  fi
fi

case "$bump" in
  major) major=$((major+1)); minor=0; patch=0 ;;
  minor) minor=$((minor+1)); patch=0 ;;
  patch) patch=$((patch+1)) ;;
  none)
    echo "no version-relevant commits since ${last_tag:-start}; VERSION stays $current"
    exit 0
    ;;
esac

new_version="${major}.${minor}.${patch}"
new_tag="v${new_version}"

if (( dry_run )); then
  echo "dry-run: would bump VERSION $current → $new_version (bump=$bump)"
  if (( do_tag )); then
    echo "dry-run: would create tag $new_tag"
  fi
  exit 0
fi

printf '%s\n' "$new_version" > VERSION
echo "bumped VERSION $current → $new_version (bump=$bump)"

if (( do_tag )); then
  git tag "$new_tag"
  echo "created tag $new_tag (not pushed — run: git push origin $new_tag)"
fi
