import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  approveBusinessBatchToken,
  businessBatchIdempotencyKey,
  signBusinessBatchToken,
  verifyBusinessBatchToken,
} from '../src/business-batch-approval.js';

describe('business batch approval tokens', () => {
  const env = { SESSION_SECRET: 'batch-approval-test-secret' };

  test('requires explicit approval and binds tokens to one business account', async () => {
    const now = Date.now();
    const token = await signBusinessBatchToken(
      env,
      10,
      'row',
      { external_id: 'ORD-1', recipient_name: 'נועה' },
      { now },
    );
    await assert.rejects(
      verifyBusinessBatchToken(env, 10, token, {
        kind: 'row',
        requireApproved: true,
        now: now + 1_000,
      }),
      /invalid_batch_approval/,
    );

    const approved = await approveBusinessBatchToken(env, 10, token, 'row');
    const payload = await verifyBusinessBatchToken(env, 10, approved, {
      kind: 'row',
      requireApproved: true,
    });
    assert.equal(payload.approved, true);
    assert.equal(payload.data.external_id, 'ORD-1');
    await assert.rejects(
      verifyBusinessBatchToken(env, 11, approved, { kind: 'row' }),
      /invalid_batch_approval/,
    );
  });

  test('rejects tampering and expired approvals', async () => {
    const token = await signBusinessBatchToken(
      env,
      10,
      'pickup',
      { address: 'הרצל 10' },
      { approved: true, now: 1_000 },
    );
    const [payload, signature] = token.split('.');
    await assert.rejects(
      verifyBusinessBatchToken(env, 10, `${payload}x.${signature}`, { kind: 'pickup' }),
      /invalid_batch_approval/,
    );
    await assert.rejects(
      verifyBusinessBatchToken(env, 10, token, {
        kind: 'pickup',
        now: 1_000 + 31 * 60 * 1_000,
      }),
      /batch_approval_expired/,
    );
  });

  test('creates a stable idempotency key from a normalized external id', async () => {
    assert.equal(
      await businessBatchIdempotencyKey(' ORD-2026-1042 '),
      await businessBatchIdempotencyKey('ord-2026-1042'),
    );
    assert.notEqual(
      await businessBatchIdempotencyKey('ORD-2026-1042'),
      await businessBatchIdempotencyKey('ORD-2026-1043'),
    );
  });
});
