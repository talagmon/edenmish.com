// Staging-only conversation pilot. Counts contain no phone, chat or credential.
export const conversationOnlyPilot = env => env.WHATSAPP_BOOKING_MODE === 'conversation_only';
export function bookingPilotReady(env, now = Date.now()) {
  if (env.WHATSAPP_BOOKING_MODE == null || env.WHATSAPP_BOOKING_MODE === 'full') return true;
  if (!conversationOnlyPilot(env)) return false;
  const expires = Date.parse(env.WHATSAPP_BOOKING_PILOT_EXPIRES_AT || '');
  return env.BOOKING_URL === 'https://staging.edenmish.com'
    && env.WHATSAPP_BOOKING_PROVIDER === 'twilio'
    && env.AUTO_DRIVER_DISPATCH === 'off' && env.WHATSAPP_BOOKING_MODEL_ENABLED === 'off'
    && env.TWILIO_RECIPIENT_POLICY === 'allowlist'
    && /^\+972\d{8,9}$/.test(env.TWILIO_RECIPIENT_ALLOWLIST || '')
    && /^[a-z0-9-]{8,64}$/.test(env.WHATSAPP_BOOKING_PILOT_ID || '')
    && Number.isFinite(expires) && expires > now && expires <= now + 24 * 60 * 60 * 1000;
}

export async function reservePilotOperation(env, kind, now = Date.now()) {
  if (!conversationOnlyPilot(env)) return true;
  if (!bookingPilotReady(env, now)) return false;
  // The already received manual test counts as the first of 30 inbound messages.
  const limit = { inbound: 29, outbound: 30, address: 10 }[kind];
  if (!limit) return false;
  // Never refund uncertain attempts; closing drafts/redeploying cannot reset it.
  // Long-lived lock excludes these tiny non-PII counters from rate-limit cleanup.
  const result = await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_start, last_at, locked_until)
    VALUES (?, 1, ?, ?, 9007199254740991)
    ON CONFLICT(key) DO UPDATE SET count = count + 1, last_at = excluded.last_at
    WHERE count < ?`).bind(`wa-pilot:${env.WHATSAPP_BOOKING_PILOT_ID}:${kind}`, now, now, limit).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export const pilotNotice = language => language === 'en'
  ? 'Test only: use fictitious contact details. No order, payment link or delivery will be created.'
  : 'בדיקה בלבד: השתמשו בפרטי קשר פיקטיביים. לא ייווצרו הזמנה, קישור תשלום או משלוח.';
export const pilotComplete = language => language === 'en'
  ? 'Conversation test complete. No order or payment link was created, no email was sent, and no driver was assigned. Automation is now paused.'
  : 'בדיקת השיחה הסתיימה. לא נוצרו הזמנה או קישור תשלום, לא נשלח אימייל ולא שובץ נהג. האוטומציה נעצרה.';
