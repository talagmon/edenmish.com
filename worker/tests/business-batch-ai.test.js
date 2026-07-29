import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUSINESS_BATCH_AI_MODEL,
  businessBatchHeaderCandidates,
  normalizeBusinessBatchTable,
  normalizeBusinessBatchTableWithAi,
} from '../src/business-batch-ai.js';

function mockAi(...responses) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { response };
    },
  };
}

const mapping = {
  sheet_index: 0,
  header_row_number: 2,
  mappings: [
    { field: 'external_id', column_index: 0, confidence: 98 },
    { field: 'recipient_name', column_index: 1, confidence: 97 },
    { field: 'recipient_phone', column_index: 2, confidence: 97 },
    { field: 'delivery_street', column_index: 3, confidence: 94 },
    { field: 'delivery_house_number', column_index: 3, confidence: 94 },
    { field: 'delivery_city', column_index: 3, confidence: 94 },
    { field: 'delivery_floor', column_index: 3, confidence: 90 },
    { field: 'pickup_date', column_index: 4, confidence: 96 },
    { field: 'pickup_hour', column_index: 4, confidence: 96 },
    { field: 'package_size', column_index: 5, confidence: 95 },
    { field: 'notes', column_index: 6, confidence: 95 },
  ],
};

const normalizedRow = {
  rows: [{
    source_row_number: 3,
    fields: [
      { field: 'external_id', value: 'ORD-7', source_columns: [0], confidence: 99 },
      { field: 'recipient_name', value: 'נועה לוי', source_columns: [1], confidence: 99 },
      { field: 'recipient_phone', value: '050-123-4567', source_columns: [2], confidence: 99 },
      { field: 'delivery_street', value: 'הרצל', source_columns: [3], confidence: 95 },
      { field: 'delivery_house_number', value: '10', source_columns: [3], confidence: 95 },
      { field: 'delivery_city', value: 'תל אביב', source_columns: [3], confidence: 95 },
      { field: 'delivery_floor', value: '2', source_columns: [3], confidence: 92 },
      { field: 'pickup_date', value: '2026-08-03', source_columns: [4], confidence: 97 },
      { field: 'pickup_hour', value: '09:00', source_columns: [4], confidence: 97 },
      { field: 'package_size', value: 'small', source_columns: [5], confidence: 94 },
      { field: 'notes', value: 'להתקשר', source_columns: [6], confidence: 96 },
    ],
  }],
};

const table = {
  date1904: false,
  rows: [
    ['דוח משלוחים שבועי'],
    ['המספר שלנו', 'למי', 'נייד', 'יעד מלא', 'מתי לאסוף', 'סוג פריט', 'הנחיה'],
    ['ORD-7', 'נועה לוי', '050-123-4567', 'הרצל 10, תל אביב, קומה 2', '03/08/2026 09:00', 'מעטפה קטנה', 'להתקשר'],
  ],
};

describe('AI-assisted business batch normalization', () => {
  test('bypasses inference when the deterministic template headers are recognized', async () => {
    const ai = mockAi(new Error('must not run'));
    const templateTable = {
      date1904: false,
      rows: [
        [
          'External ID',
          'Recipient name',
          'Recipient phone',
          'Delivery street',
          'House number',
          'Delivery city',
          'Pickup date',
          'Pickup hour',
          'Package size',
        ],
        ['ORD-9', 'נועה לוי', '0501234567', 'הרצל', '10', 'תל אביב', '2026-08-03', '09:00', 'small'],
      ],
    };

    const result = await normalizeBusinessBatchTable(ai, templateTable, {
      today: '2026-08-01',
    });

    assert.equal(result.import_mode, 'template');
    assert.equal(result.smart_import, null);
    assert.equal(result.rows[0].errors.length, 0);
    assert.equal(ai.calls.length, 0);
  });

  test('maps an unfamiliar sheet into the deterministic canonical validator', async () => {
    const ai = mockAi(mapping, normalizedRow);
    const result = await normalizeBusinessBatchTableWithAi(ai, table, {
      today: '2026-08-01',
    });

    assert.equal(ai.calls.length, 2);
    assert.equal(ai.calls[0].model, BUSINESS_BATCH_AI_MODEL);
    assert.equal(ai.calls[0].input.response_format.type, 'json_schema');
    assert.match(ai.calls[0].input.messages[0].content, /untrusted data/);
    assert.equal(result.meta.header_row_number, 2);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(
      {
        row_number: result.rows[0].row_number,
        external_id: result.rows[0].external_id,
        recipient_phone: result.rows[0].recipient_phone,
        delivery_address: result.rows[0].delivery_address,
        delivery_city: result.rows[0].delivery_city,
        pickup_date: result.rows[0].pickup_date,
        pickup_hour: result.rows[0].pickup_hour,
        package_size: result.rows[0].package_size,
        notes: result.rows[0].notes,
        ai_assisted: result.rows[0].ai_assisted,
        errors: result.rows[0].errors,
      },
      {
        row_number: 3,
        external_id: 'ORD-7',
        recipient_phone: '+972501234567',
        delivery_address: 'הרצל 10, קומה 2',
        delivery_city: 'תל אביב',
        pickup_date: '2026-08-03',
        pickup_hour: 9,
        package_size: 'small',
        notes: 'להתקשר',
        ai_assisted: true,
        errors: [],
      },
    );
    assert.ok(result.rows[0].corrections.some((item) => (
      item.field === 'delivery_street'
      && item.source === 'workers_ai'
    )));
  });

  test('reuses an account-approved header mapping without another mapping-model call', async () => {
    const candidates = await businessBatchHeaderCandidates(table);
    const header = candidates.find((candidate) => candidate.header_row_number === 2);
    const ai = mockAi(normalizedRow);
    const result = await normalizeBusinessBatchTable(ai, table, {
      today: '2026-08-01',
      loadSavedMappings: async (signatures) => {
        assert.ok(signatures.includes(header.signature));
        return new Map([[
          header.signature,
          { signature: header.signature, mappings: mapping.mappings },
        ]]);
      },
    });

    assert.equal(result.import_mode, 'saved_mapping');
    assert.equal(result.smart_import.mapping_source, 'saved');
    assert.equal(result.smart_import.mapping_signature, header.signature);
    assert.equal(ai.calls.length, 1);
    assert.match(ai.calls[0].input.messages[0].content, /Convert spreadsheet rows/);
    assert.equal(result.rows[0].external_id, 'ORD-7');
  });

  test('reuses a dedicated-column mapping without invoking the model at all', async () => {
    const dedicatedTable = {
      date1904: false,
      rows: [
        ['Our ID', 'Who', 'Mobile', 'Street', 'No.', 'Town', 'Day', 'Hour', 'Parcel'],
        ['ORD-10', 'נועה לוי', '0501234567', 'הרצל', '10', 'תל אביב', '2026-08-03', '09:00', 'small'],
      ],
    };
    const candidates = await businessBatchHeaderCandidates(dedicatedTable);
    const signature = candidates.find((candidate) => candidate.header_row_number === 1).signature;
    const mappings = [
      ['external_id', 0],
      ['recipient_name', 1],
      ['recipient_phone', 2],
      ['delivery_street', 3],
      ['delivery_house_number', 4],
      ['delivery_city', 5],
      ['pickup_date', 6],
      ['pickup_hour', 7],
      ['package_size', 8],
    ].map(([field, column_index]) => ({ field, column_index, confidence: 95 }));
    const ai = mockAi(new Error('must not run'));

    const result = await normalizeBusinessBatchTable(ai, dedicatedTable, {
      today: '2026-08-01',
      loadSavedMappings: async () => new Map([[signature, { signature, mappings }]]),
    });

    assert.equal(result.import_mode, 'saved_mapping');
    assert.equal(result.rows[0].saved_mapping, true);
    assert.equal(result.smart_import.row_normalization, 'deterministic');
    assert.equal(result.rows[0].errors.length, 0);
    assert.equal(ai.calls.length, 0);
  });

  test('never accepts an ungrounded model rewrite from another city', async () => {
    const distinctCityTable = {
      date1904: false,
      rows: [
        ['ID', 'Name', 'Phone', 'Street', 'No', 'City', 'Date', 'Time', 'Size'],
        ['ORD-8', 'רון', '0501234567', 'הרצל', '10', 'תל אביב', '2026-08-03', '09:00', 'קטן'],
      ],
    };
    const distinctMapping = {
      sheet_index: 0,
      header_row_number: 1,
      mappings: [
        { field: 'external_id', column_index: 0, confidence: 99 },
        { field: 'recipient_name', column_index: 1, confidence: 99 },
        { field: 'recipient_phone', column_index: 2, confidence: 99 },
        { field: 'delivery_street', column_index: 3, confidence: 99 },
        { field: 'delivery_house_number', column_index: 4, confidence: 99 },
        { field: 'delivery_city', column_index: 5, confidence: 99 },
        { field: 'pickup_date', column_index: 6, confidence: 99 },
        { field: 'pickup_hour', column_index: 7, confidence: 99 },
        { field: 'package_size', column_index: 8, confidence: 99 },
      ],
    };
    const response = {
      rows: [{
        source_row_number: 2,
        fields: [
          { field: 'delivery_city', value: 'חיפה', source_columns: [5], confidence: 99 },
        ],
      }],
    };
    const ai = mockAi(distinctMapping, response);

    const result = await normalizeBusinessBatchTableWithAi(ai, distinctCityTable, {
      today: '2026-08-01',
    });

    assert.equal(result.rows[0].delivery_city, 'תל אביב');
    assert.equal(result.rows[0].errors.length, 0);
  });

  test('does not accept an invented date merely because a date source cell exists', async () => {
    const response = {
      rows: [{
        ...normalizedRow.rows[0],
        fields: normalizedRow.rows[0].fields.map((item) => (
          item.field === 'pickup_date'
            ? { ...item, value: '2026-08-04', confidence: 99 }
            : item
        )),
      }],
    };
    const ai = mockAi(mapping, response);

    const result = await normalizeBusinessBatchTableWithAi(ai, table, {
      today: '2026-08-01',
    });

    assert.ok(result.rows[0].errors.includes('invalid_pickup_date'));
    assert.notEqual(result.rows[0].pickup_date, '2026-08-04');
  });

  test('allows the bounded mapper to select a delivery sheet after a cover sheet', async () => {
    const multiSheetTable = {
      date1904: false,
      rows: [['Instructions'], ['Do not edit this sheet']],
      sheets: [
        [['Instructions'], ['Do not edit this sheet']],
        table.rows,
      ],
    };
    const ai = mockAi(
      { ...mapping, sheet_index: 1 },
      normalizedRow,
    );

    const result = await normalizeBusinessBatchTableWithAi(ai, multiSheetTable, {
      today: '2026-08-01',
    });

    assert.equal(result.meta.sheet_index, 1);
    assert.equal(result.rows[0].external_id, 'ORD-7');
    const preview = JSON.parse(ai.calls[0].input.messages[1].content).preview_sheets;
    assert.deepEqual(preview.map((sheet) => sheet.sheet_index), [0, 1]);
  });

  test('routes low-confidence required fields to customer review instead of importing', async () => {
    const ai = mockAi(
      {
        ...mapping,
        mappings: mapping.mappings.map((item) => (
          item.field === 'delivery_city' ? { ...item, confidence: 55 } : item
        )),
      },
      {
        rows: [{
          ...normalizedRow.rows[0],
          fields: normalizedRow.rows[0].fields.map((item) => (
            item.field === 'delivery_city' ? { ...item, confidence: 55 } : item
          )),
        }],
      },
    );

    const result = await normalizeBusinessBatchTableWithAi(ai, table, {
      today: '2026-08-01',
    });

    assert.ok(result.rows[0].errors.includes('ai_low_confidence'));
    assert.equal(result.rows[0].ai_confidence, 55);
  });

  test('rejects a source row when the model omits its normalized-row result', async () => {
    const ai = mockAi(mapping, { rows: [] });

    const result = await normalizeBusinessBatchTableWithAi(ai, table, {
      today: '2026-08-01',
    });

    assert.ok(result.rows[0].errors.includes('ai_low_confidence'));
  });

  test('rejects source rows wider than the bounded AI input', async () => {
    const wideTable = {
      date1904: false,
      rows: [
        Array.from({ length: 25 }, (_, index) => `Column ${index + 1}`),
        Array.from({ length: 25 }, (_, index) => `Value ${index + 1}`),
      ],
    };
    const ai = mockAi(mapping, normalizedRow);

    await assert.rejects(
      () => normalizeBusinessBatchTableWithAi(ai, wideTable),
      /too_many_columns/,
    );
    assert.equal(ai.calls.length, 0);
  });

  test('fails closed when the model binding or structured response is unavailable', async () => {
    await assert.rejects(
      () => normalizeBusinessBatchTableWithAi(null, table),
      /smart_import_unavailable/,
    );
    await assert.rejects(
      () => normalizeBusinessBatchTableWithAi(mockAi('not-json'), table),
      /smart_import_invalid/,
    );
  });
});
