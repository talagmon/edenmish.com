#!/usr/bin/env bash
# inject-worker-version.sh
#
# Rewrites the APP_VERSION / BUILD_NUMBER / GIT_SHA constants in
# worker/src/version.js so the deployed Worker reports the current build.
#
# Inputs (env vars):
#   APP_VERSION   X.Y.Z — derived from latest v* tag (current_version.sh) if unset
#   BUILD_NUMBER  integer from scripts/compute_build_number.sh — derived if unset
#   GIT_SHA       short git SHA — derived via git rev-parse if unset
#
# Used by .github/workflows/production-deploy.yml before `wrangler deploy`.
# Safe to re-run — always overwrites in place.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_root/worker/src/version.js"

if [[ ! -f "$target" ]]; then
  echo "error: $target not found" >&2
  exit 1
fi

# Derive any missing inputs.
APP_VERSION="${APP_VERSION:-$(chmod +x "$repo_root/scripts/current_version.sh" 2>/dev/null; "$repo_root/scripts/current_version.sh")}"
BUILD_NUMBER="${BUILD_NUMBER:-$(chmod +x "$repo_root/scripts/compute_build_number.sh" 2>/dev/null; "$repo_root/scripts/compute_build_number.sh")}"
GIT_SHA="${GIT_SHA:-$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo unknown)}"

# Replace the three export lines. Use a portable sed pattern that matches
# the leading export name so re-runs are idempotent.
sed -i.bak -E \
  -e "s|^export const APP_VERSION = .*|export const APP_VERSION = '${APP_VERSION}';|" \
  -e "s|^export const BUILD_NUMBER = .*|export const BUILD_NUMBER = '${BUILD_NUMBER}';|" \
  -e "s|^export const GIT_SHA = .*|export const GIT_SHA = '${GIT_SHA}';|" \
  "$target"
rm -f "${target}.bak"

echo "inject-worker-version: ${APP_VERSION} #${BUILD_NUMBER} (${GIT_SHA}) → $target"
