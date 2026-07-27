import { getOrderById } from './db.js';
import { notifyEmail, notifyWhatsApp } from './notify.js';
import { WHATSAPP_MESSAGE_CLASSES } from './whatsapp.js';

const DELIVERED_TEMPLATE = 'customer_delivery_summary';
const OPS_PAYMENT_TEMPLATE = 'ops_payment_received';
const RETAINED_FAILURE_TEMPLATES = Object.freeze({
  return_to_origin: 'customer_delivery_failed_returning',
  hold_for_redelivery: 'customer_delivery_failed_redelivery_hold',
});
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

export function deliveryNotificationOutboxStatements(DB, order, eventId, now) {
  const channels = [];
  if (order?.email) channels.push('email');
  if (order?.phone_delivery_link_opt_in && order?.phone) channels.push('whatsapp');
  return channels.map((channel) => DB.prepare(`INSERT OR IGNORE INTO delivery_notification_outbox
    (order_id, transition, event_id, channel, template, state, attempt_count,
     next_attempt_at, created_at, updated_at)
    SELECT ?, 'delivered', ?, ?, ?, 'pending', 0, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM delivery_completion_transitions
      WHERE order_id = ? AND event_id = ?
    )`).bind(
    order.id, eventId, channel, DELIVERED_TEMPLATE, now, now, now, order.id, eventId,
  ));
}

export function retainedFailureNotificationOutboxStatements(
  DB, order, eventId, disposition, now,
) {
  const template = RETAINED_FAILURE_TEMPLATES[disposition];
  if (!order?.email || !template) return [];
  return [DB.prepare(`INSERT OR IGNORE INTO delivery_notification_outbox
    (order_id, transition, event_id, channel, template, state, attempt_count,
     next_attempt_at, created_at, updated_at)
    SELECT ?, 'delivery_failed_retained', ?, 'email', ?, 'pending', 0, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM driver_execution_events
      WHERE event_id = ? AND order_id = ?
        AND event_type = 'delivery_failed' AND status = 'accepted'
    )
      AND EXISTS (
        SELECT 1 FROM orders
        WHERE id = ? AND status = 'failed' AND retained_by_driver = ?
      )`).bind(
    order.id, eventId, template, now, now, now,
    eventId, order.id, order.id, disposition,
  )];
}

export async function persistOpsDeliveryCompletion(DB, order, {
  eventId = `ops-delivered-${order.id}`,
  now = Date.now(),
  deliveredAt = now,
  paymentStatus = order.payment_method === 'wallet' ? 'wallet_paid' : 'paid',
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
  const outbox = deliveryNotificationOutboxStatements(DB, order, eventId, now);
  const results = await DB.batch([transition, updateOrder, addHistory, ...outbox]);
  return {
    eventId,
    transitioned: !!results[0]?.meta?.changes,
  };
}

export async function enqueueDeliveryNotificationJobs(DB, order, {
  eventId = `ops-delivered-${order.id}`,
  now = Date.now(),
} = {}) {
  const direct = [];
  if (order?.email) direct.push('email');
  if (order?.phone_delivery_link_opt_in && order?.phone) direct.push('whatsapp');
  if (!direct.length) return [];
  return DB.batch(direct.map((channel) => DB.prepare(`INSERT OR IGNORE INTO delivery_notification_outbox
    (order_id, transition, event_id, channel, template, state, attempt_count,
     next_attempt_at, created_at, updated_at)
    VALUES (?, 'delivered', ?, ?, ?, 'pending', 0, ?, ?, ?)`)
    .bind(order.id, eventId, channel, DELIVERED_TEMPLATE, now, now, now)));
}

export async function enqueueOpsPaymentWhatsAppJob(DB, orderId, {
  eventId = `payment-received-${orderId}`,
  now = Date.now(),
} = {}) {
  return DB.prepare(`INSERT OR IGNORE INTO delivery_notification_outbox
    (order_id, transition, event_id, channel, template, state, attempt_count,
     next_attempt_at, created_at, updated_at)
    VALUES (?, 'payment_received', ?, 'whatsapp', ?, 'pending', 0, ?, ?, ?)`)
    .bind(orderId, eventId, OPS_PAYMENT_TEMPLATE, now, now, now).run();
}

export async function persistPaidOrderAndOpsWhatsAppJob(DB, orderId, {
  amountAgorot,
  paymentRef = null,
  shopifyOrderId = null,
  analyticsSettlement = false,
  eventId = `payment-received-${orderId}`,
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(amountAgorot) || amountAgorot < 0) {
    throw new Error('invalid_paid_amount');
  }

  // D1 batch statements commit atomically. The unique outbox job is the
  // transition claim: if any payment/status/outbox write fails, none persist.
  const claim = DB.prepare(`INSERT OR IGNORE INTO delivery_notification_outbox
    (order_id, transition, event_id, channel, template, state, attempt_count,
     next_attempt_at, created_at, updated_at)
    SELECT ?, 'payment_received', ?, 'whatsapp', ?, 'pending', 0, ?, ?, ?
    FROM orders
    WHERE id = ? AND COALESCE(payment_status, '') != 'paid'`)
    .bind(orderId, eventId, OPS_PAYMENT_TEMPLATE, now, now, now, orderId);

  const orderSets = ['status = ?', 'payment_status = ?'];
  const orderValues = ['paid', 'paid'];
  if (shopifyOrderId != null) {
    orderSets.push('shopify_order_id = ?');
    orderValues.push(shopifyOrderId);
  }
  const updateOrder = DB.prepare(`UPDATE orders
    SET ${orderSets.join(', ')}
    WHERE id = ? AND COALESCE(payment_status, '') != 'paid'
      AND EXISTS (SELECT 1 FROM delivery_notification_outbox
        WHERE order_id = ? AND transition = 'payment_received'
          AND channel = 'whatsapp' AND template = ? AND event_id = ?)`)
    .bind(...orderValues, orderId, orderId, OPS_PAYMENT_TEMPLATE, eventId);

  const payment = DB.prepare(`INSERT INTO payments
    (order_id, amount, currency, payplus_id, status, url, created_at, paid_at)
    SELECT ?, ?, 'ILS', ?, 'paid', NULL, ?, ?
    WHERE EXISTS (SELECT 1 FROM delivery_notification_outbox
      WHERE order_id = ? AND transition = 'payment_received'
        AND channel = 'whatsapp' AND template = ? AND event_id = ?)
      AND NOT EXISTS (SELECT 1 FROM payments
        WHERE order_id = ? AND status = 'paid')`)
    .bind(
      orderId,
      amountAgorot,
      paymentRef,
      now,
      now,
      orderId,
      OPS_PAYMENT_TEMPLATE,
      eventId,
      orderId,
    );

  const history = DB.prepare(`INSERT INTO status_history (order_id, status, at, note)
    SELECT ?, 'paid', ?, NULL
    WHERE EXISTS (SELECT 1 FROM delivery_notification_outbox
      WHERE order_id = ? AND transition = 'payment_received'
        AND channel = 'whatsapp' AND template = ? AND event_id = ?)
      AND NOT EXISTS (SELECT 1 FROM status_history
        WHERE order_id = ? AND status = 'paid')`)
    .bind(orderId, now, orderId, OPS_PAYMENT_TEMPLATE, eventId, orderId);

  const statements = [claim, updateOrder, payment, history];
  if (analyticsSettlement) {
    statements.push(DB.prepare(`UPDATE analytics_conversion_claims
      SET settled_at = ?
      WHERE order_id = ? AND settled_at IS NULL AND observed_at IS NULL
        AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM orders
          WHERE id = ? AND payment_status = 'paid'
            AND shopify_order_id IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM payments
          WHERE order_id = ? AND status = 'paid'
        )`)
      .bind(now, orderId, now, orderId, orderId));
  }

  const results = await DB.batch(statements);
  return {
    eventId,
    transitioned: !!results[0]?.meta?.changes,
  };
}

const escHtml = (value) => String(value == null ? '' : value).replace(
  /[&<>"']/g,
  (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]),
);

const storefrontBase = (env) => (
  env.STOREFRONT_BASE || env.BOOKING_URL || 'https://edenmish.com'
).replace(/\/+$/, '');

export const retainedPackageFailureHtml = (env, order, template) => {
  const returning = template === RETAINED_FAILURE_TEMPLATES.return_to_origin;
  const trackingUrl = `${storefrontBase(env)}/track.html?t=${encodeURIComponent(order.token || '')}`;
  const title = returning
    ? 'לא הצלחנו למסור — החבילה חוזרת לנקודת האיסוף'
    : 'לא הצלחנו למסור — נדרש תיאום למסירה מחדש';
  const nextStep = returning
    ? 'החבילה נשארה אצל השליח והיא בדרך חזרה לנקודת האיסוף. אין צורך בפעולה כרגע; ניצור איתכם קשר אם יידרש תיאום נוסף.'
    : 'החבילה נשארה אצל השליח. ניצור איתכם קשר לעדכון הכתובת ולתיאום התשלום עבור ניסיון המסירה הנוסף. אם לא יושלם תיאום בתוך 24 שעות, החבילה תחזור לנקודת האיסוף.';
  return `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px;margin:0 auto;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:32px 24px;border:1px solid #e5e7eb;border-radius:16px"><h1 style="color:#5B2A86;font-size:24px;margin:0 0 10px">${title}</h1><p style="color:#4b5563;margin:0 0 18px;font-size:15px">${nextStep}</p><div style="background:#f7f3fa;border:1px solid #e3d7eb;border-radius:12px;padding:16px;margin-bottom:18px"><span style="color:#4b5563;font-size:12px">מספר הזמנה </span><b style="color:#1f2937">#${escHtml(order.id)}</b></div><div style="text-align:center"><a href="${trackingUrl}" style="display:inline-block;background:#5B2A86;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">לצפייה בעדכון המשלוח ←</a></div><p style="color:#4b5563;font-size:13px;margin-top:18px">לשאלות: eden@edenmish.com · 053-405-8498<br>כתובת העסק למשלוח הודעות: קריניצי 111, רמת גן, ישראל</p></div>`;
};

async function defaultDeliver(env, job, order) {
  if (job.channel === 'email') {
    if (Object.values(RETAINED_FAILURE_TEMPLATES).includes(job.template)) {
      const returning = job.template === RETAINED_FAILURE_TEMPLATES.return_to_origin;
      return notifyEmail(env, env.DB, {
        orderId: order.id,
        template: job.template,
        recipient: order.email,
        subject: returning
          ? 'לא הצלחנו למסור — החבילה חוזרת לנקודת האיסוף'
          : 'לא הצלחנו למסור — נדרש תיאום למסירה מחדש',
        html: retainedPackageFailureHtml(env, order, job.template),
      });
    }
    if (job.template !== DELIVERED_TEMPLATE) {
      return { ok: false, error: 'unsupported_template', permanent: true };
    }
    const { deliverySummaryHtml } = await import('./delivery-completion.js');
    return notifyEmail(env, env.DB, {
      orderId: order.id,
      template: DELIVERED_TEMPLATE,
      recipient: order.email,
      subject: 'המשלוח מ-EdenMish נמסר ✓',
      html: deliverySummaryHtml(env, order),
    });
  }
  if (job.channel === 'whatsapp') {
    if (job.template === OPS_PAYMENT_TEMPLATE && job.transition === 'payment_received') {
      return notifyWhatsApp(env, env.DB, {
        orderId: order.id,
        messageClass: WHATSAPP_MESSAGE_CLASSES.opsPaymentReceived,
      });
    }
    if (job.template !== DELIVERED_TEMPLATE || job.transition !== 'delivered') {
      return { ok: false, error: 'phone_channel_not_permitted_for_template', permanent: true };
    }
    if (!order.phone_delivery_link_opt_in || !order.phone) {
      return { ok: false, error: 'phone_channel_requires_opt_in', permanent: true };
    }
    return notifyWhatsApp(env, env.DB, {
      orderId: order.id,
      messageClass: WHATSAPP_MESSAGE_CLASSES.customerDeliverySummary,
      recipient: order.phone,
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
            lease_expires_at = NULL, last_error = NULL, updated_at = ?,
            provider_ref = ?, provider_status = ?, provider_updated_at = ?
        WHERE id = ? AND lease_token = ?`).bind(
        now,
        now,
        result.providerRef || null,
        result.providerStatus || null,
        null,
        job.id,
        leaseToken,
      ).run();
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
  template: DELIVERED_TEMPLATE,
  templates: Object.freeze({
    delivered: DELIVERED_TEMPLATE,
    opsPaymentReceived: OPS_PAYMENT_TEMPLATE,
    retainedReturning: RETAINED_FAILURE_TEMPLATES.return_to_origin,
    retainedRedeliveryHold: RETAINED_FAILURE_TEMPLATES.hold_for_redelivery,
  }),
  transitions: Object.freeze(['delivered', 'delivery_failed_retained', 'payment_received']),
  channels: Object.freeze(['email', 'whatsapp_opt_in']),
  retainedFailureChannels: Object.freeze(['email']),
  phoneDeliveryRequiresPersistedOptIn: true,
  defaultLimit: DEFAULT_LIMIT,
  defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  defaultLeaseMs: DEFAULT_LEASE_MS,
  defaultRetryMs: DEFAULT_RETRY_MS,
  semantics: 'at-least-once',
});
