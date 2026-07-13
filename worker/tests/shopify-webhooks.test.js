import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createShopifyWebhookRegistrar,
  REQUIRED_SHOPIFY_WEBHOOK_TOPICS,
} from '../src/shopify-webhooks.js';

const ENV = {
  SHOPIFY_SHOP: 'example.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'test-token',
  SHOPIFY_API_VERSION: '2026-04',
};

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const quietLogger = { log() {}, error() {} };

describe('Shopify webhook registration', () => {
  test('reports unconfigured without making a network request', async () => {
    let calls = 0;
    const registrar = createShopifyWebhookRegistrar({
      fetchFn: async () => { calls += 1; return response({}); },
      logger: quietLogger,
    });

    const status = await registrar.ensure({});

    assert.equal(calls, 0);
    assert.equal(status.status, 'unconfigured');
    assert.equal(status.ready, false);
    assert.deepEqual(status.missing_topics, REQUIRED_SHOPIFY_WEBHOOK_TOPICS);
    assert.deepEqual(status.error, { code: 'missing_shopify_configuration' });
  });

  test('is ready when every required subscription already exists', async () => {
    let calls = 0;
    const registrar = createShopifyWebhookRegistrar({
      fetchFn: async () => {
        calls += 1;
        return response({
          webhooks: REQUIRED_SHOPIFY_WEBHOOK_TOPICS.map((topic) => ({
            topic,
            address: 'https://find.edenmish.com/webhooks/shopify',
          })),
        });
      },
      logger: quietLogger,
    });

    const status = await registrar.ensure(ENV);

    assert.equal(calls, 1);
    assert.equal(status.status, 'ready');
    assert.equal(status.ready, true);
    assert.deepEqual(status.missing_topics, []);
  });

  test('creates only missing subscriptions at the canonical endpoint', async () => {
    const requests = [];
    const registrar = createShopifyWebhookRegistrar({
      fetchFn: async (_url, options = {}) => {
        requests.push(options);
        if (!options.method) {
          return response({
            webhooks: [{ topic: 'orders/paid', address: 'https://find.edenmish.com/webhooks/shopify' }],
          });
        }
        return response({ webhook: JSON.parse(options.body).webhook }, 201);
      },
      logger: quietLogger,
    });

    const status = await registrar.ensure(ENV);

    assert.equal(status.ready, true);
    assert.equal(requests.length, 3);
    const created = requests.slice(1).map((request) => JSON.parse(request.body).webhook);
    assert.deepEqual(created.map((webhook) => webhook.topic), ['orders/updated', 'refunds/create']);
    assert.ok(created.every((webhook) => webhook.address === 'https://find.edenmish.com/webhooks/shopify'));
  });

  test('keeps failures degraded and retries after the cooldown', async () => {
    let currentTime = 1_000;
    let calls = 0;
    const registrar = createShopifyWebhookRegistrar({
      now: () => currentTime,
      retryMs: 500,
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) return response({ errors: 'forbidden' }, 403);
        return response({
          webhooks: REQUIRED_SHOPIFY_WEBHOOK_TOPICS.map((topic) => ({
            topic,
            address: 'https://find.edenmish.com/webhooks/shopify',
          })),
        });
      },
      logger: quietLogger,
    });

    const failed = await registrar.ensure(ENV);
    assert.equal(failed.status, 'degraded');
    assert.deepEqual(failed.error, { code: 'list_http_error', http_status: 403 });

    await registrar.ensure(ENV);
    assert.equal(calls, 1, 'must not hammer Shopify during the cooldown');

    currentTime += 501;
    const recovered = await registrar.ensure(ENV);
    assert.equal(calls, 2);
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.ready, true);
  });

  test('does not report ready when a missing topic cannot be created', async () => {
    const registrar = createShopifyWebhookRegistrar({
      fetchFn: async (_url, options = {}) => {
        if (!options.method) return response({ webhooks: [] });
        const topic = JSON.parse(options.body).webhook.topic;
        if (topic === 'orders/updated') return response({ errors: 'forbidden' }, 403);
        return response({ webhook: { topic } }, 201);
      },
      logger: quietLogger,
    });

    const status = await registrar.ensure(ENV);

    assert.equal(status.status, 'degraded');
    assert.equal(status.ready, false);
    assert.deepEqual(status.missing_topics, ['orders/updated']);
    assert.equal(status.error.code, 'create_failed');
    assert.equal(status.error.topics[0].http_status, 403);
  });
});
