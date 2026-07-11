import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import worker from '../src/index.js';

describe('staging Worker isolation', () => {
  test('health endpoint is database-independent and allows the staging storefront origin', async () => {
    const req = new Request('https://ops-staging.edenmish.com/health', {
      headers: { Origin: 'https://staging.edenmish.com' },
    });
    const res = await worker.fetch(req, { ALLOWED_ORIGINS: 'https://staging.edenmish.com' });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://staging.edenmish.com');
    assert.deepEqual(await res.json(), { ok: true, service: 'edenmish-worker' });
  });

  test('allows only HTTPS subdomains of configured Pages preview hosts', async () => {
    const env = { ALLOWED_ORIGINS: 'https://*.edenmish-staging.pages.dev' };
    const allowed = await worker.fetch(new Request('https://ops-staging.edenmish.com/health', {
      headers: { Origin: 'https://fix-auth.edenmish-staging.pages.dev' },
    }), env);
    const rejected = await worker.fetch(new Request('https://ops-staging.edenmish.com/health', {
      headers: { Origin: 'https://edenmish-staging.pages.dev.attacker.example' },
    }), env);

    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://fix-auth.edenmish-staging.pages.dev');
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  });

  test('staging config uses separate domains, D1 name, and required auth secrets', () => {
    const config = readFileSync(join(process.cwd(), 'wrangler.staging.toml'), 'utf8');
    assert.match(config, /find-staging\.edenmish\.com/);
    assert.match(config, /ops-staging\.edenmish\.com/);
    assert.match(config, /database_name = "edenmish-staging"/);
    assert.match(config, /required = \["OPS_PIN", "SESSION_SECRET"\]/);
    assert.ok(!config.includes('f2f51b54-0170-4594-a41c-7a6037c902aa'), 'must not bind the production D1 database');
  });
});
