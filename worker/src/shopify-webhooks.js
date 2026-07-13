export const REQUIRED_SHOPIFY_WEBHOOK_TOPICS = Object.freeze([
  'orders/paid',
  'orders/updated',
  'refunds/create',
]);

const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_RECHECK_MS = 6 * 60 * 60 * 1000;
const WEBHOOK_ADDRESS = 'https://find.edenmish.com/webhooks/shopify';

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

  async function run(env) {
    const attemptedAt = now();
    const shop = String(env.SHOPIFY_SHOP || '').trim();
    const token = String(env.SHOPIFY_ADMIN_TOKEN || '').trim();
    if (!shop || !token) {
      state = {
        ...state,
        status: 'unconfigured',
        ready: false,
        missingTopics: [...REQUIRED_SHOPIFY_WEBHOOK_TOPICS],
        lastAttemptAt: attemptedAt,
        nextRetryAt: null,
        error: { code: 'missing_shopify_configuration' },
      };
      return publicState(state);
    }

    const version = env.SHOPIFY_API_VERSION || '2024-10';
    const endpoint = `https://${shop}/admin/api/${version}/webhooks.json`;
    state = { ...state, status: 'checking', lastAttemptAt: attemptedAt, error: null };

    let listResponse;
    try {
      listResponse = await fetchFn(endpoint, {
        headers: { 'X-Shopify-Access-Token': token },
      });
    } catch {
      return fail(attemptedAt, REQUIRED_SHOPIFY_WEBHOOK_TOPICS, { code: 'list_network_error' });
    }

    const listPayload = await safeJson(listResponse);
    if (!listResponse.ok || !Array.isArray(listPayload && listPayload.webhooks)) {
      return fail(attemptedAt, REQUIRED_SHOPIFY_WEBHOOK_TOPICS, {
        code: listResponse.ok ? 'list_invalid_response' : 'list_http_error',
        http_status: listResponse.status,
      });
    }

    const existing = new Set(listPayload.webhooks
      .filter((webhook) => String(webhook.address || '').includes('/webhooks/shopify'))
      .map((webhook) => webhook.topic));
    const createErrors = [];

    for (const topic of REQUIRED_SHOPIFY_WEBHOOK_TOPICS) {
      if (existing.has(topic)) continue;
      let createResponse;
      try {
        createResponse = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ webhook: { topic, address: WEBHOOK_ADDRESS, format: 'json' } }),
        });
      } catch {
        createErrors.push({ topic, code: 'create_network_error' });
        continue;
      }

      const createPayload = await safeJson(createResponse);
      if (!createResponse.ok || !createPayload || !createPayload.webhook) {
        createErrors.push({
          topic,
          code: createResponse.ok ? 'create_invalid_response' : 'create_http_error',
          http_status: createResponse.status,
        });
        continue;
      }
      existing.add(topic);
      logger.log('shopify_webhook_registered', { topic, address: WEBHOOK_ADDRESS });
    }

    const missingTopics = REQUIRED_SHOPIFY_WEBHOOK_TOPICS.filter((topic) => !existing.has(topic));
    if (createErrors.length || missingTopics.length) {
      return fail(attemptedAt, missingTopics, {
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
    ensure(env, { force = false } = {}) {
      const currentTime = now();
      if (!force && state.nextRetryAt && currentTime < state.nextRetryAt) {
        return Promise.resolve(publicState(state));
      }
      if (inFlight) return inFlight;
      inFlight = run(env).finally(() => { inFlight = null; });
      return inFlight;
    },
    status() {
      return publicState(state);
    },
  };
}

export const shopifyWebhookRegistrar = createShopifyWebhookRegistrar();
