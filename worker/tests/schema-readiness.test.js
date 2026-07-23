import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDriverSchemaSnapshot } from '../scripts/validate-driver-schema.mjs';

const ready = (overrides = {}) => ({
  migration_014_items: 10,
  migration_015_columns: 4,
  migration_016_items: 4,
  migration_017_items: 2,
  migration_019_items: 3,
  migration_023_items: 3,
  ...overrides,
});

test('accepts a remote schema with driver migrations 014 through 019', () => {
  assert.deepEqual(validateDriverSchemaSnapshot(ready()), []);
});

test('reports every incomplete driver migration without mutating D1', () => {
  assert.deepEqual(validateDriverSchemaSnapshot(ready({
    migration_014_items: 8,
    migration_015_columns: 1,
    migration_016_items: 2,
    migration_017_items: 1,
    migration_019_items: 1,
    migration_023_items: 1,
  })), [
    'migration_014_items: expected 10, received 8.',
    'migration_015_columns: expected 4, received 1.',
    'migration_016_items: expected 4, received 2.',
    'migration_017_items: expected 2, received 1.',
    'migration_019_items: expected 3, received 1.',
    'migration_023_items: expected 3, received 1.',
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
