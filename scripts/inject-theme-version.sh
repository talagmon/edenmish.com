#!/usr/bin/env bash
# inject-theme-version.sh
#
# Rewrites the app_version / app_build / app_sha Liquid assigns in
# theme/snippets/app-version.liquid so the pushed Shopify theme reports
# the current build.
#
# Inputs (env vars, all required):
#   APP_VERSION   X.Y.Z from repo-root VERSION file
#   BUILD_NUMBER  integer from scripts/compute_build_number.sh
#   GIT_SHA       short git SHA
#
# Used by .github/workflows/production-deploy.yml and shopify-preview.yml
# before `shopify theme push`. Safe to re-run.

set -euo pipefail

: "${APP_VERSION:?APP_VERSION is required}"
: "${BUILD_NUMBER:?BUILD_NUMBER is required}"
: "${GIT_SHA:?GIT_SHA is required}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_root/theme/snippets/app-version.liquid"

if [[ ! -f "$target" ]]; then
  echo "error: $target not found" >&2
  exit 1
fi

sed -i.bak -E \
  -e "s|^\{% assign app_version = .*|{% assign app_version = '${APP_VERSION}' %}|" \
  -e "s|^\{% assign app_build = .*|{% assign app_build = '${BUILD_NUMBER}' %}|" \
  -e "s|^\{% assign app_sha = .*|{% assign app_sha = '${GIT_SHA}' %}|" \
  "$target"
rm -f "${target}.bak"

echo "inject-theme-version: ${APP_VERSION} #${BUILD_NUMBER} (${GIT_SHA}) → $target"
