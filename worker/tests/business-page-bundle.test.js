import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = mkdtempSync(join(tmpdir(), 'edenmish-worker-bundle-'));

after(() => rmSync(outputDir, { recursive: true, force: true }));

describe('bundled business dashboard', () => {
  test('does not leak Wrangler private helpers into the generated browser script', async () => {
    execFileSync(join(workerRoot, 'node_modules', '.bin', 'wrangler'), [
      'deploy', '--dry-run', '--outdir', outputDir,
    ], { cwd: workerRoot, stdio: 'pipe' });

    const bundlePath = join(outputDir, 'index.js');
    assert.ok(readFileSync(bundlePath, 'utf8').includes('businessAccountHtml'));
    const builtWorker = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
    const response = await builtWorker.default.fetch(
      new Request('https://find.edenmish.example/business'),
      { STOREFRONT_BASE: 'https://edenmish.example' },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'dashboard script should be present');
    assert.doesNotMatch(script, /\b__name\b/);
    assert.doesNotThrow(() => new Function(script));
  });
});
