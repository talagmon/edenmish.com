import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAddressText,
  resolveBusinessAddress,
  validateBusinessBatchAddresses,
} from '../src/business-address.js';

function place({
  route = 'הרצל',
  number = '10',
  city = 'תל אביב-יפו',
  id = 'place-1',
} = {}) {
  return {
    id,
    formattedAddress: `${route} ${number}, ${city}, ישראל`,
    location: { latitude: 32.08, longitude: 34.78 },
    types: ['street_address'],
    addressComponents: [
      { longText: number, shortText: number, types: ['street_number'] },
      { longText: route, shortText: route, types: ['route'] },
      { longText: city, shortText: city, types: ['locality'] },
      { longText: 'ישראל', shortText: 'IL', types: ['country'] },
    ],
  };
}

describe('business batch address validation', () => {
  test('normalizes punctuation and Hebrew final letters for comparisons', () => {
    assert.equal(normalizeAddressText('רח׳ הרצ״ך, 10'), 'הרצכ 10');
  });

  test('validates an exact address without rewriting customer entry details', () => {
    assert.deepEqual(
      resolveBusinessAddress('הרצל', '10', 'תל אביב', [place()]),
      {
        street: 'הרצל',
        city: 'תל אביב',
        corrections: [],
      },
    );
  });

  test('suggests a high-confidence correction for the street field only', () => {
    assert.deepEqual(
      resolveBusinessAddress('הרצך', '10', 'תל אביב', [place()]),
      {
        street: 'הרצל',
        city: 'תל אביב',
        corrections: [{
          field: 'delivery_street',
          from: 'הרצך',
          to: 'הרצל',
          reason: 'normalized_delivery_street',
          confidence: 'high',
          source: 'google_maps',
        }],
      },
    );
  });

  test('suggests a supported-city typo only when the resolved street is confident', () => {
    const result = resolveBusinessAddress('הרצל', '10', 'תל אבי', [place()]);
    assert.equal(result.city, 'תל אביב-יפו');
    assert.deepEqual(result.corrections, [{
      field: 'delivery_city',
      from: 'תל אבי',
      to: 'תל אביב-יפו',
      reason: 'normalized_delivery_city',
      confidence: 'high',
      source: 'google_maps',
    }]);
  });

  test('blocks missing house numbers, weak matches, and competing candidates', () => {
    assert.equal(
      resolveBusinessAddress('הרצל', '', 'תל אביב', [place()]).error,
      'missing_delivery_house_number',
    );
    assert.equal(
      resolveBusinessAddress('דיזנגוף', '10', 'תל אביב', [place()]).error,
      'invalid_delivery_address',
    );
    assert.equal(
      resolveBusinessAddress('הרצכ', '10', 'תל אביב', [
        place({ route: 'הרצל', id: 'one' }),
        place({ route: 'הרצנ', id: 'two' }),
      ]).error,
      'ambiguous_delivery_address',
    );
  });

  test('deduplicates provider lookups and fails closed when validation is unavailable', async () => {
    const makeRow = (rowNumber) => ({
      row_number: rowNumber,
      delivery_street: 'הרצך',
      delivery_house_number: '10',
      delivery_city: 'תל אביב',
      delivery_entrance: 'ב',
      delivery_floor: '2',
      delivery_apartment: '12',
      corrections: [],
      errors: [],
    });
    const rows = [makeRow(2), makeRow(3)];
    let calls = 0;
    const fetchImpl = async (_url, request) => {
      calls += 1;
      assert.match(request.body, /הרצך 10/);
      assert.equal(request.headers['X-Goog-FieldMask'].includes('places.addressComponents'), true);
      return {
        ok: true,
        async json() { return { places: [place()] }; },
      };
    };

    await validateBusinessBatchAddresses(rows, { apiKey: 'test-key', fetchImpl });
    assert.equal(calls, 1);
    assert.equal(rows[0].delivery_address, 'הרצל 10, כניסה ב, קומה 2, דירה 12');
    assert.equal(rows[1].delivery_address, 'הרצל 10, כניסה ב, קומה 2, דירה 12');
    assert.equal(rows[0].delivery_street, 'הרצל');
    assert.deepEqual(rows[0].errors, []);

    const unavailable = [makeRow(4)];
    await validateBusinessBatchAddresses(unavailable, { apiKey: '' });
    assert.deepEqual(unavailable[0].errors, ['address_validation_unavailable']);
  });
});
