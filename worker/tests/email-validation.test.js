import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestEmailDomain, validateEmailAddress } from '../src/email-validation.js';

describe('public-order email validation', () => {
  test('normalizes and accepts valid provider and custom-domain addresses', () => {
    assert.deepEqual(
      validateEmailAddress('  Customer+Orders@Gmail.com  '),
      { valid: true, email: 'customer+orders@gmail.com' },
    );
    assert.deepEqual(
      validateEmailAddress('dispatch@agency.photography'),
      { valid: true, email: 'dispatch@agency.photography' },
    );
    assert.deepEqual(
      validateEmailAddress('orders@company.co.il'),
      { valid: true, email: 'orders@company.co.il' },
    );
    assert.deepEqual(
      validateEmailAddress('person@email.com'),
      { valid: true, email: 'person@email.com' },
    );
  });

  test('blocks gmail.con and returns a correction', () => {
    assert.deepEqual(
      validateEmailAddress('customer@gmail.con'),
      {
        valid: false,
        code: 'invalid_email_domain',
        suggestion: 'customer@gmail.com',
      },
    );
  });

  test('blocks the observed Israeli suffix typo', () => {
    assert.deepEqual(
      validateEmailAddress('customer@company.co.ik'),
      {
        valid: false,
        code: 'invalid_email_domain',
        suggestion: 'customer@company.co.il',
      },
    );
  });

  test('blocks common provider typos without rejecting unrelated domains', () => {
    assert.equal(suggestEmailDomain('gmial.com'), 'gmail.com');
    assert.equal(suggestEmailDomain('gmaillabs.com'), null);
  });

  test('rejects malformed local parts and domain labels', () => {
    for (const email of [
      'customer..orders@example.com',
      '.customer@example.com',
      'customer@example..com',
      'customer@-example.com',
      'customer@example',
      'customer@@example.com',
    ]) {
      assert.deepEqual(validateEmailAddress(email), {
        valid: false,
        code: 'invalid_email',
      });
    }
  });
});
