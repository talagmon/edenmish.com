import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { BOOKING_MAINTENANCE_CRON, cleanupDurableBookings } from '../src/whatsapp-booking-maintenance.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-11T12:00:00Z');
const databases = [];
afterEach(() => { while (databases.length) databases.pop().close(); });
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  databases.push(sqlite);
  const statements = [];
  const DB = {
    sqlite, statements,
    prepare(sql) {
      statements.push(sql);
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
      };
    },
    async batch(items) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of items) results.push(await item.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const hash = 'a'.repeat(64), start = NOW - 40 * DAY;
  sqlite.prepare(`INSERT INTO whatsapp_full_booking_budgets
    (environment,budget_id,binding_hash,cap_micros,retained_micros,created_at) VALUES('staging','maintenance-budget',?,2000000,1000000,?)`).run(hash, start);
  sqlite.prepare(`INSERT INTO whatsapp_full_booking_grants
    (id,environment,budget_id,binding_hash,root_binding,source_sha256,starts_at,expires_at,allocation_micros,
    inbound_limit,outbound_limit,address_limit,model_limit,created_at)
    VALUES('maintenance-grant','staging','maintenance-budget',?,?,?, ?,?,500000,8,8,2,1,?)`).run(hash, hash, hash, start, start + 3600000, start);
  sqlite.prepare(`INSERT INTO whatsapp_full_booking_operations
    (grant_id,kind,operation_key,reserved_micros,status,created_at)
    VALUES('maintenance-grant','model','synthetic-held-model',56320,'pending',?)`).run(start + 1);
  return DB;
}
function conversation(DB, id, { age = 3 * DAY, scope = 'fence', phase = 'collect', checkout = false, paid, scrubbed = false } = {}) {
  const at = NOW - age;
  const eventKey = id.padEnd(64, '0');
  DB.sqlite.prepare(`INSERT INTO whatsapp_booking_conversations
    (id,sender_key,provider,recipient,state_json,phase,order_token,checkout_started_at,created_at,updated_at)
    VALUES(?,?,'twilio',?,?,?,?,?,?,?)`).run(id, 'sender-hmac-' + id, scrubbed ? null : '+15550000000',
    scrubbed ? '{"phase":"handoff","data":{}}' : JSON.stringify({ phase, data: { name: 'SYNTHETIC PERSONAL NAME', pickup: 'SYNTHETIC ADDRESS' } }),
    phase, 'reserved-token-' + id, checkout ? at + 1 : null, at, at);
  if (paid !== undefined) DB.sqlite.prepare('INSERT INTO orders(token,created_at,payment_status,status) VALUES(?,?,?,?)')
    .run('reserved-token-' + id, at, paid ? 'paid' : 'unpaid', paid ? 'received' : 'cancelled');
  if (scope === 'fence') DB.sqlite.prepare(`INSERT INTO whatsapp_booking_full_fences
    (conversation_id,grant_id,latest_event_at,latest_event_key) VALUES(?,'maintenance-grant',?,?)`).run(id, at, eventKey);
  if (scope === 'ingress') DB.sqlite.prepare(`INSERT INTO whatsapp_booking_full_ingress
    (event_key,conversation_id,event_at,created_at,deadline_at) VALUES(?,?,?,?,?)`).run(eventKey, id, at, at, at + 30000);
  if (scope === 'job') job(DB, id, { id: eventKey, at, state: 'done' });
  return eventKey;
}
function job(DB, conversationId, { id = conversationId.padEnd(64, '0'), at = NOW - 30001, state = 'pending' } = {}) {
  DB.sqlite.prepare(`INSERT INTO whatsapp_booking_jobs
    (id,grant_id,conversation_id,event_at,created_at,deadline_at,payload_cipher,state)
    VALUES(?,'maintenance-grant',?,?,?,?,?,?)`).run(id, conversationId, at, at, at + 30000,
    ['pending', 'processing'].includes(state) ? 'synthetic-encrypted-payload' : null, state);
  return id;
}
function reply(DB, conversationId, age, { id = 'reply-' + conversationId, receiptAge, state = 'pending' } = {}) {
  const ref = 'provider-' + id;
  DB.sqlite.prepare(`INSERT INTO whatsapp_booking_replies(id,conversation_id,body,state,provider_ref,created_at)
    VALUES(?,?,'SYNTHETIC REPLY',?,?,?)`).run(id, conversationId, state, ref, NOW - age);
  if (receiptAge !== undefined) DB.sqlite.prepare(`INSERT INTO whatsapp_booking_receipts(provider_ref,rank,created_at)
    VALUES(?,1,?)`).run(ref, NOW - receiptAge);
  return id;
}
function get(DB, table, id) { return DB.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id); }
function holds(DB) {
  return ['budgets', 'grants', 'operations'].map(suffix => DB.sqlite.prepare(`SELECT * FROM whatsapp_full_booking_${suffix}`).all());
}
function noExternalEnv(DB) {
  return new Proxy({ DB }, { get(target, key) { if (key !== 'DB') throw Error('unexpected non-DB dependency'); return target.DB; } });
}

test('flags/key-free cleanup expires ciphertext but preserves financial reservations and fresh work', async t => {
  const DB = database();
  conversation(DB, 'expired', { age: 30001 });
  conversation(DB, 'fresh', { age: 100 });
  const expired = job(DB, 'expired'), fresh = job(DB, 'fresh', { at: NOW - 100 });
  const before = holds(DB);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('maintenance must not fetch'); });
  assert.deepEqual(await cleanupDurableBookings(noExternalEnv(DB), NOW), { status: 'ok', expiredJobs: 1 });
  assert.equal(get(DB, 'whatsapp_booking_jobs', expired).state, 'expired');
  assert.equal(get(DB, 'whatsapp_booking_jobs', expired).payload_cipher, null);
  assert.equal(get(DB, 'whatsapp_booking_conversations', 'expired').phase, 'handoff');
  assert.equal(get(DB, 'whatsapp_booking_jobs', fresh).payload_cipher, 'synthetic-encrypted-payload');
  assert.deepEqual(holds(DB), before);
  assert.deepEqual(await cleanupDurableBookings({ DB }, NOW), { status: 'ok', expiredJobs: 0 });
});

test('old job expiry cannot stop a newer event fence or purge its pending reply', async () => {
  const DB = database(); conversation(DB, 'newer', { age: 100 });
  const old = job(DB, 'newer', { id: '1'.repeat(64) });
  const currentReply = reply(DB, 'newer', 100);
  await cleanupDurableBookings({ DB }, NOW);
  assert.equal(get(DB, 'whatsapp_booking_jobs', old).state, 'expired');
  assert.equal(DB.sqlite.prepare('SELECT stopped_at FROM whatsapp_booking_full_fences').get().stopped_at, null);
  assert.equal(get(DB, 'whatsapp_booking_conversations', 'newer').phase, 'collect');
  assert.equal(get(DB, 'whatsapp_booking_replies', currentReply).state, 'pending');
});

test('24h/48h scrubs respect strict boundaries and every durable relationship after JSON identity is erased', async () => {
  const DB = database();
  for (const scope of ['fence', 'ingress', 'job']) {
    conversation(DB, scope, { scope }); reply(DB, scope, DAY + 1);
  }
  conversation(DB, 'edge', { age: 2 * DAY }); reply(DB, 'edge', DAY);
  conversation(DB, 'scrubbed', { scope: 'ingress', scrubbed: true }); reply(DB, 'scrubbed', DAY + 1);
  await cleanupDurableBookings({ DB }, NOW);
  for (const id of ['fence', 'ingress', 'job', 'scrubbed']) {
    const row = get(DB, 'whatsapp_booking_conversations', id);
    assert.equal(row.recipient, null); assert.deepEqual(JSON.parse(row.state_json).data, {});
    assert.equal(get(DB, 'whatsapp_booking_replies', 'reply-' + id).body, null);
    assert.equal(get(DB, 'whatsapp_booking_replies', 'reply-' + id).state, 'expired');
  }
  assert.equal(get(DB, 'whatsapp_booking_conversations', 'edge').recipient, '+15550000000');
  assert.equal(get(DB, 'whatsapp_booking_replies', 'reply-edge').body, 'SYNTHETIC REPLY');
});

test('legacy rows and unrelated receipts remain unchanged while full linked receipts precede reply deletion', async () => {
  const DB = database();
  conversation(DB, 'legacy', { age: 40 * DAY, scope: 'none' });
  reply(DB, 'legacy', 9 * DAY, { receiptAge: 9 * DAY });
  conversation(DB, 'full'); reply(DB, 'full', 9 * DAY, { receiptAge: 9 * DAY });
  reply(DB, 'full', 9 * DAY, { id: 'recent-receipt', receiptAge: DAY });
  DB.sqlite.prepare("INSERT INTO whatsapp_booking_receipts(provider_ref,rank,created_at) VALUES('unattributed',1,?)").run(NOW - 9 * DAY);
  for (const id of ['legacy', 'full']) DB.sqlite.prepare('INSERT INTO whatsapp_booking_events(event_key,conversation_id,outcome,created_at) VALUES(?,?,?,?)')
    .run('event-' + id, id, 'accepted', NOW - 9 * DAY);
  const legacy = get(DB, 'whatsapp_booking_conversations', 'legacy');
  await cleanupDurableBookings({ DB }, NOW);
  assert.deepEqual(get(DB, 'whatsapp_booking_conversations', 'legacy'), legacy);
  assert.equal(get(DB, 'whatsapp_booking_replies', 'reply-legacy').body, 'SYNTHETIC REPLY');
  assert.equal(get(DB, 'whatsapp_booking_replies', 'reply-full'), undefined);
  assert.ok(get(DB, 'whatsapp_booking_replies', 'recent-receipt'));
  assert.deepEqual(DB.sqlite.prepare('SELECT provider_ref FROM whatsapp_booking_receipts ORDER BY provider_ref').all().map(r => r.provider_ref),
    ['provider-recent-receipt', 'provider-reply-legacy', 'unattributed']);
  assert.deepEqual(DB.sqlite.prepare('SELECT event_key FROM whatsapp_booking_events').all().map(r => r.event_key), ['event-legacy']);
});

test('30d eligible deletion cascades transient metadata with FK enforcement and retains all budget evidence', async () => {
  const DB = database();
  for (const id of ['ordinary', 'paid']) {
    const key = conversation(DB, id, { age: 31 * DAY, checkout: id === 'paid', paid: id === 'paid' ? true : undefined });
    job(DB, id, { at: NOW - 31 * DAY, state: 'done' });
    DB.sqlite.prepare('INSERT INTO whatsapp_booking_full_ingress VALUES(?,?,?,?,?)').run(key, id, NOW - 31 * DAY, NOW - 31 * DAY, NOW - 31 * DAY + 30000);
  }
  const before = holds(DB), orders = DB.sqlite.prepare('SELECT * FROM orders').all();
  await cleanupDurableBookings({ DB }, NOW);
  for (const table of ['conversations', 'jobs', 'full_ingress', 'full_fences']) assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) n FROM whatsapp_booking_${table}`).get().n, 0);
  assert.deepEqual(holds(DB), before); assert.deepEqual(DB.sqlite.prepare('SELECT * FROM orders').all(), orders);
  assert.deepEqual(DB.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('uncertain checkout, missing order and cancelled unpaid order retain idempotency tombstones without PII', async () => {
  const DB = database();
  for (const id of ['missing', 'unpaid']) {
    conversation(DB, id, { age: 31 * DAY, checkout: true, paid: id === 'unpaid' ? false : undefined });
    job(DB, id, { at: NOW - 31 * DAY, state: 'uncertain' });
  }
  await cleanupDurableBookings({ DB }, NOW);
  for (const id of ['missing', 'unpaid']) {
    const row = get(DB, 'whatsapp_booking_conversations', id);
    assert.equal(row.order_token, 'reserved-token-' + id); assert.equal(row.sender_key, 'sender-hmac-' + id);
    assert.ok(row.checkout_started_at); assert.equal(row.recipient, null); assert.deepEqual(JSON.parse(row.state_json).data, {});
    assert.equal(get(DB, 'whatsapp_booking_jobs', id.padEnd(64, '0')).payload_cipher, null);
  }
});

test('recent active job or receipt blocks deletion of an otherwise old eligible conversation', async () => {
  const DB = database();
  conversation(DB, 'active', { age: 31 * DAY }); job(DB, 'active', { at: NOW - 1 });
  conversation(DB, 'receipt', { age: 31 * DAY }); reply(DB, 'receipt', 31 * DAY, { receiptAge: DAY });
  await cleanupDurableBookings({ DB }, NOW);
  assert.ok(get(DB, 'whatsapp_booking_conversations', 'active'));
  assert.ok(get(DB, 'whatsapp_booking_conversations', 'receipt'));
});

test('retention progresses even if expiry read fails; public error contains no DB details', async () => {
  const DB = database(); conversation(DB, 'private');
  const prepare = DB.prepare.bind(DB);
  DB.prepare = sql => { if (/^SELECT \* FROM whatsapp_booking_jobs/.test(sql)) throw Error('SYNTHETIC PRIVATE DB ERROR'); return prepare(sql); };
  await assert.rejects(cleanupDurableBookings({ DB }, NOW), { message: 'booking_maintenance_failed' });
  assert.equal(get(DB, 'whatsapp_booking_conversations', 'private').recipient, null);
});

test('expiry progresses even if retention transaction fails; failure is not a successful purge', async () => {
  const DB = database(); conversation(DB, 'expired', { age: 30001 }); const id = job(DB, 'expired');
  const batch = DB.batch.bind(DB); let calls = 0;
  DB.batch = items => { calls++; if (items.length === 6) throw Error('SYNTHETIC PRIVATE DB ERROR'); return batch(items); };
  await assert.rejects(cleanupDurableBookings({ DB }, NOW), { message: 'booking_maintenance_failed' });
  assert.ok(calls >= 2); assert.equal(get(DB, 'whatsapp_booking_jobs', id).payload_cipher, null);
});

test('dedicated minute scheduler uses fresh time and only DB cleanup despite stale cron timestamp', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const DB = database(); conversation(DB, 'expired', { age: 30001 }); const id = job(DB, 'expired');
  DB.sqlite.prepare("INSERT INTO orders(token,status,retained_by_driver,retained_at,created_at) VALUES('held-order','failed','hold_for_redelivery',?,?)").run(NOW - 2 * DAY, NOW - 3 * DAY);
  const orders = DB.sqlite.prepare('SELECT * FROM orders').all();
  const logs = []; t.mock.method(console, 'info', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('cron must not fetch'); });
  const promises = [];
  assert.equal(BOOKING_MAINTENANCE_CRON, '* * * * *');
  await worker.scheduled({ cron: BOOKING_MAINTENANCE_CRON, scheduledTime: NOW - DAY }, noExternalEnv(DB), { waitUntil(p) { promises.push(p); } });
  await Promise.all(promises);
  assert.equal(promises.length, 1); assert.equal(get(DB, 'whatsapp_booking_jobs', id).state, 'expired');
  assert.deepEqual(DB.sqlite.prepare('SELECT * FROM orders').all(), orders);
  assert.deepEqual(logs, [['booking_maintenance_complete', 1]]);
  assert.ok(DB.statements.every(sql => !/delivery_notifications|driver_route|status_history|gps_pings|business_security|analytics|push_devices/.test(sql)));
});

test('scheduler failure emits only fixed diagnostic text and never private SQL error contents', async t => {
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
  const DB = { prepare() { throw Error('PRIVATE SQL / SYNTHETIC CONTACT'); } }, promises = [];
  await worker.scheduled({ cron: BOOKING_MAINTENANCE_CRON }, { DB }, { waitUntil(p) { promises.push(p); } });
  await Promise.all(promises); assert.deepEqual(logs, [['booking_maintenance_failed']]);
});

test('closed uncertain-checkout conversations lose contact/draft PII after 48h while preserving closed state', async () => {
  const DB = database();
  conversation(DB, 'closed', { age: 31 * DAY, phase: 'closed', checkout: true });
  await cleanupDurableBookings({ DB }, NOW);
  const row = get(DB, 'whatsapp_booking_conversations', 'closed');
  assert.equal(row.phase, 'closed'); assert.deepEqual(JSON.parse(row.state_json), { phase: 'closed', data: {} });
  assert.equal(row.recipient, null); assert.equal(row.order_token, 'reserved-token-closed');
  assert.equal(row.sender_key, 'sender-hmac-closed'); assert.ok(row.checkout_started_at);
});

test('newer event record keeps its old conversation attribution until the 8d event window expires', async () => {
  const DB = database(); conversation(DB, 'event-owner', { age: 40 * DAY });
  DB.sqlite.prepare('INSERT INTO whatsapp_booking_events(event_key,conversation_id,outcome,created_at) VALUES(?,?,?,?)')
    .run('fresh-event', 'event-owner', 'accepted', NOW - 7 * DAY);
  await cleanupDurableBookings({ DB }, NOW);
  assert.ok(get(DB, 'whatsapp_booking_conversations', 'event-owner'));
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_events').get().n, 1);
  await cleanupDurableBookings({ DB }, NOW + DAY + 1);
  assert.equal(get(DB, 'whatsapp_booking_conversations', 'event-owner'), undefined);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_events').get().n, 0);
});

test('1000-row scrub limit makes bounded progress and a second invocation finishes the backlog', async () => {
  const DB = database();
  DB.sqlite.exec('BEGIN');
  for (let i = 0; i < 1001; i++) conversation(DB, 'bounded-' + i, { checkout: true });
  DB.sqlite.exec('COMMIT');
  await cleanupDurableBookings({ DB }, NOW);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_conversations WHERE recipient IS NOT NULL').get().n, 1);
  await cleanupDurableBookings({ DB }, NOW);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_conversations WHERE recipient IS NOT NULL').get().n, 0);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_conversations').get().n, 1001);
});
