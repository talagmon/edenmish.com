import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import {
  makePaymentConfirmationToken,
  PAYMENT_CONFIRMATION_TTL_MS,
  verifyPaymentConfirmationToken,
} from '../src/payment-confirmation.js';

const envFor = (order) => ({
  SESSION_SECRET: 'payment-confirmation-test-secret',
  STOREFRONT_BASE: 'https://edenmish.com',
  DB: {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/SELECT \* FROM orders WHERE id/.test(sql)) {
            return order && Number(order.id) === Number(this.args[0]) ? order : null;
          }
          return null;
        },
      };
    },
  },
});

const confirmationRequest = (credential) => new Request(
  'https://find.edenmish.com/api/payment-confirmation',
  {
    method: 'POST',
    headers: {
      Origin: 'https://edenmish.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ credential }),
  },
);

describe('payment confirmation capability', () => {
  test('binds a short-lived signed capability to one order', async () => {
    const now = 1_800_000_000_000;
    const env = envFor(null);
    const token = await makePaymentConfirmationToken(env, 42, now);

    assert.deepEqual(
      await verifyPaymentConfirmationToken(env, token, now + 1000),
      { orderId: 42 },
    );
    assert.equal(
      await verifyPaymentConfirmationToken(env, `${token}x`, now + 1000),
      null,
    );
    assert.equal(
      await verifyPaymentConfirmationToken(env, token, now + PAYMENT_CONFIRMATION_TTL_MS),
      null,
    );
  });

  test('keeps an unpaid checkout pending and returns no order data', async () => {
    const order = { id: 7, payment_status: 'link_sent', name: 'private customer' };
    const env = envFor(order);
    const credential = await makePaymentConfirmationToken(env, order.id);
    const response = await worker.fetch(confirmationRequest(credential), env);

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'pending' });
  });

  test('confirms only the authoritative paid state', async () => {
    const order = { id: 8, payment_status: 'paid', name: 'private customer' };
    const env = envFor(order);
    const credential = await makePaymentConfirmationToken(env, order.id);
    const response = await worker.fetch(confirmationRequest(credential), env);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'paid' });
  });

  test('rejects a tampered capability without querying by attacker input', async () => {
    const order = { id: 9, payment_status: 'paid' };
    const env = envFor(order);
    const credential = await makePaymentConfirmationToken(env, order.id);
    const response = await worker.fetch(confirmationRequest(`${credential}x`), env);

    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });
});
