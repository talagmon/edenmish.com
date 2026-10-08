import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { advanceBooking, newBooking, parseSchedule, QUOTE_TTL, SESSION_WINDOW } from '../src/whatsapp-booking.js';
import { processBookingEvent, splitBookingReply, extractBookingEvents, sendBookingReplies, pauseBooking, cleanupBookings } from '../src/whatsapp-booking-store.js';
import { verifyTwilioBookingSignature, readTwilioBookingEvent, sendTwilioBookingReply } from '../src/whatsapp-booking-twilio.js';
import { startDriverShift } from '../src/driver-dispatch.js';
import { makeSession } from '../src/integrations.js';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const phone = '+972541234567';
const SID = 'AC' + '1'.repeat(32);
const FROM = 'whatsapp:+15551234567';
const URL = 'https://find.edenmish.com/webhooks/twilio/booking';
const schema = readFileSync(new globalThis.URL('../schema.sql', import.meta.url), 'utf8');
const databases = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; while (databases.length) databases.pop().close(); });
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema); databases.push(sqlite);
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql); let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } };
  }, async batch(statements) { sqlite.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
}
const environment = (DB) => ({ DB, SESSION_SECRET: 'local-test-secret', WHATSAPP_BOOKING_STORAGE_READY: 'on', WHATSAPP_BOOKING_ENABLED: 'on', WHATSAPP_BOOKING_PRIVACY_APPROVED: 'on', WHATSAPP_BOOKING_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'local-test-auth', TWILIO_BOOKING_FROM: FROM, TWILIO_BOOKING_WEBHOOK_URL: URL, TWILIO_RECIPIENT_POLICY: 'allowlist', TWILIO_RECIPIENT_ALLOWLIST: phone });
const quote = { price: 50, review: false, currency: 'ILS', discount_amount: 0 };
const services = () => ({ quote: async () => quote, resolveAddress: async (text) => ({ address: text, city: text.split(', ')[1], lat: 32.08, lng: 34.78 }), order: async () => null, create: async () => { throw new Error('unexpected create'); } });
const details = ['קטן', 'דיזנגוף 10, תל אביב', 'ביאליק 2, רמת גן', '2026-10-11 11:00', 'Test Person', 'test@example.com', 'אין', 'אין', 'ספר'];
async function reviewed(svc = services()) {
  let state = newBooking();
  for (const text of ['מתחילים', ...details]) state = (await advanceBooking(state, text, svc, { phone, now: NOW })).state;
  assert.equal(state.phase, 'address_review');
  return (await advanceBooking(state, `כתובות ${state.revision}`, svc, { phone, now: NOW })).state;
}
function sign(form, url = URL, secret = 'local-test-auth') {
  let message = url; for (const key of [...form.keys()].sort()) message += key + form.get(key);
  return createHmac('sha1', secret).update(message).digest('base64');
}
function request(text, id = 'SM' + '2'.repeat(32), overrides = {}) {
  const form = new URLSearchParams({ AccountSid: SID, MessageSid: id, From: 'whatsapp:' + phone, To: FROM, Body: text, NumMedia: '0', ...overrides });
  return { form, req: new Request(URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(form) }, body: form.toString() }) };
}
function messageResource(id, at = NOW, overrides = {}) { return { sid: id, account_sid: SID, direction: 'inbound', from: 'whatsapp:' + phone, to: FROM, date_created: new Date(at).toUTCString(), ...overrides }; }

test('partial conversation, explicit privacy consent, address review and revision-bound quote', async () => {
  let state = newBooking();
  const welcome = await advanceBooking(state, 'I need delivery', services(), { phone, now: NOW });
  assert.equal(welcome.state.phase, 'consent'); assert.match(welcome.reply, /פרטיות/);
  state = await reviewed(); assert.equal(state.phase, 'review');
  const stale = await advanceBooking(state, 'אישור 0', services(), { phone, now: NOW }); assert.equal(stale.create, undefined);
  const confirmed = await advanceBooking(state, `אישור ${state.revision}`, services(), { phone, now: NOW });
  assert.equal(confirmed.create.expectedPrice, 50); assert.equal(confirmed.create.input.email, 'test@example.com');
  assert.equal(confirmed.create.input.use_wallet, undefined); assert.equal(confirmed.create.input.customer_type, 'private');
  assert.equal(confirmed.create.input.phone_delivery_link_opt_in, false);
});

test('edits invalidate quote; ambiguous and unsupported addresses cannot book', async () => {
  const state = await reviewed();
  const edit = await advanceBooking(state, 'גודל: בינוני', services(), { phone, now: NOW });
  assert.equal(edit.state.data.size, 'medium'); assert.ok(edit.state.revision > state.revision);
  const svc = services(); svc.resolveAddress = async () => ({ error: 'ambiguous_delivery_address' });
  const ambiguous = await advanceBooking(state, 'איסוף: משהו 1, תל אביב', svc, { phone, now: NOW });
  assert.match(ambiguous.reply, /בוודאות/); assert.equal(ambiguous.create, undefined);
  svc.resolveAddress = async () => ({ error: 'out_of_zone' });
  assert.equal((await advanceBooking(state, 'איסוף: משהו 1, חיפה', svc, { phone, now: NOW })).state.phase, 'handoff');
});

test('price changes and quote expiry require new confirmation', async () => {
  const state = await reviewed(); const svc = services(); svc.quote = async () => ({ ...quote, price: 65 });
  for (const [service, now] of [[svc, NOW], [services(), NOW + QUOTE_TTL]]) {
    const result = await advanceBooking(state, `אישור ${state.revision}`, service, { phone, now });
    assert.equal(result.create, undefined); assert.ok(result.state.revision > state.revision); assert.match(result.reply, /אישור חדש/);
  }
});

test('invalid/past schedules, card-like text and handoff fail closed', async () => {
  for (const date of ['2026-10-08 10:00', '2026-02-31 10:00', '2026-10-10 10:00', '2026-10-11 22:00', 'tomorrow']) assert.equal(parseSchedule(date, NOW), null);
  const state = await reviewed();
  const card = await advanceBooking(state, '4111 1111 1111 1111', services(), { phone, now: NOW }); assert.match(card.reply, /אין לשלוח/); assert.equal(JSON.stringify(card.state).includes('4111'), false);
  const handoff = await advanceBooking(state, 'נציג', services(), { phone, now: NOW });
  assert.equal((await advanceBooking(handoff.state, 'אישור 2', services(), { phone, now: NOW })).reply, null);
});

test('Twilio signature binds URL and all fields; duplicate parameters are rejected', async () => {
  const { form } = request('hello');
  assert.equal(await verifyTwilioBookingSignature(URL, form, sign(form), 'local-test-auth'), true);
  assert.equal(await verifyTwilioBookingSignature(URL + '?x=1', form, sign(form), 'local-test-auth'), false);
  form.set('Body', 'altered'); assert.equal(await verifyTwilioBookingSignature(URL, form, sign(request('hello').form), 'local-test-auth'), false);
  form.append('Body', 'duplicate'); assert.equal(await verifyTwilioBookingSignature(URL, form, sign(form), 'local-test-auth'), false);
});

test('Twilio verifies dedicated sender, account, inbound direction, allowlist and original timestamp', async () => {
  const env = environment(database()); const id = 'SM' + '2'.repeat(32);
  const resource = async () => Response.json(messageResource(id));
  assert.equal((await readTwilioBookingEvent(request('hello').req, env, resource, NOW)).event.at, NOW);
  assert.equal((await readTwilioBookingEvent(request('hello', id, { To: 'whatsapp:+972534058498' }).req, env, resource, NOW)).status, 400);
  assert.equal((await readTwilioBookingEvent(request('hello').req, { ...env, TWILIO_RECIPIENT_ALLOWLIST: '' }, resource, NOW)).status, 403);
  assert.equal((await readTwilioBookingEvent(request('hello').req, env, async () => Response.json(messageResource(id, NOW - SESSION_WINDOW)), NOW)).event, null);
  assert.equal((await readTwilioBookingEvent(request('hello').req, env, async () => Response.json(messageResource(id, NOW, { direction: 'outbound-api' })), NOW)).status, 400);
});

test('D1 duplicates, out-of-order events, manual echoes and operator pause', async () => {
  const env = environment(database()); const svc = services();
  const first = { id: 'one', at: NOW, phone, text: 'מתחילים' };
  await processBookingEvent(env, first, svc, NOW);
  assert.equal((await processBookingEvent(env, first, svc, NOW)).duplicate, true);
  await processBookingEvent(env, { ...first, id: 'old', at: NOW - 1000, text: 'נציג' }, svc, NOW);
  let row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); assert.equal(row.phase, 'collect');
  await processBookingEvent(env, { ...first, id: 'echo', at: NOW - 2000, echo: true }, svc, NOW);
  row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); assert.equal(row.phase, 'handoff');
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state = 'pending'").get().n, 0);
  assert.equal((await pauseBooking(env.DB, row.id, NOW)).status, 200);
});

test('simultaneous events serialize and expired uncertain lease pauses without creating', async () => {
  const env = environment(database()); const svc = services();
  await processBookingEvent(env, { id: 'one', at: NOW, phone, text: 'מתחילים' }, svc, NOW);
  const row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();
  env.DB.sqlite.prepare('UPDATE whatsapp_booking_conversations SET lock_id = ?, lock_at = ?').run('busy', NOW);
  assert.equal((await processBookingEvent(env, { id: 'two', at: NOW + 1000, phone, text: 'קטן' }, svc, NOW)).busy, true);
  assert.equal((await pauseBooking(env.DB, row.id, NOW)).status, 409);
  await processBookingEvent(env, { id: 'two', at: NOW + 1000, phone, text: 'קטן' }, svc, NOW + 180000);
  assert.equal(env.DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase, 'handoff');
});

test('checkout ambiguity never retries creation; durable token remains for reconciliation', async () => {
  const env = environment(database()); const svc = services(); let creates = 0;
  svc.create = async () => { creates++; throw new Error('provider accepted then timed out'); };
  await processBookingEvent(env, { id: 'start', at: NOW, phone, text: 'מתחילים' }, svc, NOW);
  const state = await reviewed();
  env.DB.sqlite.prepare('UPDATE whatsapp_booking_conversations SET phase = ?, state_json = ?').run(state.phase, JSON.stringify(state));
  await processBookingEvent(env, { id: 'confirm', at: NOW + 1000, phone, text: `אישור ${state.revision}` }, svc, NOW + 1000);
  await processBookingEvent(env, { id: 'retry', at: NOW + 2000, phone, text: `אישור ${state.revision}` }, svc, NOW + 2000);
  assert.equal(creates, 1); const row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); assert.equal(row.phase, 'handoff'); assert.equal(row.order_token.length, 22);
});

test('outbound sends require separate gate, allowlist and active service window; failures pause', async () => {
  const env = environment(database()); const svc = services(); let sends = 0;
  const fake = async () => { sends++; return Response.json({ sid: 'SM' + '3'.repeat(32) }); };
  await processBookingEvent(env, { id: 'one', at: NOW, phone, text: 'מתחילים' }, svc, NOW);
  await sendBookingReplies(env, fake, NOW); assert.equal(sends, 0);
  env.WHATSAPP_BOOKING_SEND_ENABLED = 'on'; await sendBookingReplies(env, fake, NOW); assert.equal(sends, 1);
  await sendBookingReplies(env, fake, NOW); assert.equal(sends, 1);
  await processBookingEvent(env, { id: 'two', at: NOW + 1000, phone, text: 'קטן' }, svc, NOW + 1000);
  await sendBookingReplies(env, fake, NOW + SESSION_WINDOW + 1000); assert.equal(sends, 1);
  await processBookingEvent(env, { id: 'three', at: NOW + 2000, phone, text: 'איסוף: דיזנגוף 10, תל אביב' }, svc, NOW + 2000);
  await sendBookingReplies(env, async () => { throw new Error('timeout'); }, NOW + 2000);
  assert.equal(env.DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase, 'handoff');
  await sendBookingReplies(env, fake, NOW + 2000); assert.equal(sends, 1);
});

test('retention erases structured PII and reply bodies, retains bounded dedup metadata', async () => {
  const env = environment(database());
  await processBookingEvent(env, { id: 'one', at: NOW, phone, text: 'מתחילים' }, services(), NOW);
  await cleanupBookings(env, NOW + 3 * SESSION_WINDOW);
  const row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); assert.equal(row.recipient, null); assert.equal(row.state_json, '{"phase":"handoff","data":{}}');
  assert.equal(env.DB.sqlite.prepare('SELECT body FROM whatsapp_booking_replies').get().body, null);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_events').get().n, 1);
});

test('Meta adapter ignores history, wrong number, media payload and expired events', () => {
  const m = { id: 'wamid.1', timestamp: String(NOW / 1000), from: phone.slice(1), type: 'text', text: { body: 'hello' } };
  const envelope = (field, id = 'phone') => ({ entry: [{ changes: [{ field, value: { metadata: { phone_number_id: id }, messages: [m] } }] }] });
  assert.equal(extractBookingEvents(envelope('messages'), 'phone', NOW).length, 1);
  assert.equal(extractBookingEvents(envelope('history'), 'phone', NOW).length, 0);
  assert.equal(extractBookingEvents(envelope('messages', 'other'), 'phone', NOW).length, 0);
  assert.equal(extractBookingEvents(envelope('messages'), 'phone', NOW + SESSION_WINDOW).length, 0);
});

function installNetworkFixtures(env, { chargeFails = false } = {}) {
  const messages = new Map(); const counts = { charges: 0, sends: 0, emails: 0 };
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url === 'https://api.sendgrid.com/v3/mail/send') { counts.emails++; return new Response(null, { status: 202 }); }
    if (/api.twilio.com.*\/Messages\/SM/.test(url)) return Response.json(messages.get(url.split('/').pop().slice(0, -5)));
    if (url.includes('places.googleapis.com/v1/places:searchText')) {
      const q = JSON.parse(options.body).textQuery; const parts = /^(.*?) (\d+), (.*?), ישראל$/.exec(q);
      return Response.json({ places: [{ formattedAddress: q, location: { latitude: 32.08, longitude: 34.78 }, addressComponents: [ { types: ['route'], longText: parts[1] }, { types: ['street_number'], longText: parts[2] }, { types: ['locality'], longText: parts[3] }, { types: ['country'], longText: 'ישראל' } ] }] });
    }
    if (url.includes('/graphql.json')) {
      const body = JSON.parse(options.body);
      if (body.query.includes('draftOrderCreate')) {
        counts.charges++; if (chargeFails) throw new Error('mock checkout timeout');
        return Response.json({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/123', legacyResourceId: '123', invoiceUrl: 'https://checkout.example/invoice/123' }, userErrors: [] } } });
      }
      throw new Error('Unexpected GraphQL operation');
    }
    if (url.endsWith('/Messages.json')) { counts.sends++; return Response.json({ sid: 'SM' + '9'.repeat(32) }); }
    throw new Error('Blocked unexpected network request: ' + url);
  };
  let index = 0;
  return { counts, async inbound(text) {
    index++; const id = 'SM' + index.toString(16).padStart(32, '0');
    messages.set(id, messageResource(id, NOW + index * 1000));
    const { req } = request(text, id); return { response: await worker.fetch(req, env), id };
  }, messages };
}
async function fullReview(env, net) {
  for (const text of ['hello', 'מתחילים', ...details]) assert.equal((await net.inbound(text)).response.status, 200);
  let row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();
  assert.equal(row.phase, 'address_review');
  await net.inbound(`כתובות ${JSON.parse(row.state_json).revision}`);
  row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); assert.equal(row.phase, 'review'); return row;
}

test('signed Twilio to canonical order, single invoice, mismatch rejected, paid reconciliation only', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW + 60_000 });
  const env = { ...environment(database()), GOOGLE_PLACES_SERVER_KEY: 'mock', SHOPIFY_SHOP: 'mock.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'mock', SHOPIFY_WEBHOOK_SECRET: 'webhook-mock', SENDGRID_API_KEY: 'mock', OPS_EMAIL: 'ops@example.com' };
  const net = installNetworkFixtures(env); const row = await fullReview(env, net); const state = JSON.parse(row.state_json);
  const confirmed = await net.inbound(`אישור ${state.revision}`); assert.equal(confirmed.response.status, 200);
  let order = env.DB.sqlite.prepare('SELECT * FROM orders').get(); assert.ok(order); assert.equal(order.source_channel, 'whatsapp'); assert.equal(order.customer_type, 'private'); assert.equal(order.email, 'test@example.com'); assert.equal(order.payment_status, 'link_sent'); assert.ok(order.otp_hash); assert.equal(net.counts.charges, 1); assert.equal(net.counts.sends, 0);
  assert.equal((await worker.fetch(request(`אישור ${state.revision}`, confirmed.id).req, env)).status, 200);
  await net.inbound('שילמתי'); await net.inbound(`אישור ${state.revision}`);
  assert.equal(net.counts.charges, 1); assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  async function paid(total, currency = 'ILS', id = 567) {
    const body = JSON.stringify({ id, draft_order_id: 123, note: `EdenMish token: ${order.token}`, total_price: String(total), currency, financial_status: 'paid' });
    return worker.fetch(new Request('https://find.edenmish.com/webhooks/shopify', { method: 'POST', headers: { 'X-Shopify-Hmac-SHA256': createHmac('sha256', env.SHOPIFY_WEBHOOK_SECRET).update(body).digest('base64'), 'X-Shopify-Topic': 'orders/paid' }, body }), env);
  }
  await paid(1); assert.notEqual(env.DB.sqlite.prepare('SELECT payment_status FROM orders').get().payment_status, 'paid');
  await paid(order.price, 'USD'); assert.notEqual(env.DB.sqlite.prepare('SELECT payment_status FROM orders').get().payment_status, 'paid');
  await paid(order.price); await paid(order.price);
  order = env.DB.sqlite.prepare('SELECT * FROM orders').get(); assert.equal(order.payment_status, 'paid'); assert.equal(order.picked_up_at, null); assert.equal(order.delivered_at, null);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM payments WHERE status = 'paid'").get().n, 1);
  assert.ok(net.counts.emails >= 2, 'canonical ops and paid customer email hooks ran');
  const ops = await worker.fetch(new Request('https://ops.edenmish.com/api/ops/orders', { headers: { 'X-Ops': await makeSession(env) } }), env);
  assert.equal((await ops.json()).orders[0].source_channel, 'whatsapp');
  await startDriverShift(env, { now: Date.parse('2026-10-11T08:00:00Z') });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM driver_route_stops WHERE order_id = ?').get(order.id).n, 2, 'canonical paid order has pickup and dropoff tasks');
  await net.inbound('מה המצב'); const reply = env.DB.sqlite.prepare("SELECT body FROM whatsapp_booking_replies WHERE state = 'pending'").get(); assert.match(reply.body, /התשלום אומת/);
});

test('canonical checkout failure hands off and never creates another order or invoice', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW + 60_000 });
  const env = { ...environment(database()), GOOGLE_PLACES_SERVER_KEY: 'mock', SHOPIFY_SHOP: 'mock.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'mock' };
  const net = installNetworkFixtures(env, { chargeFails: true }); const row = await fullReview(env, net);
  await net.inbound(`אישור ${JSON.parse(row.state_json).revision}`); await net.inbound('אישור 2');
  assert.equal(env.DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase, 'handoff');
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n, 1); assert.equal(net.counts.charges, 1);
});

test('disabled webhook, invalid signature and unauthenticated ops do no work', async () => {
  const env = environment(database()); globalThis.fetch = async () => { throw new Error('network must not run'); };
  assert.equal((await worker.fetch(request('hello').req, { ...env, WHATSAPP_BOOKING_ENABLED: 'off' })).status, 503);
  const { req } = request('hello'); req.headers.set('X-Twilio-Signature', 'invalid'); assert.equal((await worker.fetch(req, env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://ops.edenmish.com/api/ops/whatsapp/bookings'), env)).status, 401);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_conversations').get().n, 0);
});

test('failed edits revoke the previous confirmation, and never leave an old payable quote', async () => {
  const state = await reviewed(); const svc = services(); svc.resolveAddress = async () => ({ error: 'ambiguous_delivery_address' });
  const edit = await advanceBooking(state, 'איסוף: לא ברור 1, תל אביב', svc, { phone, now: NOW });
  assert.equal(edit.state.quote, null); assert.equal(edit.state.data.pickup, undefined);
  const oldConfirm = await advanceBooking(edit.state, `אישור ${state.revision}`, svc, { phone, now: NOW }); assert.equal(oldConfirm.create, undefined);
});

test('migration upgrades the pre-release schema and preserves website order defaults', () => {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  const previous = schema.split('-- Disabled incoming booking adapter.')[0].replace("  source_channel TEXT NOT NULL DEFAULT 'website',\n", '');
  sqlite.exec(previous);
  sqlite.exec(readFileSync(new globalThis.URL('../migrations/039_whatsapp_booking.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO orders (token, created_at) VALUES (?, ?)').run('existing-fixture', NOW);
  assert.equal(sqlite.prepare('SELECT source_channel FROM orders').get().source_channel, 'website');
  for (const table of ['whatsapp_booking_conversations', 'whatsapp_booking_events', 'whatsapp_booking_replies']) assert.ok(sqlite.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table));
});

test('operator pause is authenticated and CSRF guarded; explicit close allows a fresh draft', async () => {
  const env = environment(database()); await processBookingEvent(env, { id: 'one', at: NOW, phone, text: 'מתחילים' }, services(), NOW);
  const row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); const token = await makeSession(env);
  const path = `https://ops.edenmish.com/api/ops/whatsapp/bookings/${row.id}/pause`;
  assert.equal((await worker.fetch(new Request(path, { method: 'POST', headers: { Cookie: 'ops_sess=' + token } }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(path, { method: 'POST', headers: { 'X-Ops': token } }), env)).status, 200);
  assert.equal((await worker.fetch(new Request(path.replace('/pause', '/close'), { method: 'POST', headers: { 'X-Ops': token } }), env)).status, 200);
  await processBookingEvent(env, { id: 'new', at: NOW + 1000, phone, text: 'שלום' }, services(), NOW + 1000);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_conversations WHERE phase = 'consent'").get().n, 1);
  const response = await worker.fetch(new Request('https://ops.edenmish.com/api/ops/whatsapp/bookings', { headers: { 'X-Ops': token } }), env);
  assert.equal(response.status, 200); const list = await response.json(); assert.equal(list.bookings.length, 2); assert.equal(list.bookings[0].order_token, undefined);
});

test('Twilio delivery failures pause, delivered/read never regress, callbacks do not mark orders paid', async () => {
  const env = environment(database()); env.WHATSAPP_BOOKING_SEND_ENABLED = 'on';
  await processBookingEvent(env, { id: 'one', at: NOW, phone, text: 'מתחילים' }, services(), NOW);
  const sid = 'SM' + '3'.repeat(32);
  await sendBookingReplies(env, async () => Response.json({ sid }), NOW);
  async function receipt(status) {
    const form = new URLSearchParams({ AccountSid: SID, MessageSid: sid, MessageStatus: status });
    return worker.fetch(new Request(URL + '/status', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(form, URL + '/status') }, body: form.toString() }), env);
  }
  assert.equal((await receipt('failed')).status, 200);
  assert.equal(env.DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase, 'handoff');
  await receipt('delivered'); await receipt('read'); await receipt('delivered'); await receipt('failed');
  assert.equal(env.DB.sqlite.prepare('SELECT state FROM whatsapp_booking_replies').get().state, 'read');
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
});

test('retention still runs after activation and sending are turned off', async () => {
  const env = environment(database()); await processBookingEvent(env, { id: 'one', at: NOW, phone, text: 'מתחילים' }, services(), NOW);
  env.WHATSAPP_BOOKING_ENABLED = 'off'; env.WHATSAPP_BOOKING_SEND_ENABLED = 'off';
  await cleanupBookings(env, NOW + 3 * SESSION_WINDOW);
  assert.equal(env.DB.sqlite.prepare('SELECT recipient FROM whatsapp_booking_conversations').get().recipient, null);
});


test('long summaries split durably within Twilio limits and stale events preserve pending replies', async () => {
  const text = ['x'.repeat(800), 'y'.repeat(800), 'אישור 2'].join('\n');
  const parts = splitBookingReply(text); assert.equal(parts.length, 2); assert.ok(parts.every(part => part.length <= 1600));
  assert.match(parts[1], /אישור 2/); assert.equal(splitBookingReply('x'.repeat(1601)), null);
  const env = environment(database()); await processBookingEvent(env, { id: 'latest', at: NOW, phone, text: 'מתחילים' }, services(), NOW);
  await processBookingEvent(env, { id: 'old', at: NOW - 1000, phone, text: 'hello' }, services(), NOW);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state = 'pending'").get().n, 1);
});

test('losing a lease before checkout cannot create an order or publish a reply', async () => {
  const env = environment(database()); const state = await reviewed(); const svc = services(); let creates = 0;
  await processBookingEvent(env, { id: 'begin', at: NOW, phone, text: 'מתחילים' }, svc, NOW);
  env.DB.sqlite.prepare('UPDATE whatsapp_booking_conversations SET phase = ?, state_json = ?').run(state.phase, JSON.stringify(state));
  svc.quote = async () => { env.DB.sqlite.prepare("UPDATE whatsapp_booking_conversations SET lock_id = NULL, lock_at = NULL, phase = 'handoff'").run(); return quote; };
  svc.create = async () => { creates++; return {}; };
  const result = await processBookingEvent(env, { id: 'confirm', at: NOW + 1000, phone, text: `אישור ${state.revision}` }, svc, NOW + 1000);
  assert.equal(result.phase, 'handoff'); assert.equal(creates, 0);
});

test('canonical creation rejects a price race after confirmation recheck, before any order or charge', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW + 60_000 });
  const env = { ...environment(database()), GOOGLE_PLACES_SERVER_KEY: 'mock', SHOPIFY_SHOP: 'mock.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'mock' };
  const net = installNetworkFixtures(env); const row = await fullReview(env, net);
  const prepare = env.DB.prepare.bind(env.DB); let ruleReads = 0;
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql === 'SELECT name, value FROM pricing_rules') {
      const all = statement.all.bind(statement);
      statement.all = async () => { const value = await all(); if (++ruleReads === 1) env.DB.sqlite.prepare("INSERT INTO pricing_rules (name, value) VALUES ('std_z1', 85) ON CONFLICT(name) DO UPDATE SET value = 85").run(); return value; };
    }
    return statement;
  };
  await net.inbound(`אישור ${JSON.parse(row.state_json).revision}`);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n, 0); assert.equal(net.counts.charges, 0);
  const changed = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); assert.equal(changed.phase, 'address_review');
  assert.equal(changed.confirmed_at, null);
});

test('public callers cannot spoof channel source, reserved token or wallet authorization', async () => {
  const env = environment(database());
  const data = (await reviewed()).data;
  const body = { ...data, phone, token: 'spoofed', source_channel: 'whatsapp', booking: { token: 'spoofed' } };
  const post = (value) => new Request('https://find.edenmish.com/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WhatsApp-Booking': 'true' }, body: JSON.stringify(value) });
  assert.equal((await worker.fetch(post({ ...body, use_wallet: true }), env)).status, 401);
  assert.equal((await worker.fetch(post(body), env)).status, 200);
  const order = env.DB.sqlite.prepare('SELECT token, source_channel FROM orders').get(); assert.notEqual(order.token, 'spoofed'); assert.equal(order.source_channel, 'website');
});
