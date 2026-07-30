import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupDriverPushDevices,
  driverPushTest,
  registerDriverPushDevice,
  sendDriverRoutePush,
  unregisterDriverPushDevice,
} from '../src/driver-push.js';

const deviceToken = 'ab'.repeat(32);

function fakeDb(devices = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql: sql.replace(/\s+/g, ' ').trim(), args: [] };
      calls.push(call);
      return {
        bind(...args) {
          call.args = args;
          return this;
        },
        async all() {
          return { results: devices };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function configuredEnv(DB) {
  return {
    DB,
    APNS_TEAM_ID: 'TEAMID1234',
    APNS_KEY_ID: 'KEYID12345',
    APNS_PRIVATE_KEY_P8: 'test-key-is-replaced-by-token-factory',
  };
}

describe('driver APNs notifications', () => {
  test('creates a verifiable ES256 APNs provider token from the configured p8 key', async () => {
    driverPushTest.resetProviderTokenCache();
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    const wrapped = privateKey.toString('base64').match(/.{1,64}/g).join('\n');
    const env = {
      APNS_TEAM_ID: 'TEAMID1234',
      APNS_KEY_ID: 'KEYID12345',
      APNS_PRIVATE_KEY_P8: [
        '-----BEGIN PRIVATE KEY-----',
        wrapped,
        '-----END PRIVATE KEY-----',
      ].join('\n'),
    };
    const token = await driverPushTest.createProviderToken(env, 1_000_000);
    const cachedToken = await driverPushTest.createProviderToken(env, 3_000_000);
    const rotatedToken = await driverPushTest.createProviderToken(
      env,
      1_000_000 + (50 * 60 * 1000),
    );
    const [headerPart, claimsPart, signaturePart] = token.split('.');

    assert.equal(cachedToken, token);
    assert.notEqual(rotatedToken, token);
    assert.deepEqual(JSON.parse(Buffer.from(headerPart, 'base64url')), {
      alg: 'ES256',
      kid: 'KEYID12345',
    });
    assert.deepEqual(JSON.parse(Buffer.from(claimsPart, 'base64url')), {
      iss: 'TEAMID1234',
      iat: 1_000,
    });
    assert.equal(Buffer.from(signaturePart, 'base64url').length, 64);
    assert.equal(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      Buffer.from(signaturePart, 'base64url'),
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    ), true);
    driverPushTest.resetProviderTokenCache();
  });

  test('validates opaque APNs tokens, environment and allowlisted topics', () => {
    assert.equal(driverPushTest.validRegistration({
      device_token: deviceToken,
      environment: 'development',
      app_bundle_id: 'com.edenmish.edendriver.nativebeta',
    }, {}), true);
    assert.equal(driverPushTest.validRegistration({
      device_token: deviceToken,
      environment: 'sandbox',
      app_bundle_id: 'com.edenmish.edendriver.nativebeta',
    }, {}), false);
    assert.equal(driverPushTest.validRegistration({
      device_token: deviceToken,
      environment: 'production',
      app_bundle_id: 'com.example.attacker',
    }, {}), false);
  });

  test('upserts one authenticated installation without logging or returning its token', async () => {
    const DB = fakeDb();
    await registerDriverPushDevice(DB, {
      driverId: 'drv_eden',
      installationId: '22222222-2222-4222-8222-222222222222',
      deviceToken,
      environment: 'development',
      appBundleId: 'com.edenmish.edendriver.nativebeta',
      now: 1_000,
    });

    assert.equal(DB.calls.length, 2);
    assert.match(DB.calls[0].sql, /^DELETE FROM driver_push_devices/);
    assert.match(DB.calls[1].sql, /^INSERT INTO driver_push_devices/);
    assert.equal(DB.calls[1].args[0], '22222222-2222-4222-8222-222222222222');
    assert.equal(DB.calls[1].args[1], 'drv_eden');
    assert.equal(DB.calls[1].args[2], deviceToken);
  });

  test('removes only the authenticated driver installation', async () => {
    const DB = fakeDb();
    const removed = await unregisterDriverPushDevice(DB, {
      driverId: 'drv_eden',
      installationId: '22222222-2222-4222-8222-222222222222',
    });

    assert.equal(removed, true);
    assert.deepEqual(DB.calls[0].args, [
      '22222222-2222-4222-8222-222222222222',
      'drv_eden',
    ]);
  });

  test('sends a privacy-safe new-delivery alert to the correct APNs environment', async () => {
    const DB = fakeDb([{
      installation_id: 'installation',
      device_token: deviceToken,
      environment: 'development',
      app_bundle_id: 'com.edenmish.edendriver.nativebeta',
    }]);
    const requests = [];
    const result = await sendDriverRoutePush(configuredEnv(DB), {
      driverId: 'drv_eden',
      shiftId: 'sh_123',
      routeRevision: 7,
      addedStopIds: ['stop_p12', 'stop_d12'],
      now: 2_000,
    }, {
      tokenFactory: async () => 'provider.jwt',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 200 });
      },
    });

    assert.deepEqual(result, {
      configured: true,
      attempted: 1,
      sent: 1,
      failed: 0,
    });
    assert.equal(
      requests[0].url,
      `https://api.sandbox.push.apple.com/3/device/${deviceToken}`,
    );
    assert.equal(requests[0].init.headers['apns-topic'], 'com.edenmish.edendriver.nativebeta');
    assert.equal(requests[0].init.headers.authorization, 'bearer provider.jwt');
    const payload = JSON.parse(requests[0].init.body);
    assert.equal(payload.type, 'driver_new_delivery');
    assert.equal(payload.shift_id, 'sh_123');
    assert.equal(payload.route_revision, 7);
    assert.equal(payload.aps.alert.title, 'משלוח חדש הוקצה לך');
    assert.equal(payload.aps.alert.body, 'הפרטים מחכים באפליקציה');
    assert.equal(payload.aps['interruption-level'], 'active');
    assert.equal(payload.aps['content-available'], 1);
    assert.doesNotMatch(requests[0].init.body, /address|phone|customer|name/i);
  });

  test('uses the approved operational copy for a route-only update', () => {
    const payload = driverPushTest.routePayload({
      shiftId: 'sh_123',
      routeRevision: 8,
      hasNewDelivery: false,
    });

    assert.equal(payload.type, 'driver_route_updated');
    assert.equal(payload.aps.alert.title, 'המסלול עודכן');
    assert.equal(payload.aps.alert.body, 'מומלץ לבדוק את סדר העצירות החדש');
    assert.equal(payload.aps['interruption-level'], 'active');
  });

  test('disables an APNs token after a permanent provider rejection', async () => {
    const DB = fakeDb([{
      installation_id: 'installation',
      device_token: deviceToken,
      environment: 'production',
      app_bundle_id: 'com.edenmish.edendriver',
    }]);
    const result = await sendDriverRoutePush(configuredEnv(DB), {
      driverId: 'drv_eden',
      shiftId: 'sh_123',
      routeRevision: 8,
      now: 3_000,
    }, {
      tokenFactory: async () => 'provider.jwt',
      fetchImpl: async () => new Response(
        JSON.stringify({ reason: 'Unregistered' }),
        { status: 410, headers: { 'content-type': 'application/json' } },
      ),
    });

    assert.equal(result.failed, 1);
    const update = DB.calls.find((call) => call.sql.startsWith('UPDATE driver_push_devices'));
    assert.equal(update.args[0], 'Unregistered');
    assert.equal(update.args[1], 1);
    assert.equal(update.args[2], 3_000);
  });

  test('keeps a device enabled after a retryable provider or network failure', async () => {
    for (const failure of [
      {
        expectedReason: 'apns_http_429',
        fetchImpl: async () => new Response(null, { status: 429 }),
      },
      {
        expectedReason: 'socket_unavailable',
        fetchImpl: async () => {
          throw new Error('socket_unavailable');
        },
      },
    ]) {
      const DB = fakeDb([{
        installation_id: 'installation',
        device_token: deviceToken,
        environment: 'production',
        app_bundle_id: 'com.edenmish.edendriver',
      }]);
      const result = await sendDriverRoutePush(configuredEnv(DB), {
        driverId: 'drv_eden',
        shiftId: 'sh_123',
        routeRevision: 9,
        now: 4_000,
      }, {
        tokenFactory: async () => 'provider.jwt',
        fetchImpl: failure.fetchImpl,
      });

      assert.deepEqual(result, {
        configured: true,
        attempted: 1,
        sent: 0,
        failed: 1,
      });
      const update = DB.calls.find((call) => (
        call.sql.startsWith('UPDATE driver_push_devices')
      ));
      assert.equal(update.args[0], failure.expectedReason);
      assert.equal(update.args[1], 0);
      assert.equal(update.args[2], null);
    }
  });

  test('refreshes an expired provider token and retries the device once', async () => {
    const DB = fakeDb([{
      installation_id: 'installation',
      device_token: deviceToken,
      environment: 'production',
      app_bundle_id: 'com.edenmish.edendriver',
    }]);
    const authorizationHeaders = [];
    let tokenCount = 0;
    let requestCount = 0;
    const result = await sendDriverRoutePush(configuredEnv(DB), {
      driverId: 'drv_eden',
      shiftId: 'sh_123',
      routeRevision: 10,
      now: 5_000,
    }, {
      tokenFactory: async () => {
        tokenCount += 1;
        return `provider.jwt.${tokenCount}`;
      },
      fetchImpl: async (_url, init) => {
        requestCount += 1;
        authorizationHeaders.push(init.headers.authorization);
        if (requestCount === 1) {
          return new Response(
            JSON.stringify({ reason: 'ExpiredProviderToken' }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(null, { status: 200 });
      },
    });

    assert.deepEqual(result, {
      configured: true,
      attempted: 1,
      sent: 1,
      failed: 0,
    });
    assert.equal(tokenCount, 2);
    assert.deepEqual(authorizationHeaders, [
      'bearer provider.jwt.1',
      'bearer provider.jwt.2',
    ]);
    const updates = DB.calls.filter((call) => (
      call.sql.startsWith('UPDATE driver_push_devices')
    ));
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].args, [5_000, 5_000, 'installation', deviceToken]);
  });

  test('continues fan-out when one device is permanently rejected', async () => {
    const secondDeviceToken = 'cd'.repeat(32);
    const DB = fakeDb([
      {
        installation_id: 'installation-a',
        device_token: deviceToken,
        environment: 'production',
        app_bundle_id: 'com.edenmish.edendriver',
      },
      {
        installation_id: 'installation-b',
        device_token: secondDeviceToken,
        environment: 'production',
        app_bundle_id: 'com.edenmish.edendriver',
      },
    ]);
    const result = await sendDriverRoutePush(configuredEnv(DB), {
      driverId: 'drv_eden',
      shiftId: 'sh_123',
      routeRevision: 11,
      now: 6_000,
    }, {
      tokenFactory: async () => 'provider.jwt',
      fetchImpl: async (url) => (
        url.endsWith(deviceToken)
          ? new Response(
            JSON.stringify({ reason: 'BadDeviceToken' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
          : new Response(null, { status: 200 })
      ),
    });

    assert.deepEqual(result, {
      configured: true,
      attempted: 2,
      sent: 1,
      failed: 1,
    });
    const updates = DB.calls.filter((call) => (
      call.sql.startsWith('UPDATE driver_push_devices')
    ));
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0].args, [
      'BadDeviceToken',
      1,
      6_000,
      6_000,
      'installation-a',
      deviceToken,
    ]);
    assert.deepEqual(updates[1].args, [
      6_000,
      6_000,
      'installation-b',
      secondDeviceToken,
    ]);
  });

  test('cleans up stale and long-disabled installations at the retention boundary', async () => {
    const DB = fakeDb();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    await cleanupDriverPushDevices(DB, ninetyDays + 7_000);

    assert.match(DB.calls[0].sql, /^DELETE FROM driver_push_devices/);
    assert.deepEqual(DB.calls[0].args, [7_000, 7_000]);
  });

  test('fails open when APNs provider credentials are not configured', async () => {
    const DB = fakeDb();
    const result = await sendDriverRoutePush({ DB }, {
      driverId: 'drv_eden',
      shiftId: 'sh_123',
      routeRevision: 1,
    });

    assert.deepEqual(result, {
      configured: false,
      attempted: 0,
      sent: 0,
      failed: 0,
    });
    assert.equal(DB.calls.length, 0);
  });
});
