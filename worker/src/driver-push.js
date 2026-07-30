const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const APNS_ENVIRONMENTS = new Set(['development', 'production']);
const DEFAULT_TOPICS = new Set([
  'com.edenmish.edendriver',
  'com.edenmish.edendriver.nativebeta',
]);
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const DEVICE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

let cachedProviderToken = null;

function resetProviderTokenCache() {
  cachedProviderToken = null;
}

function allowedTopics(env) {
  const configured = String(env.APNS_ALLOWED_TOPICS || '')
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
  return configured.length ? new Set(configured) : DEFAULT_TOPICS;
}

export function validateDriverPushRegistration(body, env) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (Object.keys(body).some((key) => (
    !['device_token', 'environment', 'app_bundle_id'].includes(key)
  ))) return false;
  return DEVICE_TOKEN.test(body.device_token || '')
    && APNS_ENVIRONMENTS.has(body.environment)
    && allowedTopics(env).has(body.app_bundle_id);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function textToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function privateKeyBytes(value) {
  const pem = String(value || '').replace(/\\n/g, '\n').trim();
  const encoded = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  if (!encoded) throw new Error('apns_private_key_invalid');
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function apnsConfigured(env) {
  return Boolean(
    String(env.APNS_TEAM_ID || '').trim()
      && String(env.APNS_KEY_ID || '').trim()
      && String(env.APNS_PRIVATE_KEY_P8 || '').trim(),
  );
}

async function createProviderToken(env, now = Date.now()) {
  const teamId = String(env.APNS_TEAM_ID || '').trim();
  const keyId = String(env.APNS_KEY_ID || '').trim();
  const cacheKey = `${teamId}:${keyId}`;
  if (
    cachedProviderToken
    && cachedProviderToken.cacheKey === cacheKey
    && now - cachedProviderToken.createdAt < PROVIDER_TOKEN_TTL_MS
  ) {
    return cachedProviderToken.value;
  }
  const header = textToBase64Url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = textToBase64Url(JSON.stringify({
    iss: teamId,
    iat: Math.floor(now / 1000),
  }));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes(env.APNS_PRIVATE_KEY_P8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned),
  ));
  const value = `${unsigned}.${bytesToBase64Url(signature)}`;
  cachedProviderToken = { cacheKey, createdAt: now, value };
  return value;
}

export async function registerDriverPushDevice(DB, {
  driverId,
  installationId,
  deviceToken,
  environment,
  appBundleId,
  now = Date.now(),
}) {
  const statements = [
    DB.prepare(`DELETE FROM driver_push_devices
      WHERE device_token = ? AND installation_id <> ?`)
      .bind(deviceToken, installationId),
    DB.prepare(`INSERT INTO driver_push_devices
      (installation_id, driver_id, device_token, environment, app_bundle_id,
       created_at, updated_at, last_seen_at, disabled_at, last_error, last_success_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(installation_id) DO UPDATE SET
        driver_id = excluded.driver_id,
        device_token = excluded.device_token,
        environment = excluded.environment,
        app_bundle_id = excluded.app_bundle_id,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at,
        disabled_at = NULL,
        last_error = NULL`)
      .bind(
        installationId,
        driverId,
        deviceToken,
        environment,
        appBundleId,
        now,
        now,
        now,
      ),
  ];
  await DB.batch(statements);
}

export async function unregisterDriverPushDevice(DB, {
  driverId,
  installationId,
}) {
  const result = await DB.prepare(`DELETE FROM driver_push_devices
    WHERE installation_id = ? AND driver_id = ?`)
    .bind(installationId, driverId).run();
  return Number(result?.meta?.changes || 0) > 0;
}

function routePayload({ shiftId, routeRevision, hasNewDelivery }) {
  const type = hasNewDelivery ? 'driver_new_delivery' : 'driver_route_updated';
  return {
    aps: {
      alert: {
        title: hasNewDelivery ? 'משלוח חדש הוקצה לך' : 'המסלול עודכן',
        body: hasNewDelivery
          ? 'הפרטים מחכים באפליקציה'
          : 'מומלץ לבדוק את סדר העצירות החדש',
      },
      sound: 'default',
      'thread-id': 'driver-route',
      'interruption-level': 'active',
      'content-available': 1,
    },
    type,
    shift_id: shiftId,
    route_revision: routeRevision,
  };
}

function apnsOrigin(environment) {
  return environment === 'development'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
}

async function recordDeliveryResult(DB, device, {
  now,
  ok,
  permanent,
  error,
}) {
  if (ok) {
    await DB.prepare(`UPDATE driver_push_devices
      SET last_success_at = ?, last_error = NULL, updated_at = ?
      WHERE installation_id = ? AND device_token = ?`)
      .bind(now, now, device.installation_id, device.device_token).run();
    return;
  }
  await DB.prepare(`UPDATE driver_push_devices
    SET last_error = ?, disabled_at = CASE WHEN ? THEN ? ELSE disabled_at END,
        updated_at = ?
    WHERE installation_id = ? AND device_token = ?`)
    .bind(
      String(error || 'apns_delivery_failed').slice(0, 160),
      permanent ? 1 : 0,
      permanent ? now : null,
      now,
      device.installation_id,
      device.device_token,
    ).run();
}

async function apnsFailureReason(response) {
  if (response?.ok) return null;
  try {
    return (await response.json())?.reason || `apns_http_${response.status}`;
  } catch {
    return `apns_http_${response?.status || 'unknown'}`;
  }
}

function isProviderTokenFailure(response, reason) {
  return response?.status === 403
    && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(reason);
}

export async function sendDriverRoutePush(env, {
  driverId,
  shiftId,
  routeRevision,
  addedStopIds = [],
  now = Date.now(),
}, {
  fetchImpl = fetch,
  tokenFactory = createProviderToken,
} = {}) {
  if (!apnsConfigured(env)) {
    return { configured: false, attempted: 0, sent: 0, failed: 0 };
  }
  const rows = await env.DB.prepare(`SELECT installation_id, device_token,
      environment, app_bundle_id
    FROM driver_push_devices
    WHERE driver_id = ? AND disabled_at IS NULL AND last_seen_at >= ?
    ORDER BY installation_id`)
    .bind(driverId, now - DEVICE_RETENTION_MS).all();
  const devices = rows.results || [];
  if (!devices.length) {
    return { configured: true, attempted: 0, sent: 0, failed: 0 };
  }

  let providerToken = await tokenFactory(env, now);
  const payload = JSON.stringify(routePayload({
    shiftId,
    routeRevision,
    hasNewDelivery: addedStopIds.length > 0,
  }));
  async function deliver(device, token) {
    try {
      const response = await fetchImpl(
        `${apnsOrigin(device.environment)}/3/device/${device.device_token}`,
        {
          method: 'POST',
          headers: {
            authorization: `bearer ${token}`,
            'apns-topic': device.app_bundle_id,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(Math.floor((now + 60 * 60 * 1000) / 1000)),
            'apns-collapse-id': `driver-route-${shiftId}`.slice(0, 64),
            'content-type': 'application/json',
          },
          body: payload,
        },
      );
      return {
        response,
        reason: await apnsFailureReason(response),
      };
    } catch (error) {
      return {
        response: null,
        reason: error?.message || 'apns_network_error',
      };
    }
  }

  let sent = 0;
  let failed = 0;
  let providerTokenRefreshAttempted = false;
  for (const device of devices) {
    let { response, reason } = await deliver(device, providerToken);
    if (
      !providerTokenRefreshAttempted
      && isProviderTokenFailure(response, reason)
    ) {
      providerTokenRefreshAttempted = true;
      resetProviderTokenCache();
      try {
        providerToken = await tokenFactory(env, now);
        ({ response, reason } = await deliver(device, providerToken));
      } catch (error) {
        response = null;
        reason = error?.message || 'apns_provider_token_refresh_failed';
      }
    }

    if (response?.ok) {
      sent += 1;
      await recordDeliveryResult(env.DB, device, { now, ok: true });
      continue;
    }
    failed += 1;
    const permanent = response?.status === 410
      || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason);
    await recordDeliveryResult(env.DB, device, {
      now,
      ok: false,
      permanent,
      error: reason,
    });
  }
  return {
    configured: true,
    attempted: devices.length,
    sent,
    failed,
  };
}

export async function cleanupDriverPushDevices(DB, now = Date.now()) {
  return DB.prepare(`DELETE FROM driver_push_devices
    WHERE last_seen_at < ? OR (disabled_at IS NOT NULL AND disabled_at < ?)`)
    .bind(now - DEVICE_RETENTION_MS, now - DEVICE_RETENTION_MS).run();
}

export const driverPushTest = {
  allowedTopics,
  apnsOrigin,
  createProviderToken,
  resetProviderTokenCache,
  routePayload,
  validRegistration: validateDriverPushRegistration,
};
