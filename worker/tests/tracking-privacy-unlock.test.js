import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import {
  hashOtp,
  makeTrackingUnlock,
  TRACKING_UNLOCK_COOKIE,
  TRACKING_UNLOCK_TTL_MS,
} from '../src/integrations.js';

class SQLiteD1Statement {
  constructor(statement) {
    this.statement = statement;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async run() {
    const result = this.statement.run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.statement.get(...this.args) || null;
  }

  async all() {
    return { results: this.statement.all(...this.args) };
  }
}

class SQLiteD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  }

  prepare(sql) {
    return new SQLiteD1Statement(this.db.prepare(sql));
  }

  seedDelivered({
    id,
    token,
    deliveredAt,
    emailVerified = 1,
    paymentStatus = 'paid',
    paymentMethod = null,
    businessAccountId = null,
  }) {
    const createdAt = deliveredAt - 60 * 60 * 1000;
    this.db.prepare(`INSERT INTO orders (
      id, token, status, name, phone, pickup, pickup_city, dropoff, dropoff_city,
      service, size, price, currency, payment_status, payment_method,
      business_account_id, created_at, delivered_at, email, email_verified
    ) VALUES (?, ?, 'delivered', 'לקוח פרטי', '0501111111', 'דיזנגוף 1',
      'תל אביב', 'ויצמן 14', 'גבעתיים', 'standard', 'small', 50, 'ILS',
      ?, ?, ?, ?, ?, 'customer@example.com', ?)`).run(
      id,
      token,
      paymentStatus,
      paymentMethod,
      businessAccountId,
      createdAt,
      deliveredAt,
      emailVerified,
    );
    this.db.prepare(`INSERT INTO status_history (order_id, status, at)
      VALUES (?, 'delivered', ?)`).run(id, deliveredAt);
  }
}

const envFor = (DB) => ({
  DB,
  SESSION_SECRET: 'tracking-unlock-test-secret',
  ALLOWED_ORIGINS: 'https://edenmish.com',
});

const getTracking = (token, cookie) => new Request(
  `https://find.edenmish.com/api/orders/${token}`,
  {
    headers: {
      Origin: 'https://edenmish.com',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  },
);

const postTracking = (token, action, body = undefined) => new Request(
  `https://find.edenmish.com/api/orders/${token}/${action}`,
  {
    method: 'POST',
    headers: {
      Origin: 'https://edenmish.com',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  },
);

const cookiePair = (setCookie) => String(setCookie || '').split(';', 1)[0];
const oldDelivery = () => Date.now() - 25 * 60 * 60 * 1000;
const recentDelivery = () => Date.now() - 23 * 60 * 60 * 1000;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('old delivered tracking privacy unlock', () => {
  test('keeps the magic link available during the initial 24-hour window', async () => {
    const DB = new SQLiteD1();
    const token = 'recentordinarytrack01';
    DB.seedDelivered({ id: 1, token, deliveredAt: recentDelivery(), emailVerified: 0 });

    const response = await worker.fetch(getTracking(token), envFor(DB));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.otp_pending, false);
    assert.equal(body.order.name, 'לקוח פרטי');
    assert.equal(body.order.dropoff, 'ויצמן 14');
  });

  test('relocks an ordinary old order even when durable email ownership is verified', async () => {
    const DB = new SQLiteD1();
    const token = 'oldordinarytracking01';
    DB.seedDelivered({ id: 2, token, deliveredAt: oldDelivery(), emailVerified: 1 });

    const response = await worker.fetch(getTracking(token), envFor(DB));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.otp_pending, true);
    assert.deepEqual(Object.keys(body.order).sort(), [
      'email_masked',
      'id',
      'otp_enabled',
      'status',
      'token',
    ]);
    assert.equal(body.order.name, undefined);
    assert.equal(body.order.dropoff, undefined);
  });

  test('does not pre-mint an unlock before the privacy window closes', async () => {
    const DB = new SQLiteD1();
    const token = 'recentotpverification1';
    const env = envFor(DB);
    DB.seedDelivered({ id: 8, token, deliveredAt: recentDelivery() });
    DB.db.prepare(`UPDATE orders
      SET otp_hash = ?, otp_expires = ?
      WHERE id = 8`).run(
      await hashOtp(env, '654321'),
      Date.now() + 10 * 60 * 1000,
    );

    const verified = await worker.fetch(
      postTracking(token, 'verify-otp', { code: '654321' }),
      env,
    );

    assert.deepEqual(await verified.json(), { verified: true });
    assert.equal(verified.headers.get('set-cookie'), null);
  });

  test('a fresh OTP issues a secure short-lived cookie and unlocks only that order', async () => {
    const DB = new SQLiteD1();
    const token = 'freshunlocktracking01';
    const otherToken = 'otherordertracking001';
    const env = envFor(DB);
    DB.seedDelivered({ id: 3, token, deliveredAt: oldDelivery() });
    DB.seedDelivered({ id: 4, token: otherToken, deliveredAt: oldDelivery() });
    DB.db.prepare(`UPDATE orders
      SET otp_hash = ?, otp_expires = ?
      WHERE id = 3`).run(
      await hashOtp(env, '654321'),
      Date.now() + 10 * 60 * 1000,
    );

    const verified = await worker.fetch(
      postTracking(token, 'verify-otp', { code: '654321' }),
      env,
    );
    const setCookie = verified.headers.get('set-cookie');

    assert.deepEqual(await verified.json(), { verified: true });
    assert.match(setCookie, new RegExp(`^${TRACKING_UNLOCK_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/api\/orders/);
    assert.match(setCookie, new RegExp(`Max-Age=${TRACKING_UNLOCK_TTL_MS / 1000}`));
    assert.equal(verified.headers.get('access-control-allow-credentials'), 'true');

    const cookie = cookiePair(setCookie);
    const unlocked = await worker.fetch(getTracking(token, cookie), env);
    const unlockedBody = await unlocked.json();
    assert.equal(unlockedBody.otp_pending, false);
    assert.equal(unlockedBody.order.name, 'לקוח פרטי');

    const wrongOrder = await worker.fetch(getTracking(otherToken, cookie), env);
    const wrongOrderBody = await wrongOrder.json();
    assert.equal(wrongOrderBody.otp_pending, true);
    assert.equal(wrongOrderBody.order.name, undefined);
  });

  test('an expired OTP cannot create an unlock', async () => {
    const DB = new SQLiteD1();
    const token = 'expiredotptracking001';
    const env = envFor(DB);
    DB.seedDelivered({ id: 5, token, deliveredAt: oldDelivery() });
    DB.db.prepare(`UPDATE orders
      SET otp_hash = ?, otp_expires = ?
      WHERE id = 5`).run(await hashOtp(env, '654321'), Date.now() - 1);

    const response = await worker.fetch(
      postTracking(token, 'verify-otp', { code: '654321' }),
      env,
    );

    assert.deepEqual(await response.json(), { verified: false, error: 'expired' });
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test('an expired signed unlock returns to the public summary', async () => {
    const DB = new SQLiteD1();
    const token = 'expiredunlocktrack01';
    const env = envFor(DB);
    DB.seedDelivered({ id: 6, token, deliveredAt: oldDelivery() });
    const expired = await makeTrackingUnlock(
      env,
      6,
      token,
      Date.now() - TRACKING_UNLOCK_TTL_MS - 1,
    );

    const response = await worker.fetch(
      getTracking(token, `${TRACKING_UNLOCK_COOKIE}=${expired}`),
      env,
    );
    const body = await response.json();

    assert.equal(body.otp_pending, true);
    assert.equal(body.order.name, undefined);
  });

  test('a delivered business wallet order can request and complete reauthentication', async (t) => {
    t.mock.method(Math, 'random', () => 0);
    const DB = new SQLiteD1();
    const token = 'businesswallettrack01';
    const env = {
      ...envFor(DB),
      SENDGRID_API_KEY: 'sendgrid-test-key',
    };
    DB.seedDelivered({
      id: 7,
      token,
      deliveredAt: oldDelivery(),
      paymentStatus: 'wallet_paid',
      paymentMethod: 'wallet',
      businessAccountId: 77,
      emailVerified: 1,
    });
    let sentEmail = null;
    globalThis.fetch = async (_url, options) => {
      sentEmail = JSON.parse(options.body);
      return new Response(null, { status: 202 });
    };

    const locked = await worker.fetch(getTracking(token), env);
    assert.equal((await locked.json()).otp_pending, true);

    const resent = await worker.fetch(postTracking(token, 'resend-otp'), env);
    assert.deepEqual(await resent.json(), { ok: true });
    assert.equal(
      DB.db.prepare('SELECT otp_hash FROM orders WHERE id = 7').get().otp_hash,
      await hashOtp(env, '100000'),
    );
    assert.match(sentEmail.content[0].value, /100000/);

    const verified = await worker.fetch(
      postTracking(token, 'verify-otp', { code: '100000' }),
      env,
    );
    const cookie = cookiePair(verified.headers.get('set-cookie'));
    assert.deepEqual(await verified.json(), { verified: true });

    const unlocked = await worker.fetch(getTracking(token, cookie), env);
    const body = await unlocked.json();
    assert.equal(body.otp_pending, false);
    assert.equal(body.order.payment_method, 'wallet');
    assert.equal(body.order.business_account_id, 77);
  });
});
