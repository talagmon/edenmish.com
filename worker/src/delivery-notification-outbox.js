import { getOrderById } from './db.js';
import { notifyEmail, notifyWhatsApp } from './notify.js';

const TEMPLATE = 'customer_delivery_summary';
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 60_000;

const safeError = (error) => String(error?.message || error || 'delivery_failed')
  .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

export function deliveryCompletionTransitionStatement(
  DB, orderId, eventId, driverId, correlationId, now,
) {
  return DB.prepare(`INSERT OR IGNORE INTO delivery_completion_transitions
    (order_id, event_id, created_at)
    SELECT ?, ?, ? FROM orders
    WHERE id = ? AND status = 'to_dropoff'
      AND EXISTS (SELECT 1 FROM driver_execution_events
        WHERE event_id = ? AND driver_id = ? AND correlation_id = ?)`)
    .bind(orderId, eventId, now, orderId, eventId, driverId, correlationId);
}

export function deliveryNotificationOutboxStatements(DB, order, eventId, now, {
  sendWhatsApp = false,
} = {}) {
  const channels = [];
  if (order?.email) channels.push('email');
  if (sendWhatsApp && order?.phone) channels.push('whatsapp');
  return channels.map((channel) => DB.prepare(`INSERT OR IGNORE INTO delivery_notification_outbox
    (order_id, transition, event_id, channel, template, state, attempt_count,
     next_attempt_at, created_at, updated_at)
    SELECT ?, 'delivered', ?, ?, ?, 'pending', 0, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM delivery_completion_transitions
      WHERE order_id = ? AND event_id = ?
    )`).bind(
    order.id, eventId, channel, TEMPLATE, now, now, now, order.id, eventId,
  ));
}

export async function persistOpsDeliveryCompletion(DB, order, {
  eventId = `ops-delivered-${order.id}`,
  now = Date.now(),
  deliveredAt = now,
  paymentStatus = order.payment_method === 'wallet' ? 'wallet_paid' : 'paid',
  sendWhatsApp = false,
} = {}) {
  const transition = DB.prepare(`INSERT OR IGNORE INTO delivery_completion_transitions
    (order_id, event_id, created_at)
    SELECT ?, ?, ? FROM orders
    WHERE id = ? AND status = 'to_dropoff'`)
    .bind(order.id, eventId, now, order.id);
  const updateOrder = DB.prepare(`UPDATE orders
    SET status = 'delivered', delivered_at = ?, payment_status = ?
    WHERE id = ? AND status = 'to_dropoff'
      AND EXISTS (SELECT 1 FROM delivery_completion_transitions
        WHERE order_id = ? AND event_id = ?)`)
    .bind(deliveredAt, paymentStatus, order.id, order.id, eventId);
  const addHistory = DB.prepare(`INSERT INTO status_history (order_id, status, at, note)
    SELECT ?, 'delivered', ?, NULL
    WHERE EXISTS (SELECT 1 FROM delivery_completion_transitions
      WHERE order_id = ? AND event_id = ?)
      AND NOT EXISTS (SELECT 1 FROM status_history
        WHERE order_id = ? AND status = 'delivered')`)
    .bind(order.id, now, order.id, eventId, order.id);
  const outbox = deliveryNotificationOutboxStatements(
    DB, order, eventId, now, { sendWhatsApp },
  );
  const results = await DB.batch([transition, updateOrder, addHistory, ...outbox]);
  return {
    eventId,
    transitioned: !!results[0]?.meta?.changes,
  };
}

export async function enqueueDeliveryNotificationJobs(DB, order, {
  eventId = `ops-delivered-${order.id}`,
  now = Date.now(),
  sendWhatsApp = false,
} = {}) {
  const direct = [];
  if (order?.email) direct.push('email');
  if (sendWhatsApp && order?.phone) direct.push('whatsapp');
  if (!direct.length) return [];
  return DB.batch(direct.map((channel) => DB.prepare(`INSERT OR IGNORE INTO delivery_notification_outbox
    (order_id, transition, event_id, channel, template, state, attempt_count,
     next_attempt_at, created_at, updated_at)
    VALUES (?, 'delivered', ?, ?, ?, 'pending', 0, ?, ?, ?)`)
    .bind(order.id, eventId, channel, TEMPLATE, now, now, now)));
}

async function defaultDeliver(env, job, order) {
  if (job.channel === 'email') {
    const { deliverySummaryHtml } = await import('./delivery-completion.js');
    return notifyEmail(env, env.DB, {
      orderId: order.id,
      template: TEMPLATE,
      recipient: order.email,
      subject: 'המשלוח מ-EdenMish נמסר ✓',
      html: deliverySummaryHtml(env, order),
    });
  }
  if (job.channel === 'whatsapp') {
    return notifyWhatsApp(env, env.DB, {
      orderId: order.id,
      template: TEMPLATE,
      recipient: order.phone,
      body: `המשלוח שלך הגיע ✓\n${order.dropoff || ''}\nתודה שבחרת ב-EdenMish!`,
    });
  }
  return { ok: false, error: 'unsupported_channel', permanent: true };
}

export async function processDeliveryNotificationOutbox(env, {
  now = Date.now(),
  limit = DEFAULT_LIMIT,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  leaseMs = DEFAULT_LEASE_MS,
  retryMs = DEFAULT_RETRY_MS,
  deliver = defaultDeliver,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 100));
  const expired = await env.DB.prepare(`UPDATE delivery_notification_outbox
    SET state = 'dead', lease_token = NULL, lease_expires_at = NULL,
        last_error = 'attempt_limit_exhausted', updated_at = ?
    WHERE attempt_count >= ? AND (
      (state = 'pending' AND next_attempt_at <= ?)
      OR (state = 'processing' AND lease_expires_at <= ?)
    )`).bind(now, maxAttempts, now, now).run();
  const rows = await env.DB.prepare(`SELECT id FROM delivery_notification_outbox
    WHERE attempt_count < ? AND (
      (state = 'pending' AND next_attempt_at <= ?)
      OR (state = 'processing' AND lease_expires_at <= ?)
    )
    ORDER BY next_attempt_at, id LIMIT ?`).bind(maxAttempts, now, now, boundedLimit).all();
  const summary = {
    claimed: 0,
    sent: 0,
    retried: 0,
    dead: Number(expired?.meta?.changes || 0),
  };

  for (const candidate of rows.results || []) {
    const leaseToken = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE delivery_notification_outbox
      SET state = 'processing', attempt_count = attempt_count + 1,
          lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND (
        attempt_count < ? AND (
          (state = 'pending' AND next_attempt_at <= ?)
          OR (state = 'processing' AND lease_expires_at <= ?)
        )
      )`).bind(
      leaseToken, now + leaseMs, now, candidate.id, maxAttempts, now, now,
    ).run();
    if (!claimed?.meta?.changes) continue;
    summary.claimed += 1;

    const job = await env.DB.prepare(`SELECT * FROM delivery_notification_outbox
      WHERE id = ? AND lease_token = ?`).bind(candidate.id, leaseToken).first();
    if (!job) continue;
    const order = await getOrderById(env.DB, job.order_id);
    let result;
    try {
      result = order
        ? await deliver(env, job, order)
        : { ok: false, permanent: true, error: 'order_missing' };
    } catch (error) {
      result = { ok: false, error: safeError(error) };
    }

    if (result?.ok) {
      const sent = await env.DB.prepare(`UPDATE delivery_notification_outbox
        SET state = 'sent', sent_at = ?, lease_token = NULL,
            lease_expires_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ?`).bind(now, now, job.id, leaseToken).run();
      if (sent?.meta?.changes) summary.sent += 1;
      continue;
    }

    const exhausted = result?.permanent || Number(job.attempt_count) >= maxAttempts;
    const error = safeError(result?.error || (result?.skipped ? 'provider_unconfigured' : 'send_failed'));
    const nextAttemptAt = now + retryMs * (2 ** Math.max(0, Number(job.attempt_count) - 1));
    const failed = await env.DB.prepare(`UPDATE delivery_notification_outbox
      SET state = ?, next_attempt_at = ?, lease_token = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`).bind(
      exhausted ? 'dead' : 'pending', nextAttemptAt, error, now, job.id, leaseToken,
    ).run();
    if (failed?.meta?.changes) summary[exhausted ? 'dead' : 'retried'] += 1;
  }
  return summary;
}

export const deliveryNotificationOutboxPolicy = Object.freeze({
  template: TEMPLATE,
  defaultLimit: DEFAULT_LIMIT,
  defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  defaultLeaseMs: DEFAULT_LEASE_MS,
  defaultRetryMs: DEFAULT_RETRY_MS,
  semantics: 'at-least-once',
});
