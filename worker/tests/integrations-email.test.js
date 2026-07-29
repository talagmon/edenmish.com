import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  emailRecipientAllowed,
  emailSubjectForEnv,
  sendEmail,
} from '../src/integrations.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('production email defaults preserve the existing sender and subject', async () => {
  let outbound = null;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
    outbound = JSON.parse(options.body);
    return new Response(null, { status: 202 });
  };

  const sent = await sendEmail(
    { SENDGRID_API_KEY: 'test-key' },
    { to: 'customer@example.com', subject: 'Subject', html: '<p>Hello</p>' },
  );

  assert.equal(sent, true);
  assert.deepEqual(outbound.from, {
    email: 'no-reply@edenmish.com',
    name: 'EdenMish',
  });
  assert.equal(outbound.subject, 'Subject');
  assert.equal(outbound.personalizations[0].to[0].email, 'customer@example.com');
});

test('staging email uses its isolated sender, prefix, and allowlisted recipient', async () => {
  let outbound = null;
  globalThis.fetch = async (_url, options) => {
    outbound = JSON.parse(options.body);
    return new Response(null, { status: 202 });
  };
  const env = {
    SENDGRID_API_KEY: 'staging-test-key',
    EMAIL_FROM_ADDRESS: 'no-reply-staging@edenmish.com',
    EMAIL_FROM_NAME: 'EdenMish Staging',
    EMAIL_SUBJECT_PREFIX: '[STAGING]',
    EMAIL_RECIPIENT_POLICY: 'allowlist',
    EMAIL_RECIPIENT_ALLOWLIST: 'qa-staging@edenmish.com',
  };

  const sent = await sendEmail(env, {
    to: ' QA-STAGING@EDENMISH.COM ',
    subject: 'קוד כניסה',
    html: '<p>123456</p>',
  });

  assert.equal(sent, true);
  assert.deepEqual(outbound.from, {
    email: 'no-reply-staging@edenmish.com',
    name: 'EdenMish Staging',
  });
  assert.equal(outbound.subject, '[STAGING] קוד כניסה');
  assert.equal(outbound.personalizations[0].to[0].email, 'QA-STAGING@EDENMISH.COM');
  assert.equal(emailSubjectForEnv(env, outbound.subject), outbound.subject);
});

test('allowlist mode blocks nonmatching, empty, and invalid policy configurations', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 202 });
  };

  const base = {
    SENDGRID_API_KEY: 'staging-test-key',
    EMAIL_RECIPIENT_POLICY: 'allowlist',
    EMAIL_RECIPIENT_ALLOWLIST: 'qa-staging@edenmish.com',
  };
  assert.equal(emailRecipientAllowed(base, 'customer@example.com'), false);
  assert.equal(await sendEmail(base, {
    to: 'customer@example.com',
    subject: 'Blocked',
    html: '<p>Blocked</p>',
  }), false);
  assert.equal(emailRecipientAllowed({
    ...base,
    EMAIL_RECIPIENT_ALLOWLIST: '',
  }, 'qa-staging@edenmish.com'), false);
  assert.equal(emailRecipientAllowed({
    ...base,
    EMAIL_RECIPIENT_POLICY: 'allowlsit',
  }, 'qa-staging@edenmish.com'), false);
  assert.equal(fetchCalls, 0);
});
