#!/usr/bin/env bash
# compute_build_number.sh
#
# Single source of truth for the integer build number used by every
# EdenMish surface (Worker, Shopify theme, storefront). Mirrors the
# scheme proven out in zuzu-client/scripts/compute_build_number.sh.
#
# Strategy: minutes elapsed since BUILD_NUMBER_BASELINE_UTC (default
# 2026-01-01 00:00:00 UTC). This guarantees the number is:
#   - Strictly monotonic over wall-clock time, across branches, machines,
#     CI runners, squash-merges, rebases, and rewrites.
#   - Well within Int32 limits (~70 years of headroom from the baseline).
#
# Override mechanisms (in priority order):
#   1. BUILD_NUMBER             — explicit override (used by CI / hotfix).
#   2. BUILD_NUMBER_BASELINE_UTC — change the epoch baseline if needed.
#
# Usage:
#   scripts/compute_build_number.sh           # prints the number
#   BUILD_NUMBER=12345 scripts/compute_build_number.sh
#
# Notes:
#   - Two builds within the same minute would collide. CI rarely produces
#     more than one artifact per minute; if it does, set BUILD_NUMBER
#     explicitly (e.g. GITHUB_RUN_NUMBER).
#   - Reproducibility-from-SHA is intentionally NOT a goal. We only need
#     monotonicity, and monotonic time is simpler than tracking git history
#     across non-linear merges.

set -euo pipefail

# Allow explicit override (e.g. CI: BUILD_NUMBER=$GITHUB_RUN_NUMBER).
if [[ -n "${BUILD_NUMBER:-}" ]]; then
  printf '%s\n' "$BUILD_NUMBER"
  exit 0
fi

BASELINE="${BUILD_NUMBER_BASELINE_UTC:-2026-01-01 00:00:00}"

# macOS (BSD date) and Linux (GNU date) have different flag syntax.
if date -u -j -f "%Y-%m-%d %H:%M:%S" "$BASELINE" +%s >/dev/null 2>&1; then
  baseline_epoch=$(date -u -j -f "%Y-%m-%d %H:%M:%S" "$BASELINE" +%s)
else
  baseline_epoch=$(date -u -d "$BASELINE" +%s)
fi

now_epoch=$(date -u +%s)

if (( now_epoch <= baseline_epoch )); then
  echo "error: current time is at or before BUILD_NUMBER_BASELINE_UTC ($BASELINE)" >&2
  exit 1
fi

printf '%s\n' "$(( (now_epoch - baseline_epoch) / 60 ))"
