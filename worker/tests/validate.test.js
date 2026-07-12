import { test, describe } from 'node:test';
import assert from 'node:assert';
import { scheduleError, validIsraeliId } from '../src/validate.js';

describe('validIsraeliId', () => {
  test('accepts a valid checksum and normalized punctuation', () => {
    assert.equal(validIsraeliId('039-284286'), true);
  });

  test('rejects an invalid checksum and non-numeric input', () => {
    assert.equal(validIsraeliId('039284287'), false);
    assert.equal(validIsraeliId('not-an-id'), false);
  });
});

describe('scheduleError', () => {
  test('accepts the final Eco pickup hour before 13:00', () => {
    assert.equal(scheduleError('eco', 0, 12), null);
  });

  test('rejects Eco pickup at or after 13:00', () => {
    assert.equal(scheduleError('eco', 0, 13), 'outside_hours');
    assert.equal(scheduleError('eco', 0, 19), 'outside_hours');
  });

  test('keeps standard weekday hours unchanged', () => {
    assert.equal(scheduleError('standard', 0, 19), null);
    assert.equal(scheduleError('standard', 0, 20), 'outside_hours');
  });

  test('rejects all Saturday pickups', () => {
    assert.equal(scheduleError('eco', 6, 10), 'closed_saturday');
  });
});
