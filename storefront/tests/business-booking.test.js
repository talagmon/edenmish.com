import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import businessBooking from '../public/assets/business-booking.js';

describe('Business booking decisions', () => {
  const plan = (rates, service) => ({ rates, value: { example: { service } } });

  test('selects the correct default and available services for every plan family', () => {
    const cases = [
      ['Trial', plan({ '1:eco': 30 }, 'eco'), ['eco'], 'eco'],
      ['Wallet', plan({ '1:eco': 30 }, 'eco'), ['eco'], 'eco'],
      ['Silver', plan({ '1:eco': 30, '1:standard': 45 }, 'standard'), ['eco', 'standard'], 'standard'],
      ['Gold', plan({ '1:eco': 30, '1:standard': 45, '1:flash': 85, '2:eco': 50 }, 'standard'), ['eco', 'standard', 'flash'], 'standard'],
      ['Platinum', plan({ '1:eco': 30, '1:standard': 45, '1:flash': 80, '3:standard': 104 }, 'standard'), ['eco', 'standard', 'flash'], 'standard'],
    ];
    for (const [name, input, available, preferred] of cases) {
      assert.deepEqual(businessBooking.planServiceState(input), { available, preferred }, name);
    }
  });

  test('falls back to the first included service if the recommendation is unavailable', () => {
    assert.deepEqual(
      businessBooking.planServiceState(plan({ '1:eco': 30 }, 'standard')),
      { available: ['eco'], preferred: 'eco' },
    );
  });

  test('waits for an authoritative business quote and requires another click to confirm it', async () => {
    let resolveQuote;
    const pending = businessBooking.prepareAuthoritativeQuote({
      businessMode: true,
      quote: null,
      quoteFingerprint: '',
      expectedFingerprint: 'eco|small|a|b|2026-07-22|9',
      fetchQuote: () => new Promise((resolve) => { resolveQuote = resolve; }),
    });
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    resolveQuote({ available: true, price: 30 });
    assert.deepEqual(await pending, {
      quote: { available: true, price: 30 },
      canSubmit: false,
      refreshed: true,
    });
  });

  test('fails closed when the authoritative business quote cannot be loaded', async () => {
    const result = await businessBooking.prepareAuthoritativeQuote({
      businessMode: true,
      quote: null,
      quoteFingerprint: '',
      expectedFingerprint: 'current',
      fetchQuote: async () => null,
    });
    assert.deepEqual(result, { quote: null, canSubmit: false, refreshed: true });
  });

  test('does not create an order on the click that obtains a new exact price', async () => {
    let orderCalls = 0;
    const exactQuote = { available: true, price: 60 };
    const submit = async ({ quote, quoteFingerprint }) => {
      const decision = await businessBooking.prepareAuthoritativeQuote({
        businessMode: true,
        quote,
        quoteFingerprint,
        expectedFingerprint: 'current',
        fetchQuote: async () => exactQuote,
      });
      if (!decision.quote || !decision.quote.available || !decision.canSubmit) return decision;
      orderCalls += 1;
      return decision;
    };

    const first = await submit({ quote: null, quoteFingerprint: '' });
    assert.equal(first.canSubmit, false);
    assert.equal(orderCalls, 0);
    const second = await submit({ quote: exactQuote, quoteFingerprint: 'current' });
    assert.equal(second.canSubmit, true);
    assert.equal(orderCalls, 1);
  });
});
