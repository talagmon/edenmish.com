import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import worker from '../src/index.js';
import { signBusinessBatchToken } from '../src/business-batch-approval.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const openDatabases = [];

afterEach(() => {
  while (openDatabases.length) openDatabases.pop().close();
});

function d1Database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  openDatabases.push(sqlite);
  const wrap = (statement) => {
    let values = [];
    return {
      bind(...bound) {
        values = bound;
        return this;
      },
      async first() {
        return statement.get(...values) || null;
      },
      async all() {
        return { results: statement.all(...values) };
      },
      async run() {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  };
  return {
    sqlite,
    prepare(sql) {
      return wrap(sqlite.prepare(sql));
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`https://find.edenmish.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.31',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function createBusinessSession(env, email = 'mapping-owner@example.com') {
  let response = await worker.fetch(
    post('/api/business/auth/request', { email }),
    env,
  );
  assert.equal(response.status, 200);
  const challenge = await response.json();
  response = await worker.fetch(
    post('/api/business/auth/verify', {
      challenge: challenge.challenge,
      code: challenge.test_code,
    }),
    env,
  );
  assert.equal(response.status, 200);
  return response.headers.get('Set-Cookie').split(';', 1)[0];
}

test('explicit batch approval persists the signed mapping for that business account', async () => {
  const DB = d1Database();
  const env = {
    DB,
    SESSION_SECRET: 'mapping-approval-test-secret',
    TEST_MODE: '1',
  };
  const cookie = await createBusinessSession(env);
  const account = DB.sqlite.prepare('SELECT id FROM business_accounts').get();
  const signature = 'b'.repeat(64);
  const rowToken = await signBusinessBatchToken(env, account.id, 'row', {
    external_id: 'ORD-1',
  });
  const pickupToken = await signBusinessBatchToken(env, account.id, 'pickup', {
    address: 'הרצל 1',
    city: 'תל אביב',
    service: 'standard',
    default_contents: 'מסמכים',
    smart_mapping: {
      mapping_signature: signature,
      mappings: [
        { field: 'external_id', column_index: 0, confidence: 98 },
        { field: 'recipient_name', column_index: 1, confidence: 96 },
      ],
    },
  });

  const response = await worker.fetch(
    post('/api/business/batches/approve', {
      row_tokens: [rowToken],
      pickup_token: pickupToken,
    }, { Cookie: cookie }),
    env,
  );

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mapping_saved, true);
  assert.equal(result.row_tokens.length, 1);
  assert.ok(result.pickup_token);
  const stored = DB.sqlite.prepare(
    `SELECT account_id, header_signature, mapping_json
     FROM business_batch_mappings`
  ).get();
  assert.equal(stored.account_id, account.id);
  assert.equal(stored.header_signature, signature);
  assert.deepEqual(JSON.parse(stored.mapping_json), [
    { field: 'external_id', column_index: 0, confidence: 98 },
    { field: 'recipient_name', column_index: 1, confidence: 96 },
  ]);
});

test('saved mapping management is authenticated, metadata-only and account-scoped', async () => {
  const DB = d1Database();
  const env = {
    DB,
    SESSION_SECRET: 'mapping-management-test-secret',
    TEST_MODE: '1',
  };
  const ownerCookie = await createBusinessSession(env, 'mapping-owner@example.com');
  const owner = DB.sqlite.prepare(
    `SELECT ba.id
     FROM business_accounts ba
     JOIN business_members bm ON bm.account_id = ba.id
     JOIN business_users bu ON bu.id = bm.user_id
     WHERE bu.email = ?`
  ).get('mapping-owner@example.com');
  const signature = 'c'.repeat(64);
  DB.sqlite.prepare(
    `INSERT INTO business_batch_mappings
      (account_id, header_signature, mapping_json, created_at, updated_at, last_used_at, use_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    owner.id,
    signature,
    JSON.stringify([
      { field: 'external_id', column_index: 0, confidence: 98 },
      { field: 'recipient_name', column_index: 1, confidence: 96 },
    ]),
    100,
    200,
    300,
    4,
  );
  const mappingId = DB.sqlite.prepare(
    'SELECT id FROM business_batch_mappings WHERE account_id = ?'
  ).get(owner.id).id;
  const otherCookie = await createBusinessSession(env, 'mapping-other@example.com');

  let response = await worker.fetch(
    new Request('https://find.edenmish.com/api/business/batch-mappings', {
      headers: { Cookie: ownerCookie },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual(listed, {
    mappings: [{
      id: mappingId,
      approved_at: 100,
      updated_at: 200,
      last_used_at: 300,
      use_count: 4,
      field_count: 2,
    }],
  });
  assert.equal(JSON.stringify(listed).includes(signature), false);
  assert.equal(JSON.stringify(listed).includes('mapping_json'), false);

  response = await worker.fetch(
    new Request(`https://find.edenmish.com/api/business/batch-mappings/${mappingId}`, {
      method: 'DELETE',
      headers: { Cookie: otherCookie },
    }),
    env,
  );
  assert.equal(response.status, 404);
  assert.equal(
    DB.sqlite.prepare('SELECT COUNT(*) AS count FROM business_batch_mappings').get().count,
    1,
  );

  response = await worker.fetch(
    new Request('https://find.edenmish.com/api/business/batch-mappings/0', {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    }),
    env,
  );
  assert.equal(response.status, 400);

  response = await worker.fetch(
    new Request(`https://find.edenmish.com/api/business/batch-mappings/${mappingId}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: mappingId });
  assert.equal(
    DB.sqlite.prepare('SELECT COUNT(*) AS count FROM business_batch_mappings').get().count,
    0,
  );
});
