#!/usr/bin/env node
// inject-version.js
//
// Post-build step for the EdenMish storefront. Reads version metadata from
// the environment (preferred, set by CI) or falls back to git:
//   - APP_VERSION from scripts/current_version.sh (latest v* tag)
//   - APP_BUILD  from scripts/compute_build_number.sh
//   - APP_SHA    from `git rev-parse --short HEAD`
//
// For every public/*.html it:
//   1. Adds/updates <meta name="app-version" content="X.Y.Z+#bn (sha)"> in <head>.
//   2. Versions shared presentation assets so browsers cannot mix releases.
//   3. Injects a small footer stamp right after the credits line.
//
// Wired into package.json: `npm run build` runs tailwind then this script.
// No-op safe — if the storefront has no HTML yet, exits cleanly.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const STOREFRONT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(STOREFRONT_ROOT, '..');
const PUBLIC_DIR = path.join(STOREFRONT_ROOT, 'public');
const PLACEHOLDER = '<!--vstamp-->';

function run(script, args = []) {
  try {
    return execSync([script, ...args].join(' '), { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readCurrentVersion() {
  const fromScript = run('./scripts/current_version.sh');
  if (fromScript && fromScript !== '0.0.0' && fromScript !== '0.0.0-dev') return fromScript;
  try {
    return require(path.join(STOREFRONT_ROOT, 'package.json')).version || '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

function readBuildNumber() {
  return run('./scripts/compute_build_number.sh') || '0';
}

function readGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const VERSION = process.env.APP_VERSION || readCurrentVersion();
const BUILD = process.env.APP_BUILD || readBuildNumber();
const SHA = process.env.APP_SHA || readGitSha();
const STAMP = `v${VERSION}(${BUILD})`;
const ASSET_VERSION = encodeURIComponent(`${VERSION}-${BUILD}-${SHA}`);

if (!fs.existsSync(PUBLIC_DIR)) {
  console.log('inject-version: no public/ yet, skipping');
  process.exit(0);
}

const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
let touched = 0;

for (const file of htmlFiles) {
  const full = path.join(PUBLIC_DIR, file);
  let html = fs.readFileSync(full, 'utf8');
  const before = html;

  // 1. <meta name="app-version"> — add or replace.
  const metaRegex = /<meta\s+name="app-version"\s+content="[^"]*"\s*>/;
  const newMeta = `<meta name="app-version" content="${STAMP}">`;
  if (metaRegex.test(html)) {
    html = html.replace(metaRegex, newMeta);
  } else if (/<\/title>/.test(html)) {
    html = html.replace(/<\/title>/, `</title>\n${newMeta}`);
  }

  // 2. Cache-bust shared runtime assets on every build. They must move with the
  // HTML release so browsers cannot retain stale customer-facing behavior.
  html = html.replace(
    /href="\/assets\/styles\.css(?:\?v=[^"]*)?"/g,
    `href="/assets/styles.css?v=${ASSET_VERSION}"`,
  );
  html = html.replace(
    /src="\/assets\/mobile-nav\.js(?:\?v=[^"]*)?"/g,
    `src="/assets/mobile-nav.js?v=${ASSET_VERSION}"`,
  );
  html = html.replace(
    /src="\/assets\/analytics\.js(?:\?v=[^"]*)?"/g,
    `src="/assets/analytics.js?v=${ASSET_VERSION}"`,
  );

  // 3. Footer stamp.
  const stampHtml = `<span class="vstamp" style="font-family:ui-monospace,monospace;font-size:11px;opacity:.55;direction:ltr">${STAMP}</span>`;
  const stampRegex = /<span class="vstamp"[^>]*>[^<]*<\/span>/;
  if (stampRegex.test(html)) {
    // Update an existing stamp in place so re-runs refresh the version.
    html = html.replace(stampRegex, stampHtml);
  } else if (html.includes(PLACEHOLDER)) {
    html = html.replace(PLACEHOLDER, stampHtml);
  } else if (html.includes('פותח על ידי')) {
    // First-time inject: append after the credits <span>.
    html = html.replace(/(<span class="text-label-sm">פותח על ידי[\s\S]*?<\/span>)/, `$1\n${stampHtml}`);
  }

  if (html !== before) {
    fs.writeFileSync(full, html);
    touched++;
  }
}

console.log(`inject-version: ${STAMP} → ${touched}/${htmlFiles.length} files updated`);
