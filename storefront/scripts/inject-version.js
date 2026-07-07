#!/usr/bin/env node
// inject-version.js
//
// Post-build step for the EdenMish storefront. Reads version metadata from
// the environment (preferred, set by CI) or falls back to repo files +
// `git rev-parse --short HEAD` (for local `npm run build`).
//
// For every public/*.html it:
//   1. Adds/updates <meta name="app-version" content="X.Y.Z+#bn (sha)"> in <head>.
//   2. Injects a small footer stamp right after the credits line.
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

function readVersionFile() {
  const f = path.join(REPO_ROOT, 'VERSION');
  if (!fs.existsSync(f)) return null;
  const v = fs.readFileSync(f, 'utf8').trim();
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

function readBuildNumber() {
  try {
    return execSync('./scripts/compute_build_number.sh', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '0';
  }
}

function readGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const VERSION = process.env.APP_VERSION || readVersionFile() || '0.0.0-dev';
const BUILD = process.env.APP_BUILD || readBuildNumber();
const SHA = process.env.APP_SHA || readGitSha();
const STAMP = `v${VERSION} #${BUILD} (${SHA})`;

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

  // 2. Footer stamp.
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
