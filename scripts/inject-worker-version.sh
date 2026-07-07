#!/usr/bin/env bash
# inject-worker-version.sh
#
# Rewrites the APP_VERSION / BUILD_NUMBER / GIT_SHA constants in
# worker/src/version.js so the deployed Worker reports the current build.
#
# Inputs (env vars, all required):
#   APP_VERSION   X.Y.Z from repo-root VERSION file
#   BUILD_NUMBER  integer from scripts/compute_build_number.sh
#   GIT_SHA       short git SHA
#
# Used by .github/workflows/production-deploy.yml before `wrangler deploy`.
# Safe to re-run — always overwrites in place.

set -euo pipefail

: "${APP_VERSION:?APP_VERSION is required}"
: "${BUILD_NUMBER:?BUILD_NUMBER is required}"
: "${GIT_SHA:?GIT_SHA is required}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_root/worker/src/version.js"

if [[ ! -f "$target" ]]; then
  echo "error: $target not found" >&2
  exit 1
fi

# Replace the three export lines. Use a portable sed pattern that matches
# the leading export name so re-runs are idempotent.
sed -i.bak -E \
  -e "s|^export const APP_VERSION = .*|export const APP_VERSION = '${APP_VERSION}';|" \
  -e "s|^export const BUILD_NUMBER = .*|export const BUILD_NUMBER = '${BUILD_NUMBER}';|" \
  -e "s|^export const GIT_SHA = .*|export const GIT_SHA = '${GIT_SHA}';|" \
  "$target"
rm -f "${target}.bak"

echo "inject-worker-version: ${APP_VERSION} #${BUILD_NUMBER} (${GIT_SHA}) → $target"
