import { test, describe } from 'node:test';
import assert from 'node:assert';
import scheduling from '../public/assets/scheduling.js';

describe('Pickup scheduling', () => {
  test('offers the remaining Eco pickup window at 08:47', () => {
    const windows = scheduling.generatePickupWindows({
      service: 'eco',
      dateType: 'today',
      day: 0,
      now: new Date(2026, 6, 12, 8, 47),
    });

    assert.deepEqual(windows, ['12:00-13:00']);
  });

  test('closes same-day Eco ordering after the lead time reaches 13:00', () => {
    const windows = scheduling.generatePickupWindows({
      service: 'eco',
      dateType: 'today',
      day: 0,
      now: new Date(2026, 6, 12, 9, 1),
    });

    assert.deepEqual(windows, []);
  });

  test('keeps full three-hour Eco windows for future dates', () => {
    const windows = scheduling.generatePickupWindows({
      service: 'eco',
      dateType: 'future',
      day: 1,
    });

    assert.deepEqual(windows, ['09:00-12:00', '10:00-13:00']);
  });

  test('does not offer Saturday pickup windows', () => {
    assert.deepEqual(scheduling.generatePickupWindows({
      service: 'standard',
      dateType: 'future',
      day: 6,
    }), []);
  });
});
