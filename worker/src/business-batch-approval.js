import { timingSafeEqual } from './integrations.js';

const TOKEN_TTL_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signature(env, encodedPayload) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`business-batch:${encodedPayload}`),
  );
  return base64UrlEncode(new Uint8Array(signed));
}

export async function signBusinessBatchToken(
  env,
  accountId,
  kind,
  data,
  { approved = false, now = Date.now() } = {},
) {
  const payload = {
    v: 1,
    account_id: Number(accountId),
    kind: String(kind),
    approved: Boolean(approved),
    issued_at: now,
    expires_at: now + TOKEN_TTL_MS,
    data,
  };
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await signature(env, encoded)}`;
}

export async function verifyBusinessBatchToken(
  env,
  accountId,
  token,
  { kind, requireApproved = false, now = Date.now() } = {},
) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || parts[0].length > 12_000 || parts[1].length > 100) {
    throw new Error('invalid_batch_approval');
  }
  const expected = await signature(env, parts[0]);
  if (!timingSafeEqual(expected, parts[1])) throw new Error('invalid_batch_approval');
  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
  } catch {
    throw new Error('invalid_batch_approval');
  }
  if (
    payload?.v !== 1
    || Number(payload.account_id) !== Number(accountId)
    || (kind && payload.kind !== kind)
    || !Number.isFinite(payload.expires_at)
    || payload.expires_at < now
    || payload.issued_at > now + 60_000
    || (requireApproved && !payload.approved)
  ) {
    throw new Error(payload?.expires_at < now ? 'batch_approval_expired' : 'invalid_batch_approval');
  }
  return payload;
}

export async function approveBusinessBatchToken(env, accountId, token, kind) {
  const parsed = await verifyBusinessBatchToken(env, accountId, token, { kind });
  return signBusinessBatchToken(env, accountId, kind, parsed.data, { approved: true });
}

export async function businessBatchIdempotencyKey(externalId) {
  const normalized = String(externalId || '').trim().toLocaleLowerCase('he');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalized));
  return `batch-external:${base64UrlEncode(new Uint8Array(digest)).slice(0, 32)}`;
}
