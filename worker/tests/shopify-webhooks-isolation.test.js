import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyWebhookRegistrar, REQUIRED_SHOPIFY_WEBHOOK_TOPICS as TOPICS } from '../src/shopify-webhooks.js';

// All fetches in this suite are injected fixtures. No Shopify account is accessed.
const STAGING = {
  SHOPIFY_SHOP: 'edenmish-fixture-sandbox.myshopify.com',
  SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'edenmish-fixture-sandbox.myshopify.com',
  SHOPIFY_WEBHOOK_ENVIRONMENT: 'staging',
  SHOPIFY_WEBHOOK_CALLBACK_URL: 'https://ops-staging.edenmish.com/webhooks/shopify',
  SHOPIFY_ADMIN_TOKEN: 'synthetic-staging-token',
  SHOPIFY_API_VERSION: '2026-04',
};
const PRODUCTION = {
  ...STAGING,
  SHOPIFY_SHOP: 'edenmish.myshopify.com',
  SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'edenmish.myshopify.com',
  SHOPIFY_WEBHOOK_ENVIRONMENT: 'production',
  SHOPIFY_WEBHOOK_CALLBACK_URL: 'https://find.edenmish.com/webhooks/shopify',
  SHOPIFY_ADMIN_TOKEN: 'synthetic-production-token',
};
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const complete = address => ({ webhooks: TOPICS.map(topic => ({ topic, address })) });
const logger = { log() {}, error() {} };
function fixture(list = { webhooks: [] }, create = webhook => ({ webhook })) {
  const requests = [];
  const registrar = createShopifyWebhookRegistrar({ logger, now: () => 1000, fetchFn: async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', options });
    return response(options.method === 'POST' ? create(JSON.parse(options.body).webhook) : list);
  } });
  return { registrar, requests };
}

test('staging defaults to verification and never creates missing subscriptions', async () => {
  const { registrar, requests } = fixture();
  assert.equal((await registrar.ensure(STAGING)).ready, false);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
  assert.equal(requests[0].url, 'https://edenmish-fixture-sandbox.myshopify.com/admin/api/2026-04/webhooks.json');
});

test('allowCreate does not override default verify registration mode', async () => {
  const { registrar, requests } = fixture();
  assert.equal((await registrar.ensure(STAGING, { allowCreate: true })).ready, false);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});

test('staging create configuration alone remains read-only', async () => {
  const { registrar, requests } = fixture();
  assert.equal((await registrar.ensure({ ...STAGING, SHOPIFY_WEBHOOK_REGISTRATION: 'create' })).ready, false);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});

test('staging explicit create opt-in creates only its missing exact subscriptions', async () => {
  const { registrar, requests } = fixture({ webhooks: [{ topic: 'orders/paid', address: STAGING.SHOPIFY_WEBHOOK_CALLBACK_URL }] });
  const status = await registrar.ensure({ ...STAGING, SHOPIFY_WEBHOOK_REGISTRATION: 'create' }, { allowCreate: true });
  assert.equal(status.ready, true);
  const created = requests.filter(r => r.method === 'POST').map(r => JSON.parse(r.options.body).webhook);
  assert.deepEqual(created.map(w => w.topic), ['orders/updated', 'refunds/create']);
  assert.ok(created.every(w => w.address === STAGING.SHOPIFY_WEBHOOK_CALLBACK_URL && w.format === 'json'));
  assert.ok(requests.every(r => new URL(r.url).hostname === STAGING.SHOPIFY_SHOP));
});

test('explicit production create mode preserves automatic missing-topic creation', async () => {
  const { registrar, requests } = fixture();
  assert.equal((await registrar.ensure({ ...PRODUCTION, SHOPIFY_WEBHOOK_REGISTRATION: 'create' })).ready, true);
  assert.deepEqual(requests.map(r => r.method), ['GET', 'POST', 'POST', 'POST']);
  assert.ok(requests.every(r => r.options.redirect === 'error'), 'token-bearing requests must not follow redirects');
  assert.ok(requests.slice(1).every(r => JSON.parse(r.options.body).webhook.address === PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL));
});

test('production verification preserves orders/paid on ops and other topics on find', async () => {
  const { registrar, requests } = fixture({ webhooks: TOPICS.map(topic => ({ topic,
    address: topic === 'orders/paid' ? 'https://ops.edenmish.com/webhooks/shopify' : PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL,
  })) });
  assert.equal((await registrar.ensure(PRODUCTION)).ready, true);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});

test('both known production shop aliases are accepted without alias-normalizing expected shop', async () => {
  for (const shop of ['edenmish.myshopify.com', 'r013gt-fc.myshopify.com']) {
    const { registrar, requests } = fixture(complete(PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL));
    assert.equal((await registrar.ensure({ ...PRODUCTION, SHOPIFY_SHOP: shop, SHOPIFY_WEBHOOK_EXPECTED_SHOP: shop })).ready, true);
    assert.equal(new URL(requests[0].url).hostname, shop);
  }
});

const invalidConfigs = [
  ['missing environment', { SHOPIFY_WEBHOOK_ENVIRONMENT: undefined }],
  ['unknown environment', { SHOPIFY_WEBHOOK_ENVIRONMENT: 'preview' }],
  ['missing expected shop', { SHOPIFY_WEBHOOK_EXPECTED_SHOP: undefined }],
  ['mismatched shop', { SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'different-fixture.myshopify.com' }],
  ['nested shop label', { SHOPIFY_SHOP: 'nested.shop.myshopify.com', SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'nested.shop.myshopify.com' }],
  ['invalid trailing-hyphen shop label', { SHOPIFY_SHOP: 'fixture-.myshopify.com', SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'fixture-.myshopify.com' }],
  ['oversize DNS shop label', { SHOPIFY_SHOP: `${'a'.repeat(64)}.myshopify.com`, SHOPIFY_WEBHOOK_EXPECTED_SHOP: `${'a'.repeat(64)}.myshopify.com` }],
  ['shop path', { SHOPIFY_SHOP: 'fixture.myshopify.com/admin', SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'fixture.myshopify.com/admin' }],
  ['shop userinfo', { SHOPIFY_SHOP: 'fixture@attacker.invalid', SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'fixture@attacker.invalid' }],
  ['production alias in staging', { SHOPIFY_SHOP: 'edenmish.myshopify.com', SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'edenmish.myshopify.com' }],
  ['second production alias in staging', { SHOPIFY_SHOP: 'r013gt-fc.myshopify.com', SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'r013gt-fc.myshopify.com' }],
  ['unknown registration mode', { SHOPIFY_WEBHOOK_REGISTRATION: 'ensure' }],
  ['missing callback', { SHOPIFY_WEBHOOK_CALLBACK_URL: undefined }],
  ...[
    'https://find.edenmish.com/webhooks/shopify',
    'https://ops.edenmish.com/webhooks/shopify',
    'http://ops-staging.edenmish.com/webhooks/shopify',
    'https://ops-staging.edenmish.com:443/webhooks/shopify',
    'https://ops-staging.edenmish.com:8443/webhooks/shopify',
    'https://user@ops-staging.edenmish.com/webhooks/shopify',
    'https://ops-staging.edenmish.com/webhooks/shopify?test=1',
    'https://ops-staging.edenmish.com/webhooks/shopify#test',
    'https://ops-staging.edenmish.com/webhooks/shopify/',
    'https://ops-staging.edenmish.com/webhooks/%73hopify',
    'https://ops-staging.edenmish.com.evil.invalid/webhooks/shopify',
  ].map(value => [`unsafe callback ${value}`, { SHOPIFY_WEBHOOK_CALLBACK_URL: value }]),
];
for (const [label, override] of invalidConfigs) test(`invalid isolation config makes zero requests: ${label}`, async () => {
  const { registrar, requests } = fixture();
  assert.equal((await registrar.ensure({ ...STAGING, ...override }, { force: true, allowCreate: true })).ready, false);
  assert.equal(requests.length, 0);
});

test('production rejects an otherwise valid unknown shop and staging callback', async () => {
  for (const override of [
    { SHOPIFY_SHOP: STAGING.SHOPIFY_SHOP, SHOPIFY_WEBHOOK_EXPECTED_SHOP: STAGING.SHOPIFY_SHOP },
    { SHOPIFY_WEBHOOK_CALLBACK_URL: STAGING.SHOPIFY_WEBHOOK_CALLBACK_URL },
    { SHOPIFY_WEBHOOK_EXPECTED_SHOP: 'r013gt-fc.myshopify.com' },
  ]) {
    const { registrar, requests } = fixture();
    assert.equal((await registrar.ensure({ ...PRODUCTION, ...override })).ready, false);
    assert.equal(requests.length, 0);
  }
});

for (const address of [
  PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL,
  'https://ops-staging.edenmish.com/wrong/webhooks/shopify',
  'https://ops-staging.edenmish.com/webhooks/shopify?redirect=1',
  'https://attacker.invalid/webhooks/shopify',
]) test(`conflicting required hook never gets rewritten or supplemented: ${address}`, async () => {
  const { registrar, requests } = fixture({ webhooks: [
    ...complete(STAGING.SHOPIFY_WEBHOOK_CALLBACK_URL).webhooks,
    { topic: 'orders/paid', address },
  ] });
  assert.equal((await registrar.ensure({ ...STAGING, SHOPIFY_WEBHOOK_REGISTRATION: 'create' }, { allowCreate: true })).ready, false);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});

test('unrelated webhook topics do not cause mutation or satisfy required topics', async () => {
  const { registrar, requests } = fixture({ webhooks: [{ topic: 'products/update', address: 'https://unrelated.invalid/hook' }] });
  const result = await registrar.ensure(STAGING);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing_topics, TOPICS);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});

for (const create of [
  webhook => ({ webhook: { topic: webhook.topic } }),
  webhook => ({ webhook: { ...webhook, topic: 'products/update' } }),
  webhook => ({ webhook: { ...webhook, address: PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL } }),
]) test('creation response must echo exact requested topic and callback before readiness', async () => {
  const { registrar, requests } = fixture({ webhooks: [] }, create);
  assert.equal((await registrar.ensure({ ...STAGING, SHOPIFY_WEBHOOK_REGISTRATION: 'create' }, { allowCreate: true })).ready, false);
  assert.ok(requests.every(r => ['GET', 'POST'].includes(r.method)));
});

test('cached production readiness cannot mask invalid staging configuration', async () => {
  const { registrar, requests } = fixture(complete(PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL));
  assert.equal((await registrar.ensure(PRODUCTION)).ready, true);
  assert.equal((await registrar.ensure({ ...STAGING, SHOPIFY_WEBHOOK_CALLBACK_URL: PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL })).ready, false);
  assert.equal(requests.length, 1);
});

test('changed token forces a fresh read without disclosing either token', async () => {
  const { registrar, requests } = fixture(complete(STAGING.SHOPIFY_WEBHOOK_CALLBACK_URL));
  await registrar.ensure(STAGING);
  await registrar.ensure(STAGING);
  const result = await registrar.ensure({ ...STAGING, SHOPIFY_ADMIN_TOKEN: 'synthetic-replacement-token' });
  assert.equal(requests.length, 2);
  assert.equal(result.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-(staging|replacement)-token/);
});

test('explicit staging create opt-in is not suppressed by cached verification failure', async () => {
  const { registrar, requests } = fixture();
  const env = { ...STAGING, SHOPIFY_WEBHOOK_REGISTRATION: 'create' };
  assert.equal((await registrar.ensure(env)).ready, false);
  assert.equal((await registrar.ensure(env, { allowCreate: true })).ready, true);
  assert.equal(requests.filter(r => r.method === 'GET').length, 2);
  assert.equal(requests.filter(r => r.method === 'POST').length, 3);
});

test('concurrent config change aborts readiness and requires a fresh scoped retry', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const hosts = [];
  const registrar = createShopifyWebhookRegistrar({ logger, now: () => 1000, fetchFn: async url => {
    const host = new URL(url).hostname;
    hosts.push(host);
    if (host === PRODUCTION.SHOPIFY_SHOP) { await gate; return response(complete(PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL)); }
    return response({ webhooks: [] });
  } });
  const production = registrar.ensure(PRODUCTION);
  const staging = registrar.ensure(STAGING);
  release();
  const [prodResult, stageResult] = await Promise.all([production, staging]);
  assert.equal(prodResult.ready, false);
  assert.equal(stageResult.ready, false);
  assert.deepEqual(hosts, [PRODUCTION.SHOPIFY_SHOP]);
  assert.equal((await registrar.ensure(STAGING)).ready, false);
  assert.deepEqual(hosts.sort(), [PRODUCTION.SHOPIFY_SHOP, STAGING.SHOPIFY_SHOP].sort());
});

test('partial paginated subscription lists cannot authorize writes or readiness', async () => {
  const methods = [];
  const registrar = createShopifyWebhookRegistrar({ logger, fetchFn: async (_url, options = {}) => {
    methods.push(options.method || 'GET');
    if (methods.length === 1) return new Response(JSON.stringify(complete(STAGING.SHOPIFY_WEBHOOK_CALLBACK_URL)), {
      status: 200, headers: { 'Content-Type': 'application/json',
        Link: '<https://edenmish-fixture-sandbox.myshopify.com/admin/api/2026-04/webhooks.json?page_info=fixture>; rel="next"' },
    });
    return response({ webhooks: [{ topic: 'orders/paid', address: PRODUCTION.SHOPIFY_WEBHOOK_CALLBACK_URL }] });
  } });
  assert.equal((await registrar.ensure({ ...STAGING, SHOPIFY_WEBHOOK_REGISTRATION: 'create' }, { allowCreate: true })).ready, false);
  assert.ok(methods.every(method => method === 'GET'));
});

test('in-flight config change stops subsequent creation and does not trust old response', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const methods = [];
  const registrar = createShopifyWebhookRegistrar({ logger, fetchFn: async (_url, options = {}) => {
    methods.push(options.method || 'GET');
    if (!options.method) return response({ webhooks: [] });
    await gate;
    return response({ webhook: JSON.parse(options.body).webhook });
  } });
  const first = registrar.ensure({ ...STAGING, SHOPIFY_WEBHOOK_REGISTRATION: 'create' }, { allowCreate: true });
  // Let list decoding complete and the first create request begin.
  for (let attempt = 0; attempt < 20 && methods.length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
  if (methods.length < 2) { release(); assert.fail('first mocked create did not start'); }
  const changed = await registrar.ensure(PRODUCTION);
  release();
  assert.equal(changed.ready, false);
  assert.equal((await first).ready, false);
  assert.deepEqual(methods, ['GET', 'POST']);
});
