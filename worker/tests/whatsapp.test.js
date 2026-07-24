import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import {
  WHATSAPP_GRAPH_API_VERSION,
  applyWhatsAppDeliveryReceipt,
  extractWhatsAppDeliveryReceipts,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
} from '../src/whatsapp.js';

const hex = (buffer) => [...new Uint8Array(buffer)]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function signature(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return `sha256=${hex(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  ))}`;
}

class ReceiptDb {
  constructor(withOutbox = false) {
    this.notification = {
      id: 1,
      channel: 'whatsapp',
      provider_ref: 'wamid.audit-1',
      status: 'sent',
      provider_status: 'accepted',
      provider_updated_at: 1_000,
      error: null,
    };
    this.outbox = withOutbox ? {
      id: 2,
      channel: 'whatsapp',
      provider_ref: 'wamid.audit-1',
      state: 'sent',
      provider_status: 'accepted',
      provider_updated_at: null,
      last_error: null,
    } : null;
    this.notificationReadOverride = null;
    this.updates = 0;
  }

  prepare(sql) {
    const db = this;
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async first() {
        if (normalized.startsWith('SELECT id, state AS status, provider_status')) {
          return db.outbox?.provider_ref === this.args[0]
            ? {
              id: db.outbox.id,
              status: db.outbox.state,
              provider_status: db.outbox.provider_status,
              provider_updated_at: db.outbox.provider_updated_at,
            }
            : null;
        }
        if (!normalized.startsWith('SELECT id, status, provider_status')) return null;
        return db.notification.provider_ref === this.args[0]
          ? { ...(db.notificationReadOverride || db.notification) }
          : null;
      },
      async run() {
        if (normalized.startsWith('UPDATE delivery_notification_outbox SET state')) {
          const [
            state,
            providerStatus,
            providerUpdatedAt,
            error,
            _updatedAt,
            id,
            maximumCurrentTimestamp,
            incomingRank,
            incomingStatus,
          ] = this.args;
          const ranks = {
            accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4,
          };
          const currentRank = ranks[db.outbox?.provider_status] ?? -1;
          if (
            !db.outbox
            || db.outbox.id !== id
            || (
              db.outbox.provider_updated_at != null
              && db.outbox.provider_updated_at > maximumCurrentTimestamp
            )
            || currentRank > incomingRank
            || (incomingStatus === 'failed' && currentRank >= 2)
          ) return { meta: { changes: 0 } };
          Object.assign(db.outbox, {
            state,
            provider_status: providerStatus,
            provider_updated_at: providerUpdatedAt,
            last_error: error,
          });
          db.updates += 1;
          return { meta: { changes: 1 } };
        }
        if (!normalized.startsWith('UPDATE notifications SET status')) {
          return { meta: { changes: 0 } };
        }
        const [
          status,
          providerStatus,
          providerUpdatedAt,
          error,
          _updatedAt,
          id,
          maximumCurrentTimestamp,
          incomingRank,
          incomingStatus,
        ] = this.args;
        const ranks = {
          accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4,
        };
        const currentRank = ranks[db.notification.provider_status] ?? -1;
        if (
          db.notification.id !== id
          || (
            db.notification.provider_updated_at != null
            && db.notification.provider_updated_at > maximumCurrentTimestamp
          )
          || currentRank > incomingRank
          || (incomingStatus === 'failed' && currentRank >= 2)
        ) return { meta: { changes: 0 } };
        Object.assign(db.notification, {
          status,
          provider_status: providerStatus,
          provider_updated_at: providerUpdatedAt,
          error,
        });
        db.updates += 1;
        return { meta: { changes: 1 } };
      },
    };
  }
}

describe('WhatsApp provider boundary', () => {
  test('pins the verified Graph API version', () => {
    assert.equal(WHATSAPP_GRAPH_API_VERSION, 'v25.0');
  });

  test('verifies webhook challenges and HMAC signatures fail closed', async () => {
    const env = { WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token' };
    const validUrl = new URL(
      'https://find.edenmish.com/webhooks/whatsapp'
      + '?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-1',
    );
    assert.equal(verifyWhatsAppWebhookChallenge(env, validUrl), 'challenge-1');
    validUrl.searchParams.set('hub.verify_token', 'wrong');
    assert.equal(verifyWhatsAppWebhookChallenge(env, validUrl), null);

    const body = '{"object":"whatsapp_business_account"}';
    const signed = await signature('app-secret', body);
    assert.equal(
      await verifyWhatsAppWebhookSignature('app-secret', body, signed),
      true,
    );
    assert.equal(
      await verifyWhatsAppWebhookSignature('app-secret', `${body} `, signed),
      false,
    );
    assert.equal(await verifyWhatsAppWebhookSignature('', body, signed), false);
  });

  test('extracts only sanitized receipt metadata and applies it idempotently', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            contacts: [{ profile: { name: 'Must not persist' }, wa_id: '972500000000' }],
            statuses: [{
              id: 'wamid.audit-1',
              status: 'delivered',
              timestamp: '2',
              recipient_id: '972500000000',
              conversation: { id: 'customer-conversation' },
            }],
          },
        }],
      }],
    };
    const receipts = extractWhatsAppDeliveryReceipts(payload, 9_999);
    assert.deepEqual(receipts, [{
      providerRef: 'wamid.audit-1',
      providerStatus: 'delivered',
      providerUpdatedAt: 2_000,
      providerErrorCode: null,
    }]);
    assert.doesNotMatch(JSON.stringify(receipts), /Must not persist|972500000000|conversation/);

    const DB = new ReceiptDb();
    assert.deepEqual(await applyWhatsAppDeliveryReceipt(DB, receipts[0]), {
      matched: true,
      updated: true,
    });
    assert.deepEqual(await applyWhatsAppDeliveryReceipt(DB, receipts[0]), {
      matched: true,
      updated: false,
    });
    assert.equal(DB.updates, 1);

    const stale = { ...receipts[0], providerStatus: 'sent', providerUpdatedAt: 1_500 };
    assert.deepEqual(await applyWhatsAppDeliveryReceipt(DB, stale), {
      matched: true,
      updated: false,
    });
    assert.equal(DB.notification.provider_status, 'delivered');

    const failed = {
      ...receipts[0],
      providerStatus: 'failed',
      providerUpdatedAt: 3_000,
      providerErrorCode: '131047',
    };
    const failedDB = new ReceiptDb();
    assert.deepEqual(await applyWhatsAppDeliveryReceipt(failedDB, failed), {
      matched: true,
      updated: true,
    });
    assert.equal(failedDB.notification.status, 'failed');
    assert.equal(failedDB.notification.error, 'provider_code_131047');
    assert.deepEqual(await applyWhatsAppDeliveryReceipt(DB, failed), {
      matched: true,
      updated: false,
    }, 'a late contradictory failure must not regress a delivered message');

    const concurrent = new ReceiptDb();
    concurrent.notification.provider_status = 'delivered';
    concurrent.notification.provider_updated_at = 2_000;
    concurrent.notificationReadOverride = {
      ...concurrent.notification,
      provider_status: 'accepted',
      provider_updated_at: 1_000,
    };
    assert.deepEqual(await applyWhatsAppDeliveryReceipt(concurrent, {
      ...receipts[0],
      providerStatus: 'sent',
      providerUpdatedAt: 2_000,
    }), {
      matched: true,
      updated: false,
    }, 'the SQL rank guard must reject an equal-timestamp stale write');
    assert.equal(concurrent.notification.provider_status, 'delivered');
  });

  test('signed receipt endpoint is idempotent and rejects unsigned payloads', async () => {
    const DB = new ReceiptDb(true);
    const payload = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: 'wamid.audit-1',
              status: 'read',
              timestamp: '4',
            }],
          },
        }],
      }],
    });
    const env = { DB, WHATSAPP_APP_SECRET: 'app-secret' };
    const makeRequest = async (header) => new Request(
      'https://find.edenmish.com/webhooks/whatsapp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(header ? { 'X-Hub-Signature-256': header } : {}),
        },
        body: payload,
      },
    );

    let response = await worker.fetch(await makeRequest(null), env);
    assert.equal(response.status, 401);
    assert.equal(DB.updates, 0);

    const signed = await signature('app-secret', payload);
    response = await worker.fetch(await makeRequest(signed), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, matched: 1, updated: 1 });
    assert.equal(DB.outbox.provider_status, 'read');
    assert.equal(DB.outbox.state, 'sent');

    response = await worker.fetch(await makeRequest(signed), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, matched: 1, updated: 0 });
  });
});
