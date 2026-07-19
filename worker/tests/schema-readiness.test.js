import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDriverSchemaSnapshot } from '../scripts/validate-driver-schema.mjs';

const ready = (overrides = {}) => ({
  migration_014_items: 10,
  migration_015_columns: 4,
  migration_016_items: 4,
  ...overrides,
});

test('accepts a remote schema with driver migrations 014 through 016', () => {
  assert.deepEqual(validateDriverSchemaSnapshot(ready()), []);
});

test('reports every incomplete driver migration without mutating D1', () => {
  assert.deepEqual(validateDriverSchemaSnapshot(ready({
    migration_014_items: 8,
    migration_015_columns: 1,
    migration_016_items: 2,
  })), [
    'migration_014_items: expected 10, received 8.',
    'migration_015_columns: expected 4, received 1.',
    'migration_016_items: expected 4, received 2.',
  ]);
});

test('fails closed when the D1 result is missing or malformed', () => {
  assert.deepEqual(validateDriverSchemaSnapshot(null), [
    'D1 returned no driver-schema readiness row.',
  ]);
  assert.deepEqual(validateDriverSchemaSnapshot(ready({ migration_016_items: 'unknown' })), [
    'migration_016_items: expected 4, received unknown.',
  ]);
});
