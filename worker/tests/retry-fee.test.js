import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { retryFee, DEFAULT_PRICING_RULES } from '../src/pricing.js';

describe('extra-stop retry fee', () => {
  test('prices per zone at half a standard delivery', () => {
    // Zone is the max of the two ends, exactly as priceOrder computes it.
    assert.equal(retryFee({ pickup_city: 'תל אביב', dropoff_city: 'תל אביב' }).fee, 25);
    assert.equal(retryFee({ pickup_city: 'תל אביב', dropoff_city: 'חולון' }).fee, 35);
    assert.equal(retryFee({ pickup_city: 'תל אביב', dropoff_city: 'כפר סבא' }).fee, 60);

    // Each tier really is half the standard base for its zone, so the anchor is not arbitrary.
    for (const zone of [1, 2, 3]) {
      const retry = DEFAULT_PRICING_RULES['retry_z' + zone];
      const standard = DEFAULT_PRICING_RULES['std_z' + zone];
      assert.ok(
        Math.abs(retry - standard / 2) <= 3,
        `retry_z${zone}=${retry} should sit near half of std_z${zone}=${standard}`,
      );
    }
  });

  test('returning a package home is cheaper than pushing it further out', () => {
    // Same package held in Zone 1. Bringing it back is a Zone 1 leg; redelivering it to
    // Zone 3 is a Zone 3 leg. The asymmetry is the point.
    const home = retryFee({ pickup_city: 'תל אביב', dropoff_city: 'תל אביב' });
    const further = retryFee({ pickup_city: 'תל אביב', dropoff_city: 'רמלה' });

    assert.equal(home.zone, 1);
    assert.equal(further.zone, 3);
    assert.ok(further.fee > home.fee);
  });

  test('applies the Saturday multiplier and the evening surcharge', () => {
    const saturday = retryFee({
      pickup_city: 'תל אביב', dropoff_city: 'תל אביב', when_date: '2026-07-25',
    });
    assert.equal(saturday.breakdown.weekend_multiplier, 1.5);
    assert.equal(saturday.fee, 38); // round(25 × 1.5)

    const evening = retryFee({
      pickup_city: 'תל אביב', dropoff_city: 'תל אביב', when_hour: 20,
    });
    assert.equal(evening.breakdown.evening_surcharge, 30);
    assert.equal(evening.fee, 50); // 25 + 30, still within the Zone 1 cap
  });

  test('never charges more than booking a fresh delivery for the zone', () => {
    // Zone 1 Saturday evening would otherwise reach 38 + 30 = 68, above the 50 standard.
    const capped = retryFee({
      pickup_city: 'תל אביב',
      dropoff_city: 'תל אביב',
      when_date: '2026-07-25',
      when_hour: 20,
    });

    assert.ok(capped.capped);
    assert.equal(capped.fee, DEFAULT_PRICING_RULES.std_z1);
  });

  test('does not re-apply the size surcharge the original order already paid', () => {
    const small = retryFee({ pickup_city: 'תל אביב', dropoff_city: 'תל אביב', size: 'small' });
    const medium = retryFee({ pickup_city: 'תל אביב', dropoff_city: 'תל אביב', size: 'medium' });

    assert.equal(medium.fee, small.fee);
  });

  test('flags an out-of-zone leg for review instead of guessing a fee', () => {
    const result = retryFee({ pickup_city: 'אילת', dropoff_city: 'באר שבע' });

    assert.equal(result.fee, null);
    assert.ok(result.review);
    assert.deepEqual(result.reasons, ['out_of_zone']);
  });

  test('honours pricing_rules overrides so the business can retune without a deploy', () => {
    const result = retryFee(
      { pickup_city: 'תל אביב', dropoff_city: 'תל אביב' },
      { retry_z1: 40, std_z1: 200 },
    );

    assert.equal(result.fee, 40);
    assert.equal(result.capped, false);
  });
});
