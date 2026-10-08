import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BOOKING_SCHEMA_SQL, bookingSchemaState, ensureBookingSchema } from '../scripts/validate-booking-schema.mjs';
import { validateStagingConfig } from '../scripts/staging-safety.mjs';

const migration = readFileSync(new URL('../migrations/039_whatsapp_booking.sql', import.meta.url), 'utf8');
const staging = readFileSync(new URL('../wrangler.staging.toml', import.meta.url), 'utf8');
const production = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

test('039 applies once to wholly absent schema and validates every definition after application', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY)');
  let applied = 0; const query = async () => db.prepare(BOOKING_SCHEMA_SQL).get();
  const apply = async () => { applied++; db.exec(migration); };
  try {
    assert.equal(bookingSchemaState(await query()), 'absent');
    await assert.rejects(ensureBookingSchema({ query, apply }), /absent/); assert.equal(applied, 0);
    assert.equal(await ensureBookingSchema({ query, apply, allowApply: true }), 'applied');
    assert.equal(await ensureBookingSchema({ query, apply, allowApply: true }), 'ready'); assert.equal(applied, 1);
    db.exec('DROP INDEX whatsapp_booking_reply_provider');
    await assert.rejects(ensureBookingSchema({ query, apply, allowApply: true }), /partial/); assert.equal(applied, 1);
  } finally { db.close(); }
});

test('039 rejects interrupted ALTER-only migration, wrong default, weakened constraint and missing base', async () => {
  for (const sql of [
    "CREATE TABLE orders(id INTEGER PRIMARY KEY, source_channel TEXT NOT NULL DEFAULT 'website')",
    'CREATE TABLE orders(id INTEGER PRIMARY KEY);' + migration.replace("DEFAULT 'website'", "DEFAULT 'other'"),
    'CREATE TABLE orders(id INTEGER PRIMARY KEY);' + migration.replace('order_token TEXT NOT NULL UNIQUE', 'order_token TEXT NOT NULL'),
    '',
  ]) {
    const db = new DatabaseSync(':memory:'); db.exec(sql); let applied = false;
    try {
      await assert.rejects(ensureBookingSchema({ query: async () => db.prepare(BOOKING_SCHEMA_SQL).get(), apply: async () => { applied = true; }, allowApply: true }));
      assert.equal(applied, false);
    } finally { db.close(); }
  }
});

test('039 checks the post-migration schema and rejects malformed query output', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY)');
  try { await assert.rejects(ensureBookingSchema({ query: async () => db.prepare(BOOKING_SCHEMA_SQL).get(), apply: async () => {}, allowApply: true }), /complete schema/); }
  finally { db.close(); }
  for (const row of [null, {}, { orders_present: 1, source_columns: 'bad', objects: '[]' }]) assert.equal(bookingSchemaState(row), 'invalid');
  const current = new DatabaseSync(':memory:'); current.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  try { assert.equal(bookingSchemaState(current.prepare(BOOKING_SCHEMA_SQL).get()), 'ready'); } finally { current.close(); }
});

test('staging preflight refuses dispatch/channel activation, duplicate overrides and production D1', () => {
  const rendered = staging.replace('__STAGING_D1_DATABASE_ID__', '11111111-1111-1111-1111-111111111111');
  assert.deepEqual(validateStagingConfig(rendered, production), []);
  for (const altered of [
    rendered.replace('AUTO_DRIVER_DISPATCH = "off"', 'AUTO_DRIVER_DISPATCH = "on"'),
    rendered.replace('WHATSAPP_BOOKING_SEND_ENABLED = "off"', 'WHATSAPP_BOOKING_SEND_ENABLED = "on"'),
    rendered.replace('WHATSAPP_BOOKING_ENABLED = "off"', 'WHATSAPP_BOOKING_ENABLED = "on"'),
    rendered.replace('WHATSAPP_BOOKING_MODEL_ENABLED = "off"', 'WHATSAPP_BOOKING_MODEL_ENABLED = "on"'),
    rendered + '\nAUTO_DRIVER_DISPATCH = "on"',
    rendered + '\n[env.other.vars]\n',
    rendered.replace('AUTO_DRIVER_DISPATCH = "off"', '').replace('[ai]', '[ai]\nAUTO_DRIVER_DISPATCH = "off"'),
    rendered.replace('11111111-1111-1111-1111-111111111111', production.match(/database_id = "([^"]+)"/)[1]),
  ]) assert.ok(validateStagingConfig(altered, production).length);
});
