import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleDriverApi } from '../src/driver-api.js';
import worker from '../src/index.js';
import { makeSession } from '../src/integrations.js';
import {
  createDriverInvitation,
  driverInvitationCodeHash,
  driverInvitationTest,
  findUsableDriverInvitation,
  listDriverInvitations,
  markDriverInvitationConsumed,
  revokeDriverInvitation,
} from '../src/driver-invitations.js';

class SQLiteD1Statement {
  constructor(statement) {
    this.statement = statement;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    return this.statement.get(...this.args) || null;
  }

  async all() {
    return { results: this.statement.all(...this.args) };
  }

  async run() {
    const result = this.statement.run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class SQLiteD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE drivers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        locale TEXT NOT NULL DEFAULT 'he-IL',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE driver_sessions (
        id TEXT PRIMARY KEY,
        driver_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        login_code_hash TEXT NOT NULL UNIQUE,
        access_token_hash TEXT NOT NULL UNIQUE,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (driver_id) REFERENCES drivers(id)
      );
      CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        window_start INTEGER,
        last_at INTEGER,
        locked_until INTEGER
      );
    `);
    this.db.exec(
      readFileSync(
        new URL('../migrations/023_driver_login_invitations.sql', import.meta.url),
        'utf8',
      ),
    );
  }

  prepare(sql) {
    return new SQLiteD1Statement(this.db.prepare(sql));
  }

  async batch(statements) {
    const results = [];
    this.db.exec('BEGIN');
    try {
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const sessionSecret = 'test-session-secret-with-enough-entropy';
const requestId = '11111111-1111-4111-8111-111111111111';

function sessionRequest(code, installationId) {
  return new Request('https://ops-staging.edenmish.com/api/driver/v1/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.20',
      'x-request-id': requestId,
      'x-device-installation-id': installationId,
      'x-client-version': '1.2.0+300000',
    },
    body: JSON.stringify({ one_time_code: code }),
  });
}

function environment() {
  const DB = new SQLiteD1();
  DB.db.prepare(`INSERT INTO drivers (id, display_name, locale, active, created_at)
    VALUES ('drv_eden', 'Eden', 'he-IL', 1, 1)`).run();
  return { DB, SESSION_SECRET: sessionSecret };
}

describe('driver login invitations', () => {
  test('generates unbiased eight-digit codes', () => {
    for (let index = 0; index < 100; index += 1) {
      assert.match(driverInvitationTest.numericInvitationCode(), /^\d{8}$/);
    }
  });

  test('returns the code once while persisting only its keyed hash', async () => {
    const env = environment();
    const now = Date.parse('2026-07-23T08:00:00Z');

    const result = await createDriverInvitation(env, {
      driverId: 'drv_eden',
      expiresInMinutes: 15,
      now,
    });

    assert.equal(result.ok, true);
    assert.match(result.invitation.code, /^\d{8}$/);
    assert.equal(
      result.invitation.pairing_uri,
      `edenmish-driver://pair?code=${result.invitation.code}`,
    );
    assert.match(result.invitation.qr_svg, /^<svg/);
    const stored = env.DB.db.prepare(
      'SELECT code_hash, expires_at FROM driver_login_invitations WHERE id = ?',
    ).get(result.invitation.invitation_id);
    assert.match(stored.code_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.code_hash, result.invitation.code);
    assert.equal(stored.expires_at, now + 15 * 60 * 1000);
  });

  test('revokes an older active invitation when Ops issues a replacement', async () => {
    const env = environment();
    const first = await createDriverInvitation(env, {
      driverId: 'drv_eden',
      now: 1_000_000,
    });
    const second = await createDriverInvitation(env, {
      driverId: 'drv_eden',
      now: 1_001_000,
    });

    const invitations = await listDriverInvitations(env.DB, 1_001_000);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(invitations.map(({ state }) => state), ['active', 'revoked']);
  });

  test('leaves one active invitation when replacements are issued concurrently', async () => {
    const env = environment();

    const results = await Promise.all([
      createDriverInvitation(env, {
        driverId: 'drv_eden',
        now: 1_000_000,
      }),
      createDriverInvitation(env, {
        driverId: 'drv_eden',
        now: 1_000_001,
      }),
    ]);

    assert.ok(results.every(({ ok }) => ok));
    assert.equal(
      env.DB.db.prepare(`SELECT COUNT(*) AS count
        FROM driver_login_invitations
        WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
        .get(1_000_001).count,
      1,
    );
  });

  test('exchanges a valid invitation once and binds the session to its driver', async () => {
    const env = environment();
    const invite = await createDriverInvitation(env, {
      driverId: 'drv_eden',
      expiresInMinutes: 15,
    });
    const installationId = '22222222-2222-4222-8222-222222222222';

    const first = await handleDriverApi(
      sessionRequest(invite.invitation.code, installationId),
      env,
    );
    const replay = await handleDriverApi(
      sessionRequest(invite.invitation.code, installationId),
      env,
    );

    assert.equal(first.status, 201);
    assert.equal((await first.json()).driver.driver_id, 'drv_eden');
    assert.equal(replay.status, 401);
    const consumed = env.DB.db.prepare(`SELECT consumed_at, consumed_session_id,
      consumed_installation_id FROM driver_login_invitations WHERE id = ?`)
      .get(invite.invitation.invitation_id);
    assert.ok(consumed.consumed_at);
    assert.match(consumed.consumed_session_id, /^ds_[0-9a-f]+$/);
    assert.equal(consumed.consumed_installation_id, installationId);
  });

  test('rejects an expired or revoked invitation', async () => {
    const env = environment();
    const now = Date.parse('2026-07-23T08:00:00Z');
    const expired = await createDriverInvitation(env, {
      driverId: 'drv_eden',
      expiresInMinutes: 5,
      now,
    });
    assert.equal(
      await findUsableDriverInvitation(
        env,
        expired.invitation.code,
        now + 5 * 60 * 1000,
      ),
      null,
    );

    const active = await createDriverInvitation(env, {
      driverId: 'drv_eden',
      now: now + 10 * 60 * 1000,
    });
    assert.deepEqual(
      await revokeDriverInvitation(env.DB, active.invitation.invitation_id, now),
      { ok: true, status: 200 },
    );
    assert.equal(
      await findUsableDriverInvitation(env, active.invitation.code, now + 1),
      null,
    );
  });

  test('marks consumption without storing the raw invitation code', async () => {
    const env = environment();
    const invite = await createDriverInvitation(env, { driverId: 'drv_eden' });
    const invitation = await findUsableDriverInvitation(env, invite.invitation.code);
    const sessionId = 'ds_manual';
    env.DB.db.prepare(`INSERT INTO driver_sessions
      (id, driver_id, installation_id, login_code_hash, access_token_hash,
       refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
      VALUES (?, 'drv_eden', 'installation', ?, 'access', 'refresh', 2, 3, 1)`)
      .run(
        sessionId,
        await driverInvitationCodeHash(env, invite.invitation.code),
      );

    await markDriverInvitationConsumed(env.DB, {
      invitationId: invitation.id,
      sessionId,
      installationId: 'installation',
      now: 2,
    });

    assert.equal(
      env.DB.db.prepare('SELECT consumed_at FROM driver_login_invitations WHERE id = ?')
        .get(invitation.id).consumed_at,
      2,
    );
  });

  test('keeps the dedicated Apple review credential reusable and audited as sessions', async () => {
    const env = {
      ...environment(),
      DRIVER_REVIEW_CODE: '845921',
      DRIVER_ID: 'drv_eden',
      DRIVER_DISPLAY_NAME: 'Eden',
    };
    const first = await handleDriverApi(
      sessionRequest('845921', '22222222-2222-4222-8222-222222222222'),
      env,
    );
    const second = await handleDriverApi(
      sessionRequest('845921', '33333333-3333-4333-8333-333333333333'),
      env,
    );

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(
      env.DB.db.prepare('SELECT COUNT(*) AS count FROM driver_sessions').get().count,
      2,
    );
  });

  test('requires Ops authentication and accepts only the Ops or configured storefront origin', async () => {
    const env = environment();
    env.STOREFRONT_BASE = 'https://edenmish.com';
    env.ALLOWED_ORIGINS = 'https://edenmish.com';
    const session = await makeSession(env);
    const body = JSON.stringify({
      driver_id: 'drv_eden',
      expires_in_minutes: 15,
    });
    const unauthenticated = await worker.fetch(new Request(
      'https://ops.edenmish.com/api/ops/driver/invitations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://ops.edenmish.com' },
        body,
      },
    ), env);
    const untrusted = await worker.fetch(new Request(
      'https://ops.edenmish.com/api/ops/driver/invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `ops_sess=${session}`,
          origin: 'https://attacker.example',
        },
        body,
      },
    ), env);
    const storefront = await worker.fetch(new Request(
      'https://ops.edenmish.com/api/ops/driver/invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `ops_sess=${session}`,
          origin: 'https://edenmish.com',
        },
        body,
      },
    ), env);
    const sameOrigin = await worker.fetch(new Request(
      'https://ops.edenmish.com/api/ops/driver/invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `ops_sess=${session}`,
          origin: 'https://ops.edenmish.com',
        },
        body,
      },
    ), env);

    assert.equal(unauthenticated.status, 401);
    assert.equal(untrusted.status, 403);
    assert.equal(storefront.status, 201);
    assert.equal(
      storefront.headers.get('access-control-allow-origin'),
      'https://edenmish.com',
    );
    assert.match((await storefront.json()).invitation.code, /^\d{8}$/);
    assert.equal(sameOrigin.status, 201);
  });
});
