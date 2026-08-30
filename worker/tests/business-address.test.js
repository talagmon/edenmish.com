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
        latitude: 32.08,
        longitude: 34.78,
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
        latitude: 32.08,
        longitude: 34.78,
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
    assert.equal(result.latitude, 32.08);
    assert.equal(result.longitude, 34.78);
    assert.deepEqual(result.corrections, [{
      field: 'delivery_city',
      from: 'תל אבי',
      to: 'תל אביב-יפו',
      reason: 'normalized_delivery_city',
      confidence: 'high',
      source: 'google_maps',
    }]);
  });

  test('accepts an exact formatted postal address when provider components are incomplete', () => {
    const exactFormatted = {
      formattedAddress: 'שדרות מנחם בגין 5, בית דגן, ישראל',
      location: { latitude: 32.001, longitude: 34.829 },
      addressComponents: [],
    };
    assert.deepEqual(
      resolveBusinessAddress('מנחם בגין', '5', 'בית דגן', [exactFormatted]),
      {
        street: 'מנחם בגין',
        city: 'בית דגן',
        latitude: 32.001,
        longitude: 34.829,
        corrections: [],
      },
    );
  });

  test('prefers an exact formatted postal address over inconsistent provider components', () => {
    const exactFormatted = place({ route: 'השלום', number: '7', city: 'תל אביב' });
    exactFormatted.formattedAddress = 'הרכש 7, תל אביב, ישראל';
    assert.deepEqual(
      resolveBusinessAddress('הרכש', '7', 'תל אביב', [exactFormatted]),
      {
        street: 'הרכש',
        city: 'תל אביב',
        latitude: 32.08,
        longitude: 34.78,
        corrections: [],
      },
    );
  });

  test('accepts canonical street aliases with exact number, city and country', () => {
    const aliases = [
      ['שמואל יבניאלי', 'יבניאלי 24, גבעתיים 5360324, ישראל'],
      ['ז׳בוטינסקי', 'זאב ז׳בוטינסקי 24, גבעתיים, ישראל'],
      ['יעל רום', 'רום יעל 24, גבעתיים, ישראל'],
      ['קריניצי', '24 קריניצי, גבעתיים, ישראל'],
    ];
    for (const [declaredStreet, formattedAddress] of aliases) {
      const result = resolveBusinessAddress(declaredStreet, '24', 'גבעתיים', [{
        formattedAddress,
        location: { latitude: 32.07, longitude: 34.81 },
        addressComponents: [],
      }]);
      assert.equal(result.street, declaredStreet);
      assert.equal(result.city, 'גבעתיים');
      assert.deepEqual(result.corrections, []);
    }
  });

  test('keeps exact formatted fallback closed for a wrong house number or city', () => {
    const exactFormatted = {
      formattedAddress: 'זאב ז׳בוטינסקי 60 ב׳, תל אביב, ישראל',
      location: { latitude: 32.097, longitude: 34.795 },
      addressComponents: [],
    };
    assert.equal(
      resolveBusinessAddress('ז׳בוטינסקי', '60א', 'תל אביב', [exactFormatted]).error,
      'invalid_delivery_address',
    );
    assert.equal(
      resolveBusinessAddress('ז׳בוטינסקי', '60ב', 'רמת גן', [exactFormatted]).error,
      'invalid_delivery_address',
    );
    assert.equal(
      resolveBusinessAddress('ז׳בוטינסקי', '60', 'תל אביב', [exactFormatted]).error,
      'invalid_delivery_address',
    );
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
      assert.match(request.body, /"pageSize":10/);
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
    assert.equal(rows[0].delivery_lat, 32.08);
    assert.equal(rows[0].delivery_lng, 34.78);
    assert.deepEqual(rows[0].errors, []);

    const unavailable = [makeRow(4)];
    await validateBusinessBatchAddresses(unavailable, { apiKey: '' });
    assert.deepEqual(unavailable[0].errors, ['address_validation_unavailable']);
  });
});
