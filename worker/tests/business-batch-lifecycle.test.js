import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import worker from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const openDatabases = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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

function jsonPost(path, body, headers = {}) {
  return new Request(`https://find.edenmish.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.44',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function createBusinessSession(env) {
  let response = await worker.fetch(
    jsonPost('/api/business/auth/request', {
      email: 'batch-lifecycle@example.com',
      plan_id: 'gold',
    }),
    env,
  );
  assert.equal(response.status, 200);
  const challenge = await response.json();
  response = await worker.fetch(
    jsonPost('/api/business/auth/verify', {
      challenge: challenge.challenge,
      code: challenge.test_code,
    }),
    env,
  );
  assert.equal(response.status, 200);
  return response.headers.get('Set-Cookie').split(';', 1)[0];
}

function nextBusinessDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  while ([5, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function place(route, number, city = 'תל אביב') {
  return {
    id: `${route}-${number}`,
    formattedAddress: `${route} ${number}, ${city}, ישראל`,
    location: { latitude: 32.08, longitude: 34.78 },
    types: ['street_address'],
    addressComponents: [
      { longText: number, shortText: number, types: ['street_number'] },
      { longText: route, shortText: route, types: ['route'] },
      { longText: city, shortText: city, types: ['locality'] },
      { longText: 'ישראל', shortText: 'IL', types: ['country'] },
    ],
  };
}

function installPlacesMock(sentEmails = null) {
  globalThis.fetch = async (url, request = {}) => {
    if (String(url) === 'https://api.sendgrid.com/v3/mail/send') {
      assert.ok(sentEmails, 'unexpected SendGrid request');
      sentEmails.push(JSON.parse(request.body));
      return new Response(null, { status: 202 });
    }
    assert.equal(String(url), 'https://places.googleapis.com/v1/places:searchText');
    const query = JSON.parse(request.body).textQuery;
    if (query.includes('דיזנגוף 1')) {
      return new Response(JSON.stringify({ places: [place('דיזנגוף', '1')] }));
    }
    if (query.includes('הרצך 10') || query.includes('הרצל 10')) {
      return new Response(JSON.stringify({ places: [place('הרצל', '10')] }));
    }
    if (query.includes('דרך יצחק רבין 1')) {
      return new Response(JSON.stringify({ places: [place('דרך יצחק רבין', '1', 'פתח תקווה')] }));
    }
    if (query.includes('שדרות מנחם בגין 5')) {
      return new Response(JSON.stringify({ places: [place('שדרות מנחם בגין', '5', 'בית דגן')] }));
    }
    throw new Error(`unexpected Places query: ${query}`);
  };
}

function batchRequest(csv, cookie) {
  const encoded = (value) => encodeURIComponent(value);
  return new Request('https://find.edenmish.com/api/business/batches/parse', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'text/csv',
      'CF-Connecting-IP': '203.0.113.44',
      'X-File-Name': encoded('batch.csv'),
      'X-Pickup-Street': encoded('דיזנגוף'),
      'X-Pickup-House-Number': encoded('1'),
      'X-Pickup-City': encoded('תל אביב'),
      'X-Batch-Service': encoded('standard'),
      'X-Batch-Default-Contents': encoded('מסמכים'),
    },
    body: csv,
  });
}

function csvFor(date, {
  name = 'נועה לוי',
  size = 'קטן',
  includeInvalid = false,
  externalId = 'ORD-LIFECYCLE',
  street = 'הרצך',
  houseNumber = '10',
  city = 'תל אביב',
} = {}) {
  const rows = [
    'מזהה משלוח,שם נמען,טלפון נמען,רחוב מסירה,מספר בית,עיר מסירה,תאריך איסוף,שעת איסוף,גודל חבילה,תכולה',
    `${externalId},${name},0501234567,${street},${houseNumber},${city},${date},10:00,${size},מסמכים`,
  ];
  if (includeInvalid) {
    rows.push(`ORD-INVALID,ללא טלפון,,הרצל,10,תל אביב,${date},10:00,קטן,מסמכים`);
  }
  return rows.join('\n');
}

function quoteBody(row, pickup) {
  return {
    pickup: pickup.address,
    pickup_city: pickup.city,
    pickup_lat: pickup.lat,
    pickup_lng: pickup.lng,
    dropoff: row.delivery_address,
    dropoff_city: row.delivery_city,
    dropoff_lat: row.delivery_lat,
    dropoff_lng: row.delivery_lng,
    when_date: row.pickup_date,
    when_hour: row.pickup_hour,
    service: 'standard',
    size: row.package_size,
    external_id: row.external_id,
  };
}

function orderBody(row, pickup, price) {
  return {
    use_wallet: true,
    name: row.recipient_name,
    phone: row.recipient_phone,
    pickup: pickup.address,
    pickup_city: pickup.city,
    pickup_lat: pickup.lat,
    pickup_lng: pickup.lng,
    dropoff: row.delivery_address,
    dropoff_city: row.delivery_city,
    dropoff_lat: row.delivery_lat,
    dropoff_lng: row.delivery_lng,
    when_date: row.pickup_date,
    when_hour: row.pickup_hour,
    when_text: `${row.pickup_date} · 10:00`,
    service: 'standard',
    size: row.package_size,
    package: row.contents,
    notes: '',
    expected_price: price,
    phone_delivery_link_opt_in: false,
    batch_row_token: row.batch_token,
    batch_pickup_token: pickup.batch_token,
  };
}

async function approveParsedRow(env, cookie, row, pickup) {
  const response = await worker.fetch(
    jsonPost('/api/business/batches/approve', {
      row_tokens: [row.batch_token],
      pickup_token: pickup.batch_token,
    }, { Cookie: cookie }),
    env,
  );
  assert.equal(response.status, 200);
  return response.json();
}

test('authenticated CSV lifecycle validates, approves, creates, updates and cancels one order', async () => {
  const DB = d1Database();
  const sentEmails = [];
  const env = {
    DB,
    SESSION_SECRET: 'batch-lifecycle-test-secret',
    GOOGLE_PLACES_SERVER_KEY: 'test-places-key',
    SENDGRID_API_KEY: 'sendgrid-test-key',
    OPS_EMAIL: 'ops@example.com',
    TEST_MODE: '1',
  };
  const cookie = await createBusinessSession(env);
  const account = DB.sqlite.prepare('SELECT id FROM business_accounts').get();
  const now = Date.now();
  DB.sqlite.prepare(
    `UPDATE business_accounts
     SET company_name = 'Batch Lifecycle', plan_id = 'gold', updated_at = ?
     WHERE id = ?`
  ).run(now, account.id);
  DB.sqlite.prepare(
    `UPDATE business_wallets
     SET available_agorot = 100000, reserved_agorot = 0, updated_at = ?
     WHERE account_id = ?`
  ).run(now, account.id);
  DB.sqlite.prepare(
    `INSERT INTO wallet_credit_lots
     (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
     VALUES (?, 'batch-lifecycle-credit', 100000, 100000, ?, ?)`
  ).run(account.id, now + 30 * 24 * 60 * 60 * 1000, now);
  DB.sqlite.prepare(
    `INSERT INTO orders
      (token, status, phone, email, payment_status, business_account_id, created_at)
     VALUES ('prior-business-order', 'delivered', '+972500000001',
             'prior@example.com', 'wallet_paid', ?, ?)`
  ).run(account.id, now - 1);
  installPlacesMock(sentEmails);
  const deliveryDate = nextBusinessDate();

  let response = await worker.fetch(
    batchRequest(csvFor(deliveryDate, { includeInvalid: true }), cookie),
    env,
  );
  assert.equal(response.status, 200);
  let parsed = await response.json();
  assert.equal(parsed.import_mode, 'template');
  assert.equal(parsed.row_count, 2);
  assert.equal(parsed.valid_count, 1);
  assert.deepEqual(parsed.rows[1].errors, ['missing_recipient_phone']);
  let row = parsed.rows[0];
  assert.equal(row.delivery_street, 'הרצל');
  assert.equal(row.import_action, 'create');
  assert.equal(row.corrections.some(({ source }) => source === 'google_maps'), true);

  let approved = await approveParsedRow(env, cookie, row, parsed.pickup);
  row.batch_token = approved.row_tokens[0];
  parsed.pickup.batch_token = approved.pickup_token;
  response = await worker.fetch(
    jsonPost('/api/business/quote', quoteBody(row, parsed.pickup), { Cookie: cookie }),
    env,
  );
  assert.equal(response.status, 200);
  let quote = await response.json();
  assert.equal(quote.available, true);

  const headers = { Cookie: cookie, 'Idempotency-Key': row.idempotency_key };
  response = await worker.fetch(
    jsonPost('/api/orders', orderBody(row, parsed.pickup, quote.price), headers),
    env,
  );
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.price, quote.price);
  assert.deepEqual(
    { ...DB.sqlite.prepare(
      'SELECT pickup_lat, pickup_lng, dropoff_lat, dropoff_lng FROM orders WHERE id = ?'
    ).get(created.order_id) },
    { pickup_lat: 32.08, pickup_lng: 34.78, dropoff_lat: 32.08, dropoff_lng: 34.78 },
  );
  const orderNotifications = DB.sqlite.prepare(
    `SELECT template, recipient, status
     FROM notifications
     WHERE order_id = ?
     ORDER BY id`
  ).all(created.order_id);
  assert.deepEqual(orderNotifications.map(({ template }) => template), [
    'customer_business_order_confirmation',
    'ops_new_business_order',
  ]);
  assert.deepEqual(orderNotifications.map(({ recipient, status }) => ({ recipient, status })), [
    { recipient: 'batch-lifecycle@example.com', status: 'sent' },
    { recipient: 'ops@example.com', status: 'sent' },
  ]);
  assert.equal(sentEmails.length, 2);
  const customerEmail = sentEmails.find((email) => (
    email.personalizations[0].to[0].email === 'batch-lifecycle@example.com'
  ));
  assert.ok(customerEmail, 'business account should receive a tracking confirmation');
  assert.equal(
    customerEmail.subject,
    `המשלוח העסקי נוצר ✓ — מעקב משלוח #${created.order_id}`,
  );
  assert.match(customerEmail.content[0].value, new RegExp(
    `https://edenmish\\.com/track\\.html\\?t=${created.token}`
  ));
  assert.doesNotMatch(customerEmail.content[0].value, /קוד האימות/);
  assert.equal(
    sentEmails.filter((email) => email.personalizations[0].to[0].email === 'ops@example.com').length,
    1,
    'wallet orders should send exactly one correctly labeled operations email',
  );

  response = await worker.fetch(
    jsonPost('/api/orders', orderBody(row, parsed.pickup, quote.price), headers),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).idempotent, true);
  assert.equal(sentEmails.length, 2, 'idempotent retries must not resend notifications');
  assert.equal(DB.sqlite.prepare(
    'SELECT COUNT(*) AS count FROM orders WHERE business_external_id = ?'
  ).get('ORD-LIFECYCLE').count, 1);

  response = await worker.fetch(
    batchRequest(csvFor(deliveryDate, { name: 'נועה כהן', size: 'בינוני' }), cookie),
    env,
  );
  assert.equal(response.status, 200);
  parsed = await response.json();
  row = parsed.rows[0];
  assert.equal(row.import_action, 'update');
  assert.equal(row.existing_order.id, created.order_id);
  approved = await approveParsedRow(env, cookie, row, parsed.pickup);
  row.batch_token = approved.row_tokens[0];
  parsed.pickup.batch_token = approved.pickup_token;
  response = await worker.fetch(
    jsonPost('/api/business/quote', quoteBody(row, parsed.pickup), { Cookie: cookie }),
    env,
  );
  quote = await response.json();
  response = await worker.fetch(
    jsonPost('/api/orders', orderBody(row, parsed.pickup, quote.price), {
      Cookie: cookie,
      'Idempotency-Key': row.idempotency_key,
    }),
    env,
  );
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.updated, true);
  assert.equal(updated.order_id, created.order_id);
  assert.equal(DB.sqlite.prepare(
    'SELECT name FROM orders WHERE id = ?'
  ).get(created.order_id).name, 'נועה כהן');

  response = await worker.fetch(
    new Request(`https://find.edenmish.com/api/business/orders/${created.order_id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).released, updated.price);
  assert.deepEqual(
    { ...DB.sqlite.prepare(
      'SELECT status, payment_status FROM orders WHERE id = ?'
    ).get(created.order_id) },
    { status: 'cancelled', payment_status: 'wallet_released' },
  );
  assert.deepEqual(
    { ...DB.sqlite.prepare(
      'SELECT available_agorot, reserved_agorot FROM business_wallets WHERE account_id = ?'
    ).get(account.id) },
    { available_agorot: 100000, reserved_agorot: 0 },
  );
});

test('a one-use account exception prices and creates only its exact Zone 3 batch row', async () => {
  const DB = d1Database();
  const env = {
    DB,
    SESSION_SECRET: 'batch-exception-test-secret',
    GOOGLE_PLACES_SERVER_KEY: 'test-places-key',
    TEST_MODE: '1',
  };
  const cookie = await createBusinessSession(env);
  const account = DB.sqlite.prepare('SELECT id FROM business_accounts').get();
  const now = Date.now();
  DB.sqlite.prepare(`UPDATE business_accounts
    SET plan_id = 'gold', updated_at = ? WHERE id = ?`).run(now, account.id);
  DB.sqlite.prepare(`UPDATE business_wallets
    SET available_agorot = 100000, reserved_agorot = 0, updated_at = ?
    WHERE account_id = ?`).run(now, account.id);
  DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
    (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
    VALUES (?, 'exception-credit', 100000, 100000, ?, ?)`)
    .run(account.id, now + 30 * 24 * 60 * 60 * 1000, now);
  DB.sqlite.prepare(`INSERT INTO business_delivery_exceptions
    (account_id, external_id, zone, service, price_agorot, expires_at, note, created_at)
    VALUES (?, 'RH2026-003', 3, 'standard', 11500, ?, 'one-use test', ?)`)
    .run(account.id, now + 24 * 60 * 60 * 1000, now);
  DB.sqlite.prepare(`INSERT INTO orders
    (token, status, phone, email, payment_status, business_account_id, created_at)
    VALUES ('prior-exception-account-order', 'delivered', '+972500000003',
            'prior-exception@example.com', 'wallet_paid', ?, ?)`)
    .run(account.id, now - 1);
  installPlacesMock();
  const deliveryDate = nextBusinessDate();

  let response = await worker.fetch(
    batchRequest(csvFor(deliveryDate, {
      externalId: 'RH2026-003',
      street: 'דרך יצחק רבין',
      houseNumber: '1',
      city: 'פתח תקווה',
    }), cookie),
    env,
  );
  assert.equal(response.status, 200);
  const parsed = await response.json();
  let row = parsed.rows[0];
  const approved = await approveParsedRow(env, cookie, row, parsed.pickup);
  row.batch_token = approved.row_tokens[0];
  parsed.pickup.batch_token = approved.pickup_token;

  response = await worker.fetch(
    jsonPost('/api/business/quote', quoteBody(row, parsed.pickup), { Cookie: cookie }),
    env,
  );
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.equal(quote.zone, 3);
  assert.equal(quote.price, 115);
  assert.equal(quote.available, true);
  assert.equal(quote.exception_applied, true);

  response = await worker.fetch(
    jsonPost('/api/orders', orderBody(row, parsed.pickup, quote.price), {
      Cookie: cookie,
      'Idempotency-Key': row.idempotency_key,
    }),
    env,
  );
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.price, 115);
  assert.equal(created.exception_applied, true);
  assert.deepEqual(
    { ...DB.sqlite.prepare(`SELECT consumed_key, order_id
      FROM business_delivery_exceptions WHERE account_id = ? AND external_id = ?`)
      .get(account.id, 'RH2026-003') },
    { consumed_key: row.idempotency_key, order_id: created.order_id },
  );

  response = await worker.fetch(
    jsonPost('/api/business/quote', {
      ...quoteBody(row, parsed.pickup),
      external_id: 'RH2026-OTHER',
    }, { Cookie: cookie }),
    env,
  );
  const otherQuote = await response.json();
  assert.equal(otherQuote.available, false);
  assert.ok(otherQuote.reasons.includes('plan_service_unavailable'));
});

test('an exact one-use exception treats one out-of-zone batch row as Zone 3', async () => {
  const DB = d1Database();
  const env = {
    DB,
    SESSION_SECRET: 'batch-out-of-zone-exception-test-secret',
    GOOGLE_PLACES_SERVER_KEY: 'test-places-key',
    TEST_MODE: '1',
  };
  const cookie = await createBusinessSession(env);
  const account = DB.sqlite.prepare('SELECT id FROM business_accounts').get();
  const now = Date.now();
  DB.sqlite.prepare(`UPDATE business_accounts
    SET plan_id = 'gold', updated_at = ? WHERE id = ?`).run(now, account.id);
  DB.sqlite.prepare(`UPDATE business_wallets
    SET available_agorot = 100000, reserved_agorot = 0, updated_at = ?
    WHERE account_id = ?`).run(now, account.id);
  DB.sqlite.prepare(`INSERT INTO wallet_credit_lots
    (account_id, topup_id, original_agorot, remaining_agorot, expires_at, created_at)
    VALUES (?, 'out-of-zone-exception-credit', 100000, 100000, ?, ?)`)
    .run(account.id, now + 30 * 24 * 60 * 60 * 1000, now);
  DB.sqlite.prepare(`INSERT INTO business_delivery_exceptions
    (account_id, external_id, zone, service, price_agorot, expires_at, note, created_at)
    VALUES (?, 'RH2026-008', 3, 'standard', 11500, ?, 'one-use out-of-zone test', ?)`)
    .run(account.id, now + 24 * 60 * 60 * 1000, now);
  DB.sqlite.prepare(`INSERT INTO orders
    (token, status, phone, email, payment_status, business_account_id, created_at)
    VALUES ('prior-out-of-zone-account-order', 'delivered', '+972500000008',
            'prior-out-of-zone@example.com', 'wallet_paid', ?, ?)`)
    .run(account.id, now - 1);
  installPlacesMock();

  let response = await worker.fetch(
    batchRequest(csvFor(nextBusinessDate(), {
      externalId: 'RH2026-008',
      street: 'שדרות מנחם בגין',
      houseNumber: '5',
      city: 'בית דגן',
    }), cookie),
    env,
  );
  assert.equal(response.status, 200);
  const parsed = await response.json();
  let row = parsed.rows[0];
  const approved = await approveParsedRow(env, cookie, row, parsed.pickup);
  row.batch_token = approved.row_tokens[0];
  parsed.pickup.batch_token = approved.pickup_token;

  response = await worker.fetch(
    jsonPost('/api/business/quote', quoteBody(row, parsed.pickup), { Cookie: cookie }),
    env,
  );
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.equal(quote.zone, 3);
  assert.equal(quote.price, 115);
  assert.equal(quote.available, true);
  assert.equal(quote.exception_applied, true);

  response = await worker.fetch(
    jsonPost('/api/orders', orderBody(row, parsed.pickup, quote.price), {
      Cookie: cookie,
      'Idempotency-Key': row.idempotency_key,
    }),
    env,
  );
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.price, 115);
  assert.equal(created.exception_applied, true);
  assert.deepEqual(
    { ...DB.sqlite.prepare(`SELECT consumed_key, order_id
      FROM business_delivery_exceptions WHERE account_id = ? AND external_id = ?`)
      .get(account.id, 'RH2026-008') },
    { consumed_key: row.idempotency_key, order_id: created.order_id },
  );
});
