// Build-time version metadata.
//
// CI overwrites APP_VERSION / BUILD_NUMBER / GIT_SHA in this file via
// scripts/inject-worker-version.sh before `wrangler deploy`. Between
// local dev runs the defaults below keep `wrangler dev` working.
//
// Source of truth: latest v* git tag (scripts/current_version.sh) +
// scripts/compute_build_number.sh + git short SHA. See docs/CI_CD.md.

export const APP_VERSION = '0.0.0-dev';
export const BUILD_NUMBER = '0';
export const GIT_SHA = 'dev';

export const versionString = () => `v${APP_VERSION} #${BUILD_NUMBER} (${GIT_SHA})`;
