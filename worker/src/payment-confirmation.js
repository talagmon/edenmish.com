const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PAYMENT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function signature(env, payload) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`payment-confirmation:${payload}`),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export async function makePaymentConfirmationToken(env, orderId, now = Date.now()) {
  if (!Number.isInteger(Number(orderId)) || Number(orderId) <= 0) {
    throw new Error('invalid order id');
  }
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    purpose: 'payment_confirmation',
    order_id: String(orderId),
    iat: now,
    exp: now + PAYMENT_CONFIRMATION_TTL_MS,
  })));
  return `${payload}.${await signature(env, payload)}`;
}

export async function verifyPaymentConfirmationToken(env, value, now = Date.now()) {
  if (!value || !env.SESSION_SECRET) return null;
  const parts = String(value).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, suppliedSignature] = parts;
  const expectedSignature = await signature(env, payload);
  if (!timingSafeEqual(expectedSignature, suppliedSignature)) return null;
  try {
    const claims = JSON.parse(decoder.decode(base64UrlDecode(payload)));
    if (
      claims.purpose !== 'payment_confirmation'
      || !/^\d+$/.test(String(claims.order_id || ''))
      || !Number.isFinite(claims.iat)
      || !Number.isFinite(claims.exp)
      || claims.iat > now
      || claims.exp <= now
      || claims.exp - claims.iat !== PAYMENT_CONFIRMATION_TTL_MS
    ) return null;
    return { orderId: Number(claims.order_id) };
  } catch {
    return null;
  }
}
