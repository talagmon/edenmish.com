// Security helpers for the public tracking/order API (PR5).
// Kept in their own module so the PII sanitizer + CORS logic are unit-testable.

// CORS (Part F): if ALLOWED_ORIGINS is set, only those origins may read the public
// API (origin-reflected ACAO + Vary: Origin). If unset, falls back to '*' for
// backward compatibility — set ALLOWED_ORIGINS in production (see docs/ENVIRONMENT.md).
export function corsFor(req, env) {
  const methods = 'GET,POST,PUT,DELETE,OPTIONS';
  const hdrs = 'Content-Type, X-Ops';
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!configured.length) {
    return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': hdrs };
  }
  const origin = req.headers.get('origin') || '';
  const allowed = configured.some((rule) => {
    if (rule === origin) return true;
    if (!rule.startsWith('https://*.')) return false;
    try {
      const url = new URL(origin);
      const suffix = rule.slice('https://*'.length);
      return url.protocol === 'https:' && url.port === '' && url.hostname.endsWith(suffix) && url.hostname.length > suffix.length;
    } catch { return false; }
  });
  if (origin && allowed) {
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': hdrs, 'Vary': 'Origin' };
  }
  // Origin not on the allowlist: omit ACAO so the browser blocks the cross-origin read.
  return { 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': hdrs, 'Vary': 'Origin' };
}

// Mask an email for the unverified tracking view (e.g. "j•••@e•••.com") — a hint
// which inbox to check without exposing the full address.
export function maskEmail(email) {
  if (!email) return null;
  const s = String(email);
  const at = s.indexOf('@');
  if (at < 1) return null;
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const dname = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return (user[0] || '') + '•••@' + (dname[0] || '') + '•••' + tld;
}

// Unverified tracking payload (Part B): ONLY what is safe before OTP verification.
// Never includes name, phone, exact addresses, details, notes, payment refs, review
// reason, or any internal/ops-only field.
export function publicOrderSummary(o) {
  return { id: o.id, token: o.token, status: o.status, email_masked: maskEmail(o.email), otp_enabled: !!o.email };
}

// Best-effort client IP for rate limiting (Part E). CF-Connecting-IP is authoritative on Cloudflare.
export function clientIp(req) {
  return req.headers.get('cf-connecting-ip')
    || ((req.headers.get('x-forwarded-for') || '').split(',')[0] || '').trim()
    || 'anon';
}

// Non-reversible per-IP key for rate limiting (PR5 patch). HMAC-SHA256(IP) keyed by
// SESSION_SECRET (same secret used for OTP/session HMAC). The raw IP is never stored in
// D1 or logged — only this hash appears in rate_limits keys ("ord:<hash>", "ordd:<hash>").
// Deterministic: the same IP + secret always produce the same hash. Authentication
// and rate-limit hashing fail closed when SESSION_SECRET is missing.
export async function anonKey(env, ip) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  const secret = env.SESSION_SECRET;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('rl:' + ip));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
