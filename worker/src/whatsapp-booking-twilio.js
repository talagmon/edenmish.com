import { twilioVoiceMedia } from './whatsapp-booking-audio.js';
import { continuationSelected, stopContinuation } from './whatsapp-continuation.js';
// Dedicated Twilio WhatsApp booking sender. Independent of proactive link/marketing
// work in the other checkout; reuse the same account secret names and allowlist.
import { normalizeIlPhone } from './validate.js';
import { SESSION_WINDOW } from './whatsapp-booking.js';
const SID = /^AC[0-9a-f]{32}$/i;
// Twilio uses SM for text messages and can use MM for incoming WhatsApp media.
// Both remain bound to the signed webhook and verified message resource below.
const MESSAGE_SID = /^(?:SM|MM)[0-9a-f]{32}$/i;
const FROM = /^whatsapp:\+[1-9]\d{7,14}$/;
export function twilioBookingConfigured(env) {
  return SID.test(env.TWILIO_ACCOUNT_SID || '') && !!env.TWILIO_AUTH_TOKEN
    && FROM.test(env.TWILIO_BOOKING_FROM || '')
    && env.TWILIO_BOOKING_FROM.replace(/\D/g, '') !== String(env.WHATSAPP_NUMBER || '972534058498').replace(/\D/g, '');
}
export function bookingRecipientAllowed(env, recipient) {
  if (env.TWILIO_RECIPIENT_POLICY === 'open') return true;
  return env.TWILIO_RECIPIENT_POLICY === 'allowlist'
    && String(env.TWILIO_RECIPIENT_ALLOWLIST || '').split(',').map((v) => v.trim()).includes(recipient);
}
const auth = (env) => `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
export async function verifyTwilioBookingSignature(url, form, signature, secret) {
  if (!secret || !/^[A-Za-z0-9+/]{27}=$/.test(signature || '')) return false;
  let payload = url;
  for (const key of [...new Set(form.keys())].sort()) {
    // Reject duplicate parameters: no ambiguity between signing and parser semantics.
    if (form.getAll(key).length !== 1) return false;
    payload += key + form.get(key);
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const expected = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))));
  let difference = expected.length ^ signature.length;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0;
}
export async function readTwilioBookingEvent(req, env, fetchImpl = globalThis.fetch, now = Date.now()) {
  if (!twilioBookingConfigured(env)) return { status: 503 };
  let publicUrl;
  try {
    publicUrl = new URL(env.TWILIO_BOOKING_WEBHOOK_URL);
    if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/webhooks/twilio/booking' || publicUrl.username || publicUrl.password || publicUrl.hash || publicUrl.search) return { status: 503 };
  } catch { return { status: 503 }; }
  if (!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return { status: 415 };
  if (Number(req.headers.get('content-length')) > 32 * 1024) return { status: 413 };
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > 32 * 1024) return { status: 413 };
  const form = new URLSearchParams(raw);
  if (!await verifyTwilioBookingSignature(publicUrl.href, form, req.headers.get('X-Twilio-Signature'), env.TWILIO_AUTH_TOKEN)) return { status: 401 };
  const id = form.get('MessageSid');
  const from = form.get('From');
  const phone = FROM.test(from || '') ? normalizeIlPhone(from.slice(9)) : null;
  if (form.get('AccountSid') !== env.TWILIO_ACCOUNT_SID || form.get('To') !== env.TWILIO_BOOKING_FROM || !MESSAGE_SID.test(id || '') || !phone) return { status: 400 };
  if (!bookingRecipientAllowed(env, phone)) return { status: 403 };
  // Twilio's form webhook has no trusted creation timestamp. Fetch just this
  // signed message resource to enforce replay age, ordering and the 24h window.
  let message;
  try {
    const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${id}.json`, {
      headers: { Authorization: auth(env) }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { status: 503 };
    message = await response.json();
  } catch { return { status: 503 }; }
  const at = Date.parse(message.date_created);
  if (message.sid !== id || message.account_sid !== env.TWILIO_ACCOUNT_SID || message.direction !== 'inbound' || message.from !== from || message.to !== env.TWILIO_BOOKING_FROM || !Number.isFinite(at)) return { status: 400 };
  if (at <= now - SESSION_WINDOW || at > now + 60_000) return { status: 200, event: null };
  const body = form.get('Body') || '';
  return { status: 200, event: { id, phone, at, echo: false, text: form.get('NumMedia') === '0' && body.length <= 2000 ? body : null, ...(env.WHATSAPP_BOOKING_VOICE_ENABLED==='on' && twilioVoiceMedia(form,env,id)?{audio:twilioVoiceMedia(form,env,id)}:{}) } };
}
export async function sendTwilioBookingReply(env, recipient, body, fetchImpl = globalThis.fetch) {
  if (!twilioBookingConfigured(env) || !bookingRecipientAllowed(env, recipient) || !body || body.length > 1600) return null;
  try {
    const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: auth(env), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: env.TWILIO_BOOKING_FROM, To: `whatsapp:${recipient}`, Body: body, StatusCallback: env.TWILIO_BOOKING_WEBHOOK_URL + '/status' }).toString(),
    });
    const data = await response.json();
    return response.ok && MESSAGE_SID.test(data?.sid || '') ? data.sid : null;
  } catch { return null; }
}

// Delivery callbacks carry no payment authority. They only update transport state.
export async function applyTwilioBookingStatus(req, env) {
  if (!twilioBookingConfigured(env) || !env.TWILIO_BOOKING_WEBHOOK_URL) return 503;
  if (!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return 415;
  if (Number(req.headers.get('content-length')) > 32 * 1024) return 413;
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > 32 * 1024) return 413;
  const form = new URLSearchParams(raw);
  if (!await verifyTwilioBookingSignature(env.TWILIO_BOOKING_WEBHOOK_URL + '/status', form, req.headers.get('X-Twilio-Signature'), env.TWILIO_AUTH_TOKEN)) return 401;
  if (form.get('AccountSid') !== env.TWILIO_ACCOUNT_SID || !MESSAGE_SID.test(form.get('MessageSid') || '')) return 400;
  const rank = { failed: 1, undelivered: 1, canceled: 1, delivered: 2, read: 3 }[form.get('MessageStatus')];
  if (!rank) return 200;
  // A signed receipt may beat the outbound POST response. Store only the SID and
  // monotonic status, never callback body/recipient/error content. Acknowledge
  // after persistence; a lease conflict is replayed locally, not silently lost.
  await env.DB.prepare(`INSERT INTO whatsapp_booking_receipts (provider_ref, rank, created_at) VALUES (?, ?, ?)
    ON CONFLICT(provider_ref) DO UPDATE SET rank = MAX(rank, excluded.rank)`).bind(form.get('MessageSid'), rank, Date.now()).run();
  await reconcileTwilioBookingReceipts(env, form.get('MessageSid'));
  return 200;
}

export async function reconcileTwilioBookingReceipts(env, providerRef = null, heldLease = null) {
  const DB = env.DB;
  const rows = await DB.prepare(`SELECT s.provider_ref, s.rank, r.id, r.conversation_id FROM whatsapp_booking_receipts s
    JOIN whatsapp_booking_replies r ON r.provider_ref = s.provider_ref
    WHERE s.rank > s.applied_rank AND (? IS NULL OR s.provider_ref = ?) AND (? IS NULL OR r.conversation_id = ?) LIMIT 100`).bind(providerRef, providerRef, heldLease?.id || null, heldLease?.id || null).all();
  for (const receipt of rows.results || []) {
    const lease = heldLease?.token || crypto.randomUUID();
    if (heldLease) {
      if (!await DB.prepare('SELECT id FROM whatsapp_booking_conversations WHERE id = ? AND lock_id = ?').bind(receipt.conversation_id, lease).first()) continue;
    } else {
      const locked = await DB.prepare('UPDATE whatsapp_booking_conversations SET lock_id = ?, lock_at = ? WHERE id = ? AND lock_id IS NULL').bind(lease, Date.now(), receipt.conversation_id).run();
      if (!locked?.meta?.changes) continue;
    }
    try {
      // Re-read after the lease: a newer success may supersede a queued failure.
      const current = await DB.prepare('SELECT rank, applied_rank FROM whatsapp_booking_receipts WHERE provider_ref = ?').bind(receipt.provider_ref).first();
      if (!current || current.rank <= current.applied_rank) continue;
      const statements = current.rank === 1 ? [
        DB.prepare("UPDATE whatsapp_booking_replies SET state = 'failed', body = NULL WHERE id = ? AND state NOT IN ('delivered', 'read')").bind(receipt.id),
        DB.prepare("UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = json_set(state_json, '$.phase', 'handoff') WHERE id = ? AND phase != 'closed' AND EXISTS (SELECT 1 FROM whatsapp_booking_replies WHERE id = ? AND state = 'failed')").bind(receipt.conversation_id, receipt.id),
        DB.prepare("UPDATE whatsapp_booking_replies SET state = 'cancelled', body = NULL WHERE conversation_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM whatsapp_booking_replies WHERE id = ? AND state = 'failed')").bind(receipt.conversation_id, receipt.id),
      ] : [DB.prepare("UPDATE whatsapp_booking_replies SET state = ? WHERE id = ? AND state IN ('sent', 'failed', 'delivered')").bind(current.rank === 3 ? 'read' : 'delivered', receipt.id)];
      statements.push(DB.prepare('UPDATE whatsapp_booking_receipts SET applied_rank = MAX(applied_rank, ?) WHERE provider_ref = ?').bind(current.rank, receipt.provider_ref));
      await DB.batch(statements);
      if (current.rank===1 && continuationSelected(env)) {
        const failed=await DB.prepare(`SELECT c.state_json FROM whatsapp_booking_replies r JOIN whatsapp_booking_conversations c ON c.id=r.conversation_id WHERE r.id=? AND r.state='failed'`).bind(receipt.id).first();
        if (failed && JSON.parse(failed.state_json).continuation_id===env.WHATSAPP_BOOKING_CONTINUATION_ID) await stopContinuation(env,'provider_uncertain');
      }
    } finally {
      if (!heldLease) await DB.prepare('UPDATE whatsapp_booking_conversations SET lock_id = NULL, lock_at = NULL WHERE id = ? AND lock_id = ?').bind(receipt.conversation_id, lease).run();
    }
  }
}
