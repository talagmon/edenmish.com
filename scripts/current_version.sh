#!/usr/bin/env bash
# current_version.sh
#
# Single source of truth for the current X.Y.Z release name.
# Derives it from the latest v* git tag (the git-native release marker).
#
# Why tags, not a VERSION file: tags cannot be blocked by branch protection,
# so the release bot only needs `contents: write` for tag pushes — never
# for branch pushes. This keeps main's history 100% human-authored and
# works regardless of how main's protection rules are configured.
#
# Output: X.Y.Z (e.g. 0.2.0). Prints 0.0.0 if no v* tag exists yet.
#
# Usage:
#   scripts/current_version.sh           # prints X.Y.Z
#   v=$(./scripts/current_version.sh)

set -euo pipefail

latest=$(git tag --list 'v*' --sort=-version:refname 2>/dev/null | head -n1 || true)

if [[ -z "$latest" ]]; then
  printf '%s\n' "0.0.0"
  exit 0
fi

# Strip the leading 'v'. Validate it's X.Y.Z; fall back to 0.0.0 if not.
ver="${latest#v}"
if [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s\n' "$ver"
else
  printf '%s\n' "0.0.0"
fi
