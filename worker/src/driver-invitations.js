import qrcode from 'qrcode-generator';

const DRIVER_ID = /^drv_[A-Za-z0-9]+$/;
const INVITATION_ID = /^di_[A-Za-z0-9]+$/;
const DEFAULT_TTL_MINUTES = 15;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 60;
const CODE_MIN = 10_000_000;
const CODE_RANGE = 90_000_000;
const UINT32_RANGE = 0x1_0000_0000;
const UNBIASED_LIMIT = Math.floor(UINT32_RANGE / CODE_RANGE) * CODE_RANGE;

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(String(value)),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function numericInvitationCode() {
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= UNBIASED_LIMIT);
  return String(CODE_MIN + (random[0] % CODE_RANGE));
}

function normalizedTTLMinutes(value) {
  if (value == null || value === '') return DEFAULT_TTL_MINUTES;
  const minutes = Number(value);
  if (!Number.isInteger(minutes)
    || minutes < MIN_TTL_MINUTES
    || minutes > MAX_TTL_MINUTES) {
    return null;
  }
  return minutes;
}

export async function driverInvitationCodeHash(env, code) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');
  return hmacHex(env.SESSION_SECRET, `driver-invitation:${code}`);
}

export function driverPairingURI(code) {
  return `edenmish-driver://pair?code=${encodeURIComponent(code)}`;
}

export function driverPairingQRCodeSVG(uri) {
  const qr = qrcode(0, 'M');
  qr.addData(uri, 'Byte');
  qr.make();
  return qr.createSvgTag(5, 3);
}

export async function createDriverInvitation(
  env,
  {
    driverId,
    expiresInMinutes,
    createdBy = 'ops',
    now = Date.now(),
  } = {},
) {
  if (!DRIVER_ID.test(driverId || '')) {
    return { ok: false, status: 400, error: 'invalid_driver_id' };
  }
  const ttlMinutes = normalizedTTLMinutes(expiresInMinutes);
  if (ttlMinutes == null) {
    return { ok: false, status: 400, error: 'invalid_expiry' };
  }
  if (!env.SESSION_SECRET) {
    return { ok: false, status: 503, error: 'driver_auth_unconfigured' };
  }
  const driver = await env.DB.prepare(`SELECT id, display_name, locale
    FROM drivers WHERE id = ? AND active = 1`).bind(driverId).first();
  if (!driver) return { ok: false, status: 404, error: 'driver_not_found' };

  const expiresAt = now + ttlMinutes * 60 * 1000;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = numericInvitationCode();
    const codeHash = await driverInvitationCodeHash(env, code);
    const invitationId = `di_${crypto.randomUUID().replace(/-/g, '')}`;
    const [, inserted] = await env.DB.batch([
      env.DB.prepare(`UPDATE driver_login_invitations
        SET revoked_at = ?
        WHERE driver_id = ? AND consumed_at IS NULL
          AND revoked_at IS NULL AND expires_at > ?`)
        .bind(now, driverId, now),
      env.DB.prepare(`INSERT OR IGNORE INTO driver_login_invitations
        (id, driver_id, code_hash, created_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(invitationId, driverId, codeHash, createdBy, now, expiresAt),
    ]);
    if (!inserted?.meta?.changes) continue;

    const pairingURI = driverPairingURI(code);
    return {
      ok: true,
      status: 201,
      invitation: {
        invitation_id: invitationId,
        driver_id: driver.id,
        driver_name: driver.display_name,
        locale: driver.locale,
        code,
        pairing_uri: pairingURI,
        qr_svg: driverPairingQRCodeSVG(pairingURI),
        created_at: new Date(now).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
      },
    };
  }
  return { ok: false, status: 503, error: 'invitation_generation_failed' };
}

export async function findUsableDriverInvitation(env, code, now = Date.now()) {
  if (!/^\d{6,12}$/.test(code || '') || !env.SESSION_SECRET) return null;
  const codeHash = await driverInvitationCodeHash(env, code);
  const invitation = await env.DB.prepare(`SELECT
      i.id, i.driver_id, i.code_hash, d.display_name, d.locale
    FROM driver_login_invitations i
    JOIN drivers d ON d.id = i.driver_id
    WHERE i.code_hash = ? AND i.consumed_at IS NULL AND i.revoked_at IS NULL
      AND i.expires_at > ? AND d.active = 1
    LIMIT 1`).bind(codeHash, now).first();
  return invitation || null;
}

export async function markDriverInvitationConsumed(
  DB,
  {
    invitationId,
    sessionId,
    installationId,
    now = Date.now(),
  },
) {
  return DB.prepare(`UPDATE driver_login_invitations
    SET consumed_at = ?, consumed_session_id = ?, consumed_installation_id = ?
    WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`)
    .bind(now, sessionId, installationId, invitationId).run();
}

export async function listDriverInvitations(DB, now = Date.now()) {
  const result = await DB.prepare(`SELECT
      i.id AS invitation_id, i.driver_id, d.display_name AS driver_name,
      i.created_by, i.created_at, i.expires_at, i.consumed_at, i.revoked_at
    FROM driver_login_invitations i
    JOIN drivers d ON d.id = i.driver_id
    WHERE i.created_at >= ?
    ORDER BY i.created_at DESC
    LIMIT 30`).bind(now - 7 * 24 * 60 * 60 * 1000).all();
  return (result.results || []).map((invitation) => ({
    ...invitation,
    state: invitation.consumed_at
      ? 'consumed'
      : invitation.revoked_at
        ? 'revoked'
        : invitation.expires_at <= now ? 'expired' : 'active',
  }));
}

export async function listActiveDrivers(DB) {
  const result = await DB.prepare(`SELECT id AS driver_id, display_name, locale
    FROM drivers WHERE active = 1 ORDER BY display_name, id`).all();
  return result.results || [];
}

export async function revokeDriverInvitation(DB, invitationId, now = Date.now()) {
  if (!INVITATION_ID.test(invitationId || '')) {
    return { ok: false, status: 400, error: 'invalid_invitation_id' };
  }
  const result = await DB.prepare(`UPDATE driver_login_invitations
    SET revoked_at = ?
    WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .bind(now, invitationId, now).run();
  if (!result?.meta?.changes) {
    return { ok: false, status: 409, error: 'invitation_not_active' };
  }
  return { ok: true, status: 200 };
}

export const driverInvitationTest = {
  normalizedTTLMinutes,
  numericInvitationCode,
};
