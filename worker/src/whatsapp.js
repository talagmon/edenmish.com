// Privacy-safe WhatsApp Cloud API boundary.
//
// Proactive messages are approved templates only. The two supported message
// classes deliberately have zero dynamic components, so customer/order data
// never enters the provider payload.

export const WHATSAPP_GRAPH_API_VERSION = 'v25.0';

export const WHATSAPP_MESSAGE_CLASSES = Object.freeze({
  customerDeliverySummary: 'customer_delivery_summary',
  opsPaymentReceived: 'ops_payment_received',
});

const MESSAGE_CLASS_CONFIG = Object.freeze({
  [WHATSAPP_MESSAGE_CLASSES.customerDeliverySummary]: Object.freeze({
    templateKey: 'WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE',
    languageKey: 'WHATSAPP_CUSTOMER_TEMPLATE_LANGUAGE',
    recipient: 'customer',
  }),
  [WHATSAPP_MESSAGE_CLASSES.opsPaymentReceived]: Object.freeze({
    templateKey: 'WHATSAPP_OPS_PAYMENT_TEMPLATE',
    languageKey: 'WHATSAPP_OPS_TEMPLATE_LANGUAGE',
    recipient: 'operations',
  }),
});

const PROVIDER_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
const PROVIDER_STATUS_RANK = Object.freeze({
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
});
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE_CODE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
const PHONE_NUMBER = /^\d{8,15}$/;
const PROVIDER_REFERENCE = /^[A-Za-z0-9._:-]{1,200}$/;

const digits = (value) => String(value || '').replace(/\D/g, '');
const safeProviderReference = (value) => {
  const reference = String(value || '');
  return PROVIDER_REFERENCE.test(reference) ? reference : null;
};
const safeProviderErrorCode = (value) => {
  const code = Number(value);
  return Number.isSafeInteger(code) && code >= 0 ? String(code).slice(0, 20) : null;
};

export function resolveWhatsAppMessage(env, messageClass, customerRecipient = null) {
  const definition = MESSAGE_CLASS_CONFIG[messageClass];
  if (!definition) {
    return { ok: false, skipped: true, permanent: true, error: 'unsupported_message_class' };
  }
  if (!env?.WHATSAPP_TOKEN || !env?.WHATSAPP_PHONE_ID) {
    return { ok: false, skipped: true, permanent: true, error: 'whatsapp_transport_unconfigured' };
  }
  const templateName = String(env[definition.templateKey] || '');
  const languageCode = String(env[definition.languageKey] || '');
  if (!TEMPLATE_NAME.test(templateName) || !LANGUAGE_CODE.test(languageCode)) {
    return { ok: false, skipped: true, permanent: true, error: 'whatsapp_message_class_unconfigured' };
  }
  const rawRecipient = definition.recipient === 'operations'
    ? env.WHATSAPP_OPS_RECIPIENT
    : customerRecipient;
  const recipient = digits(rawRecipient);
  if (!PHONE_NUMBER.test(recipient)) {
    return { ok: false, skipped: true, permanent: true, error: 'whatsapp_recipient_unconfigured' };
  }
  return {
    ok: true,
    messageClass,
    recipient,
    templateName,
    languageCode,
    components: [],
  };
}

export async function sendWhatsAppTemplate(env, message, fetchImpl = globalThis.fetch) {
  if (!message?.recipient || !message?.templateName || !message?.languageCode) {
    return { ok: false, permanent: true, error: 'invalid_template_message' };
  }
  if (!Array.isArray(message.components) || message.components.length !== 0) {
    return { ok: false, permanent: true, error: 'template_components_not_permitted' };
  }
  const body = {
    messaging_product: 'whatsapp',
    to: message.recipient,
    type: 'template',
    template: {
      name: message.templateName,
      language: { code: message.languageCode },
      components: [],
    },
  };

  let response;
  try {
    response = await fetchImpl(
      `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return { ok: false, error: 'provider_unreachable' };
  }

  let payload = null;
  try { payload = await response.json(); } catch {}
  if (response.ok) {
    const providerRef = safeProviderReference(payload?.messages?.[0]?.id);
    if (!providerRef) return { ok: false, error: 'provider_reference_missing' };
    return { ok: true, providerRef, providerStatus: 'accepted' };
  }

  const providerCode = safeProviderErrorCode(payload?.error?.code);
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return {
    ok: false,
    permanent: !retryable,
    error: providerCode
      ? `provider_http_${response.status}_code_${providerCode}`
      : `provider_http_${response.status}`,
  };
}

const bytesToHex = (bytes) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const equalText = (left, right) => {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
};

export async function verifyWhatsAppWebhookSignature(appSecret, rawBody, signature) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(signature || ''));
  if (!appSecret || !match) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(appSecret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(String(rawBody || '')),
  );
  return equalText(bytesToHex(digest), match[1].toLowerCase());
}

export function verifyWhatsAppWebhookChallenge(env, url) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (
    mode !== 'subscribe'
    || !env?.WHATSAPP_WEBHOOK_VERIFY_TOKEN
    || !equalText(token, env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
    || !/^[A-Za-z0-9._-]{1,500}$/.test(String(challenge || ''))
  ) return null;
  return challenge;
}

export function extractWhatsAppDeliveryReceipts(payload, receivedAt = Date.now()) {
  const receipts = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      for (const status of Array.isArray(change?.value?.statuses)
        ? change.value.statuses : []) {
        const providerRef = safeProviderReference(status?.id);
        const providerStatus = String(status?.status || '').toLowerCase();
        if (!providerRef || !PROVIDER_STATUSES.has(providerStatus)) continue;
        const seconds = Number(status?.timestamp);
        const providerUpdatedAt = Number.isSafeInteger(seconds)
          && seconds > 0
          && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
          ? seconds * 1000
          : receivedAt;
        receipts.push({
          providerRef,
          providerStatus,
          providerUpdatedAt,
          providerErrorCode: providerStatus === 'failed'
            ? safeProviderErrorCode(status?.errors?.[0]?.code)
            : null,
        });
      }
    }
  }
  return receipts;
}

export async function applyWhatsAppDeliveryReceipt(DB, receipt) {
  const outbox = await DB.prepare(`SELECT id, state AS status, provider_status,
      provider_updated_at
    FROM delivery_notification_outbox
    WHERE channel = 'whatsapp' AND provider_ref = ? LIMIT 1`)
    .bind(receipt.providerRef).first();
  const notification = await DB.prepare(`SELECT id, status, provider_status, provider_updated_at
    FROM notifications
    WHERE channel = 'whatsapp' AND provider_ref = ? LIMIT 1`)
    .bind(receipt.providerRef).first();
  const targets = [
    ['delivery_notification_outbox', outbox],
    ['notifications', notification],
  ].filter(([, current]) => !!current);
  if (!targets.length) return { matched: false, updated: false };
  const error = receipt.providerErrorCode
    ? `provider_code_${receipt.providerErrorCode}`
    : null;
  let updated = false;

  for (const [table, current] of targets) {
    const currentRank = PROVIDER_STATUS_RANK[current.provider_status] ?? -1;
    const incomingRank = PROVIDER_STATUS_RANK[receipt.providerStatus];
    const alreadyCurrent = current.provider_status === receipt.providerStatus
      && Number(current.provider_updated_at || 0) >= receipt.providerUpdatedAt;
    const staleTimestamp = current.provider_updated_at != null
      && Number(current.provider_updated_at) > receipt.providerUpdatedAt;
    const backwardStatus = incomingRank < currentRank;
    const impossibleLateFailure = receipt.providerStatus === 'failed' && currentRank >= 2;
    if (alreadyCurrent || staleTimestamp || backwardStatus || impossibleLateFailure) continue;

    let result;
    if (table === 'delivery_notification_outbox') {
      const state = receipt.providerStatus === 'failed' ? 'dead' : current.status;
      result = await DB.prepare(`UPDATE delivery_notification_outbox
        SET state = ?, provider_status = ?, provider_updated_at = ?,
            last_error = ?, updated_at = ?
        WHERE id = ? AND (
          provider_updated_at IS NULL OR provider_updated_at <= ?
        )`).bind(
        state,
        receipt.providerStatus,
        receipt.providerUpdatedAt,
        error,
        Date.now(),
        current.id,
        receipt.providerUpdatedAt,
      ).run();
    } else {
      const status = receipt.providerStatus === 'failed' ? 'failed' : current.status;
      result = await DB.prepare(`UPDATE notifications
        SET status = ?, provider_status = ?, provider_updated_at = ?,
            error = ?, updated_at = ?
        WHERE id = ? AND (
          provider_updated_at IS NULL OR provider_updated_at <= ?
        )`).bind(
        status,
        receipt.providerStatus,
        receipt.providerUpdatedAt,
        error,
        Date.now(),
        current.id,
        receipt.providerUpdatedAt,
      ).run();
    }
    updated = updated || !!result?.meta?.changes;
  }
  return { matched: true, updated };
}
