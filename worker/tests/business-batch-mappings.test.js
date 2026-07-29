import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import {
  deleteBusinessBatchMapping,
  findBusinessBatchMappings,
  listBusinessBatchMappings,
  markBusinessBatchMappingUsed,
  saveBusinessBatchMapping,
} from '../src/business-batch-mappings.js';

const migration = readFileSync(
  new URL('../migrations/034_business_batch_mappings.sql', import.meta.url),
  'utf8',
);

const databases = [];
afterEach(() => {
  while (databases.length) databases.pop().close();
});

function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE business_accounts (id INTEGER PRIMARY KEY);
    INSERT INTO business_accounts (id) VALUES (7), (8);
  `);
  sqlite.exec(migration);
  databases.push(sqlite);
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async all() {
          return { results: statement.all(...values) };
        },
        async run() {
          const result = statement.run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
}

const signature = 'a'.repeat(64);
const savedMapping = {
  mapping_signature: signature,
  mappings: [
    { field: 'external_id', column_index: 0, confidence: 98 },
    { field: 'recipient_name', column_index: 1, confidence: 96 },
  ],
};

describe('approved business batch mappings', () => {
  test('stores only an account-scoped header hash and canonical column indexes', async () => {
    const DB = testDatabase();
    await saveBusinessBatchMapping(DB, 7, savedMapping, 100);

    const found = await findBusinessBatchMappings(DB, 7, [signature]);
    assert.deepEqual(found.get(signature), {
      signature,
      mappings: savedMapping.mappings,
    });
    assert.equal((await findBusinessBatchMappings(DB, 8, [signature])).size, 0);

    const row = DB.sqlite.prepare(
      `SELECT account_id, header_signature, mapping_json, created_at,
              updated_at, last_used_at, use_count
       FROM business_batch_mappings`
    ).get();
    assert.equal(row.account_id, 7);
    assert.equal(row.header_signature, signature);
    assert.equal(row.mapping_json.includes('recipient_name'), true);
    assert.equal(row.mapping_json.includes('נועה'), false);
    assert.equal(row.created_at, 100);
    assert.equal(row.updated_at, 100);
    assert.equal(row.last_used_at, null);
    assert.equal(row.use_count, 0);
  });

  test('updates an approved mapping and records successful reuse', async () => {
    const DB = testDatabase();
    await saveBusinessBatchMapping(DB, 7, savedMapping, 100);
    await saveBusinessBatchMapping(DB, 7, {
      ...savedMapping,
      mappings: [{ field: 'external_id', column_index: 2, confidence: 91 }],
    }, 200);
    await markBusinessBatchMappingUsed(DB, 7, signature, 250);

    const row = DB.sqlite.prepare(
      `SELECT mapping_json, created_at, updated_at, last_used_at, use_count
       FROM business_batch_mappings`
    ).get();
    assert.deepEqual(JSON.parse(row.mapping_json), [
      { field: 'external_id', column_index: 2, confidence: 91 },
    ]);
    assert.equal(row.created_at, 100);
    assert.equal(row.updated_at, 200);
    assert.equal(row.last_used_at, 250);
    assert.equal(row.use_count, 1);
  });

  test('lists safe account metadata without exposing signatures or mapping JSON', async () => {
    const DB = testDatabase();
    await saveBusinessBatchMapping(DB, 7, savedMapping, 100);
    await markBusinessBatchMappingUsed(DB, 7, signature, 250);

    const mappings = await listBusinessBatchMappings(DB, 7);
    assert.deepEqual(mappings, [{
      id: 1,
      approved_at: 100,
      updated_at: 100,
      last_used_at: 250,
      use_count: 1,
      field_count: 2,
    }]);
    assert.equal(JSON.stringify(mappings).includes(signature), false);
    assert.equal(JSON.stringify(mappings).includes('recipient_name'), false);
    assert.deepEqual(await listBusinessBatchMappings(DB, 8), []);
  });

  test('deletes only an account-owned saved mapping', async () => {
    const DB = testDatabase();
    await saveBusinessBatchMapping(DB, 7, savedMapping, 100);
    const id = DB.sqlite.prepare(
      'SELECT id FROM business_batch_mappings WHERE account_id = 7'
    ).get().id;

    assert.equal(await deleteBusinessBatchMapping(DB, 8, id), false);
    assert.equal((await listBusinessBatchMappings(DB, 7)).length, 1);
    assert.equal(await deleteBusinessBatchMapping(DB, 7, id), true);
    assert.deepEqual(await listBusinessBatchMappings(DB, 7), []);
    await assert.rejects(
      () => deleteBusinessBatchMapping(DB, 7, 0),
      /invalid_batch_mapping_id/,
    );
  });

  test('rejects malformed signatures and mappings before writing', async () => {
    const DB = testDatabase();
    await assert.rejects(
      () => saveBusinessBatchMapping(DB, 7, {
        mapping_signature: 'raw customer header',
        mappings: savedMapping.mappings,
      }),
      /invalid_batch_mapping/,
    );
    await assert.rejects(
      () => saveBusinessBatchMapping(DB, 7, {
        mapping_signature: signature,
        mappings: [{ field: 'unsupported', column_index: 0, confidence: 99 }],
      }),
      /invalid_batch_mapping/,
    );
    assert.equal(
      DB.sqlite.prepare('SELECT COUNT(*) AS count FROM business_batch_mappings').get().count,
      0,
    );
  });

  test('bounds saved layouts per account while preserving another account', async () => {
    const DB = testDatabase();
    await saveBusinessBatchMapping(DB, 8, {
      ...savedMapping,
      mapping_signature: 'f'.repeat(64),
    }, 1);
    for (let index = 0; index < 22; index += 1) {
      await saveBusinessBatchMapping(DB, 7, {
        ...savedMapping,
        mapping_signature: index.toString(16).padStart(64, '0'),
      }, index + 10);
    }

    assert.equal(
      DB.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM business_batch_mappings WHERE account_id = 7'
      ).get().count,
      20,
    );
    assert.equal(
      DB.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM business_batch_mappings WHERE account_id = 8'
      ).get().count,
      1,
    );
  });
});
