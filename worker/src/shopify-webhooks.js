export const REQUIRED_SHOPIFY_WEBHOOK_TOPICS = Object.freeze([
  'orders/paid',
  'orders/updated',
  'refunds/create',
]);

const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_RECHECK_MS = 6 * 60 * 60 * 1000;
const PRODUCTION_SHOPS = new Set(['edenmish.myshopify.com', 'r013gt-fc.myshopify.com']);
const PRODUCTION_CALLBACKS = new Set([
  'https://find.edenmish.com/webhooks/shopify',
  'https://ops.edenmish.com/webhooks/shopify',
]);
const STAGING_CALLBACK = 'https://ops-staging.edenmish.com/webhooks/shopify';

function registrationConfig(env, allowCreate) {
  const shop = env.SHOPIFY_SHOP;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) return { error: 'missing_shopify_configuration' };
  const environment = env.SHOPIFY_WEBHOOK_ENVIRONMENT;
  const address = env.SHOPIFY_WEBHOOK_CALLBACK_URL;
  const mode = env.SHOPIFY_WEBHOOK_REGISTRATION || 'verify';
  if (!['production', 'staging'].includes(environment)
    || !['verify', 'create'].includes(mode)
    || typeof shop !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop)
    || env.SHOPIFY_WEBHOOK_EXPECTED_SHOP !== shop
    || typeof token !== 'string' || !token.trim()
    || typeof address !== 'string'
    || (environment === 'production' ? !PRODUCTION_SHOPS.has(shop) || !PRODUCTION_CALLBACKS.has(address)
      : PRODUCTION_SHOPS.has(shop) || address !== STAGING_CALLBACK)) {
    return { error: 'invalid_shopify_webhook_configuration' };
  }
  if (env.BOOKING_URL && !(
    environment === 'production'
      ? ['https://edenmish.com', 'https://www.edenmish.com'].includes(env.BOOKING_URL)
      : env.BOOKING_URL === 'https://staging.edenmish.com'
  )) return { error: 'invalid_shopify_webhook_configuration' };
  const version = env.SHOPIFY_API_VERSION || '2026-04';
  if (!/^20\d{2}-(01|04|07|10)$/.test(version)) return { error: 'invalid_shopify_webhook_configuration' };
  return {
    shop, token, environment, address, version, mode,
    canCreate: mode === 'create' && (environment === 'production' || allowCreate === true),
    accepts: environment === 'production' ? value => PRODUCTION_CALLBACKS.has(value) : value => value === address,
  };
}

const safeJson = async (response) => {
  try { return await response.json(); } catch { return null; }
};

const publicState = (state) => ({
  status: state.status,
  ready: state.ready,
  required_topics: [...REQUIRED_SHOPIFY_WEBHOOK_TOPICS],
  missing_topics: [...state.missingTopics],
  last_attempt_at: state.lastAttemptAt,
  last_success_at: state.lastSuccessAt,
  next_retry_at: state.nextRetryAt,
  error: state.error ? { ...state.error } : null,
});

export function createShopifyWebhookRegistrar(options = {}) {
  // Resolve the runtime fetch lazily so tests and Worker-compatible runtimes can
  // replace it without the registrar retaining a stale function reference.
  const fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));
  const now = options.now || Date.now;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
  const logger = options.logger || console;
  let state = {
    status: 'idle',
    ready: false,
    missingTopics: [...REQUIRED_SHOPIFY_WEBHOOK_TOPICS],
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRetryAt: null,
    error: null,
  };
  let inFlight = null;
  let contextKey = null;
  let generation = 0;

  const fail = (attemptedAt, missingTopics, error) => {
    state = {
      ...state,
      status: 'degraded',
      ready: false,
      missingTopics: [...missingTopics],
      lastAttemptAt: attemptedAt,
      nextRetryAt: attemptedAt + retryMs,
      error,
    };
    logger.error('shopify_webhook_registration_failed', error);
    return publicState(state);
  };

  async function run(config) {
    const runGeneration = generation;
    const current = () => runGeneration === generation;
    const reject = (...args) => current() ? fail(...args) : publicState(state);
    const attemptedAt = now();
    const { shop, token, version } = config;
    const endpoint = `https://${shop}/admin/api/${version}/webhooks.json`;
    state = { ...state, status: 'checking', lastAttemptAt: attemptedAt, error: null };

    let listResponse;
    try {
      listResponse = await fetchFn(endpoint, {
        headers: { 'X-Shopify-Access-Token': token },
        redirect: 'error',
      });
    } catch {
      return reject(attemptedAt, REQUIRED_SHOPIFY_WEBHOOK_TOPICS, { code: 'list_network_error' });
    }

    const listPayload = await safeJson(listResponse);
    if (!current()) return publicState(state);
    if (!listResponse.ok || !Array.isArray(listPayload && listPayload.webhooks)) {
      return reject(attemptedAt, REQUIRED_SHOPIFY_WEBHOOK_TOPICS, {
        code: listResponse.ok ? 'list_invalid_response' : 'list_http_error',
        http_status: listResponse.status,
      });
    }

    if (listResponse.headers?.get('Link')?.includes('rel="next"')) {
      return reject(attemptedAt, REQUIRED_SHOPIFY_WEBHOOK_TOPICS, { code: 'subscription_list_incomplete' });
    }
    // Never rewrite/delete subscriptions. Wrong destinations require an operator
    // decision even when a correct subscription also exists for the same topic.
    const relevant = listPayload.webhooks.filter(webhook => REQUIRED_SHOPIFY_WEBHOOK_TOPICS.includes(webhook?.topic));
    if (relevant.some(webhook => !config.accepts(webhook.address))) {
      return reject(attemptedAt, REQUIRED_SHOPIFY_WEBHOOK_TOPICS, { code: 'callback_destination_conflict' });
    }
    const existing = new Set(relevant.map(webhook => webhook.topic));
    const initiallyMissing = REQUIRED_SHOPIFY_WEBHOOK_TOPICS.filter(topic => !existing.has(topic));
    if (initiallyMissing.length && !config.canCreate) {
      return reject(attemptedAt, initiallyMissing, { code: 'registration_not_authorized' });
    }
    const createErrors = [];

    for (const topic of REQUIRED_SHOPIFY_WEBHOOK_TOPICS) {
      if (!current()) return publicState(state);
      if (existing.has(topic)) continue;
      let createResponse;
      try {
        createResponse = await fetchFn(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ webhook: { topic, address: config.address, format: 'json' } }),
        });
      } catch {
        createErrors.push({ topic, code: 'create_network_error' });
        continue;
      }

      const createPayload = await safeJson(createResponse);
      if (!current()) return publicState(state);
      if (!createResponse.ok || !createPayload || createPayload.webhook?.topic !== topic
        || createPayload.webhook?.address !== config.address) {
        createErrors.push({
          topic,
          code: createResponse.ok ? 'create_invalid_response' : 'create_http_error',
          http_status: createResponse.status,
        });
        continue;
      }
      existing.add(topic);
      logger.log('shopify_webhook_registered', { topic, address: config.address });
    }

    if (!current()) return publicState(state);
    const missingTopics = REQUIRED_SHOPIFY_WEBHOOK_TOPICS.filter((topic) => !existing.has(topic));
    if (createErrors.length || missingTopics.length) {
      return reject(attemptedAt, missingTopics, {
        code: 'create_failed',
        topics: createErrors,
      });
    }

    state = {
      status: 'ready',
      ready: true,
      missingTopics: [],
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
      nextRetryAt: attemptedAt + recheckMs,
      error: null,
    };
    return publicState(state);
  }

  return {
    ensure(env, { force = false, allowCreate = false } = {}) {
      // Validate before consulting cached readiness. Credentials and creation
      // authority are part of the private cache identity; never log this key.
      const config = registrationConfig(env, allowCreate);
      if (config.error) {
        generation++;
        contextKey = null;
        state = { status: 'unconfigured', ready: false, missingTopics: [...REQUIRED_SHOPIFY_WEBHOOK_TOPICS],
          lastAttemptAt: null, lastSuccessAt: null, nextRetryAt: null, error: { code: config.error } };
        return Promise.resolve(publicState(state));
      }
      const key = JSON.stringify([config.environment, config.shop, config.address, config.version,
        config.mode, config.canCreate, config.token]);
      if (inFlight) {
        if (key === contextKey) return inFlight;
        generation++;
        contextKey = null;
        state = { status: 'degraded', ready: false, missingTopics: [...REQUIRED_SHOPIFY_WEBHOOK_TOPICS],
          lastAttemptAt: null, lastSuccessAt: null, nextRetryAt: null, error: { code: 'configuration_in_flight' } };
        return Promise.resolve(publicState(state));
      }
      if (contextKey !== key) {
        contextKey = key;
        state = { status: 'idle', ready: false, missingTopics: [...REQUIRED_SHOPIFY_WEBHOOK_TOPICS],
          lastAttemptAt: null, lastSuccessAt: null, nextRetryAt: null, error: null };
      }
      const currentTime = now();
      if (!force && state.nextRetryAt && currentTime < state.nextRetryAt) return Promise.resolve(publicState(state));
      // Snapshot approved values: later mutation of env cannot redirect this run.
      inFlight = run(config).finally(() => { inFlight = null; });
      return inFlight;
    },
    status() {
      return publicState(state);
    },
  };
}

export const shopifyWebhookRegistrar = createShopifyWebhookRegistrar();
