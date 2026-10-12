import { rehearsalSelected, activeRehearsal } from './payment-rehearsal-capability.js';
// Notification layer (PR8). Wraps the existing sendEmail with a durable audit
// trail (D1 `notifications` table) and is the future home for WhatsApp/SMS.
//
// Hard rules:
// - NEVER throws — a notification failure must never break order/payment/delivery
//   flow. Callers can `await notifyEmail(...)` without a try/catch (though many do).
// - NEVER stores the email body/html or OTP codes — only metadata + outcome.
// - The audit row itself is best-effort: if D1 is unavailable we still attempt the send.

import { emailRecipientAllowed, emailSubjectForEnv, sendEmail } from './integrations.js';
import { createNotificationAttempt, markNotificationSent, markNotificationFailed, markNotificationSkipped } from './db.js';
import { resolveWhatsAppMessage, sendWhatsAppTemplate } from './whatsapp.js';

const sanitizeError = (e) => {
  let s = e && e.message ? e.message : String(e == null ? '' : e);
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
};

// notifyEmail(env, db, { orderId, template, recipient, subject, html, text })
// Returns { ok: boolean, skipped?: boolean, id?: number|null, error?: string }.
export async function notifyEmail(env, db, { orderId, template, recipient, subject, html, text }) {
  if(rehearsalSelected(env)) {
    try {
      const r=await activeRehearsal(env);
      if(!r || !env.SENDGRID_API_KEY || ![r.email,r.ops_email].includes(recipient)
        || !['ops_new_order','customer_payment_confirmation','ops_payment_received','customer_otp'].includes(template))return {ok:false,skipped:true};
      const claim=await db.prepare(`UPDATE payment_rehearsal_runs SET email_attempts=email_attempts+1 WHERE id=? AND stopped_at IS NULL AND expires_at>? AND email_attempts<4
        AND EXISTS(SELECT 1 FROM orders WHERE id=? AND rehearsal_run_id=payment_rehearsal_runs.id AND rehearsal_closed_at IS NULL) RETURNING id`).bind(r.run_id,Date.now(),orderId).first();
      if(!claim)return {ok:false,skipped:true};
      subject='[בדיקת תשלום — ללא משלוח] '+subject;
      html='<p dir="rtl">בדיקת תשלום אמיתי בלבד. אין לבצע איסוף או מסירה.</p>'+html;
    } catch {return {ok:false,skipped:true};}
  }
  const configuredSubject = emailSubjectForEnv(env, subject);
  // 1. Best-effort audit row (pending). Never blocks the send if D1 hiccups.
  let id = null;
  try {
    id = await createNotificationAttempt(db, {
      order_id: orderId ?? null,
      channel: 'email',
      template: template || null,
      recipient: recipient || null,
      subject: configuredSubject || null,
      status: 'pending',
    });
  } catch (e) {
    id = null;
  }

  // 2. Precondition (mirrors sendEmail): no key or no recipient -> skipped, not failed.
  if (!recipient || !env || !env.SENDGRID_API_KEY) {
    if (id) { try { await markNotificationSkipped(db, id); } catch (e) {} }
    return { ok: false, skipped: true, id };
  }
  if (!emailRecipientAllowed(env, recipient)) {
    if (id) { try { await markNotificationSkipped(db, id); } catch (e) {} }
    return { ok: false, skipped: true, id, error: 'recipient_not_allowed' };
  }

  // 3. Send. sendEmail returns a boolean (true on 200/202); it catches its own fetch errors.
  try {
    const ok = await sendEmail(env, { to: recipient, subject: configuredSubject, html, text });
    if (ok) {
      if (id) { try { await markNotificationSent(db, id, null); } catch (e) {} } // provider_ref null until sendEmail exposes SendGrid's X-Message-Id
      return { ok: true, id };
    }
    if (id) { try { await markNotificationFailed(db, id, 'send_failed'); } catch (e) {} }
    return { ok: false, id, error: 'send_failed' };
  } catch (e) {
    if (id) { try { await markNotificationFailed(db, id, sanitizeError(e)); } catch (e2) {} }
    return { ok: false, id, error: sanitizeError(e) };
  }
}

// notifyWhatsApp(env, db, { orderId, messageClass, recipient })
// Approved-template WhatsApp send. Recipient values are never retained in the
// audit table, and the supported classes have no dynamic provider components.
export async function notifyWhatsApp(env, db, { orderId, messageClass, recipient }) {
  if(rehearsalSelected(env)) return {ok:false,skipped:true,error:'rehearsal_templates_disabled'};
  let id = null;
  try {
    id = await createNotificationAttempt(db, {
      order_id: orderId ?? null,
      channel: 'whatsapp',
      template: messageClass || null,
      recipient: null,
      subject: null,
      status: 'pending',
    });
  } catch (e) { id = null; }

  const message = resolveWhatsAppMessage(env, messageClass, recipient);
  if (!message.ok) {
    if (id) { try { await markNotificationSkipped(db, id); } catch (e) {} }
    return { ...message, id };
  }

  try {
    const result = await sendWhatsAppTemplate(env, message);
    if (result.ok) {
      if (id) {
        try {
          await markNotificationSent(
            db,
            id,
            result.providerRef,
            result.providerStatus,
          );
        } catch (e) {}
      }
      return { ...result, id };
    }
    if (id) { try { await markNotificationFailed(db, id, result.error); } catch (e) {} }
    return { ...result, id };
  } catch (e) {
    if (id) { try { await markNotificationFailed(db, id, sanitizeError(e)); } catch (e2) {} }
    return { ok: false, id, error: sanitizeError(e) };
  }
}
