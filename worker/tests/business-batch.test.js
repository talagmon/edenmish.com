import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

import {
  MAX_BUSINESS_BATCH_ROWS,
  normalizeBusinessAddressInput,
  parseBusinessBatchFile,
} from '../src/business-batch.js';

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templatePath = resolve(workerRoot, '../storefront/public/downloads/edenmish-business-batch-template.xlsx');
const encode = (value) => new TextEncoder().encode(value);

function inlineCell(reference, value) {
  return `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
}

function multiSheet1904Workbook() {
  const headers = [
    'מזהה משלוח', 'שם', 'טלפון', 'רחוב', 'מספר בית', 'עיר', 'תאריך', 'שעה', 'גודל',
  ];
  const serial = Math.round(
    (Date.UTC(2026, 7, 3) - Date.UTC(1904, 0, 1)) / 86_400_000,
  );
  const columns = 'ABCDEFGHI';
  const headerCells = headers.map((value, index) => inlineCell(`${columns[index]}1`, value)).join('');
  const rowCells = [
    inlineCell('A2', 'ORD-1904'),
    inlineCell('B2', 'נועה'),
    inlineCell('C2', '0501234567'),
    inlineCell('D2', 'הרצל'),
    inlineCell('E2', '10'),
    inlineCell('F2', 'תל אביב'),
    `<c r="G2"><v>${serial}</v></c>`,
    '<c r="H2"><v>0.375</v></c>',
    inlineCell('I2', 'קטן'),
  ].join('');
  return zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<workbookPr date1904="1"/><sheets>'
      + '<sheet name="הוראות" sheetId="1" r:id="rId1"/>'
      + '<sheet name="משלוחים" sheetId="2" r:id="rId2"/>'
      + '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
      + '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + `<row r="1">${inlineCell('A1', 'הוראות למילוי')}</row>`
      + '</sheetData></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + `<row r="1">${headerCells}</row><row r="2">${rowCells}</row>`
      + '</sheetData></worksheet>',
    ),
  });
}

function sparseOptionalCellsWorkbook() {
  const headers = [
    'מזהה משלוח', 'שם', 'טלפון', 'רחוב', 'מספר בית', 'עיר',
    'כניסה', 'קומה', 'דירה', 'תאריך', 'שעה', 'גודל',
  ];
  const serial = Math.round(
    (Date.UTC(2026, 7, 3) - Date.UTC(1899, 11, 30)) / 86_400_000,
  );
  const columns = 'ABCDEFGHIJKL';
  const headerCells = headers.map((value, index) => inlineCell(`${columns[index]}1`, value)).join('');
  const rowCells = [
    inlineCell('A2', 'ORD-SPARSE'),
    inlineCell('B2', 'נועה'),
    inlineCell('C2', '0501234567'),
    inlineCell('D2', 'אבן גבירול'),
    inlineCell('E2', '71'),
    inlineCell('F2', 'תל אביב'),
    '<c r="G2"/><c r="H2"/><c r="I2"/>',
    `<c r="J2"><v>${serial}</v></c>`,
    inlineCell('K2', '10:00'),
    inlineCell('L2', 'בינוני'),
  ].join('');
  return zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="משלוחים" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + `<row r="1">${headerCells}</row><row r="2">${rowCells}</row>`
      + '</sheetData></worksheet>',
    ),
  });
}

describe('business batch file parser', () => {
  test('normalizes a structured pickup address with pickup-specific approval metadata', () => {
    assert.deepEqual(
      normalizeBusinessAddressInput({
        street: 'הרצל',
        house_number: '10 א',
        city: 'תל אביב',
        entrance: 'כניסה ב',
        floor: 'קומה 2',
        apartment: 'דירה 12',
      }, 'pickup'),
      {
        street: 'הרצל',
        house_number: '10א',
        city: 'תל אביב',
        entrance: 'ב',
        floor: '2',
        apartment: '12',
        address: 'הרצל 10א, כניסה ב, קומה 2, דירה 12',
        corrections: [
          {
            field: 'pickup_house_number',
            from: '10 א',
            to: '10א',
            reason: 'normalized_pickup_house_number',
            confidence: 'high',
          },
          {
            field: 'pickup_entrance',
            from: 'כניסה ב',
            to: 'ב',
            reason: 'normalized_pickup_entrance',
            confidence: 'high',
          },
          {
            field: 'pickup_floor',
            from: 'קומה 2',
            to: '2',
            reason: 'normalized_pickup_floor',
            confidence: 'high',
          },
          {
            field: 'pickup_apartment',
            from: 'דירה 12',
            to: '12',
            reason: 'normalized_pickup_apartment',
            confidence: 'high',
          },
        ],
        errors: [],
      },
    );
  });

  test('maps the Hebrew template columns and normalizes recipient phones', () => {
    const csv = [
      'מזהה משלוח *,שם נמען *,טלפון נמען *,רחוב מסירה *,מספר בית *,עיר מסירה *,כניסה,קומה,דירה,תאריך איסוף *,שעת איסוף *,גודל חבילה *,לקוח/ספק,תכולה,הערות לשליח',
      'ORD-1042,נועה לוי,050-123-4567,הרצל,10,תל אביב,ב,2,12,2026-08-03,09:00,קטן,לקוח 1042,מארז מתנה,להתקשר בהגעה',
    ].join('\n');

    assert.deepEqual(parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' }), [{
      row_number: 2,
      external_id: 'ORD-1042',
      recipient_name: 'נועה לוי',
      recipient_phone: '+972501234567',
      delivery_street: 'הרצל',
      delivery_house_number: '10',
      delivery_city: 'תל אביב',
      delivery_entrance: 'ב',
      delivery_floor: '2',
      delivery_apartment: '12',
      pickup_date: '2026-08-03',
      pickup_hour: 9,
      package_size: 'small',
      reference: 'לקוח 1042',
      contents: 'מארז מתנה',
      notes: 'להתקשר בהגעה',
      corrections: [],
      errors: [],
      delivery_address: 'הרצל 10, כניסה ב, קומה 2, דירה 12',
    }]);
  });

  test('reimports the canonical repair CSV with extra error columns and guarded cells', () => {
    const csv = [
      'מזהה משלוח,שם נמען,טלפון נמען,רחוב מסירה,מספר בית,עיר מסירה,כניסה,קומה,דירה,תאריך איסוף,שעת איסוף,גודל חבילה,לקוח/ספק,תכולה,הערות לשליח,שורת מקור,שגיאות לתיקון',
      'ORD-RETRY,נועה לוי,"\t+972501234567",הרצל,10,תל אביב,ב,2,12,2026-08-03,09:00,small,לקוח 7,מסמכים,להתקשר,18,תוקן',
    ].join('\r\n');

    const [row] = parseBusinessBatchFile(encode(csv), {
      fileName: 'edenmish-batch-errors.csv',
      today: '2026-08-01',
    });

    assert.equal(row.external_id, 'ORD-RETRY');
    assert.equal(row.recipient_phone, '+972501234567');
    assert.equal(row.pickup_hour, 9);
    assert.equal(row.errors.length, 0);
  });

  test('returns row-level errors instead of discarding incomplete recipients', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל',
      'ORD-1,נועה,123,הרצל,10,,2026-02-30,09:30,ענק',
    ].join('\n');

    const [row] = parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' });
    assert.deepEqual(row.errors, [
      'missing_delivery_city',
      'invalid_recipient_phone',
      'invalid_pickup_date',
      'invalid_pickup_hour',
      'invalid_package_size',
    ]);
  });

  test('normalizes supported whole-hour spellings and records approval metadata', () => {
    for (const [value, canonical] of [['8', '08:00'], ['08', '08:00'], ['8:00', '08:00'], ['19:00', null]]) {
    const csv = [
        'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל',
        `ORD-${value},נועה,0501234567,הרצל,10,תל אביב,2026-08-07,${value},בינוני`,
      ].join('\n');
      const [row] = parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' });
      assert.equal(row.pickup_hour, value.startsWith('19') ? 19 : 8);
      assert.equal(row.package_size, 'medium');
      assert.deepEqual(row.corrections, canonical ? [{
        field: 'pickup_hour',
        from: value,
        to: canonical,
        reason: 'normalized_pickup_hour',
        confidence: 'high',
      }] : []);
      assert.deepEqual(row.errors, []);
    }
  });

  test('reads native Excel time fractions as whole-hour slots', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל',
      'ORD-1,נועה,0501234567,הרצל,10,תל אביב,2026-08-03,0.375,קטן',
    ].join('\n');
    const [row] = parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' });
    assert.equal(row.pickup_hour, 9);
    assert.deepEqual(row.errors, []);
    assert.deepEqual(row.corrections, []);
  });

  test('suggests high-confidence Israeli date corrections but rejects ambiguous invalid dates', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל',
      'ORD-1,נועה,0501234567,הרצל,10,תל אביב,3/8/2026,09:00,קטן',
      'ORD-2,עמית,0501234567,הרצל,11,תל אביב,08/13/2026,10:00,קטן',
    ].join('\n');

    const [corrected, invalid] = parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' });
    assert.equal(corrected.pickup_date, '2026-08-03');
    assert.deepEqual(corrected.corrections, [{
      field: 'pickup_date',
      from: '3/8/2026',
      to: '2026-08-03',
      reason: 'normalized_date_format',
      confidence: 'high',
    }]);
    assert.deepEqual(corrected.errors, []);
    assert.deepEqual(invalid.errors, ['invalid_pickup_date']);
  });

  test('reads a native Excel date serial without asking for correction approval', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל',
      'ORD-1,נועה,0501234567,הרצל,10,תל אביב,46237,09:00,קטן',
    ].join('\n');

    const [row] = parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' });
    assert.equal(row.pickup_date, '2026-08-03');
    assert.deepEqual(row.corrections, []);
    assert.deepEqual(row.errors, []);
  });

  test('preserves column positions after self-closing blank optional XLSX cells', () => {
    const [row] = parseBusinessBatchFile(sparseOptionalCellsWorkbook(), {
      fileName: 'sparse-optional-cells.xlsx',
    });
    assert.equal(row.delivery_entrance, '');
    assert.equal(row.delivery_floor, '');
    assert.equal(row.delivery_apartment, '');
    assert.equal(row.pickup_date, '2026-08-03');
    assert.equal(row.pickup_hour, 10);
    assert.equal(row.package_size, 'medium');
    assert.deepEqual(row.errors, []);
  });

  test('selects the worksheet by recognized headers and supports Excel 1904 dates and time cells', () => {
    const [row] = parseBusinessBatchFile(multiSheet1904Workbook(), {
      fileName: 'mac-excel.xlsx',
    });
    assert.equal(row.external_id, 'ORD-1904');
    assert.equal(row.pickup_date, '2026-08-03');
    assert.equal(row.pickup_hour, 9);
    assert.deepEqual(row.errors, []);
  });

  test('recognizes the headers in the exact downloadable XLSX template', () => {
    assert.throws(
      () => parseBusinessBatchFile(readFileSync(templatePath), { fileName: 'edenmish-business-batch-template.xlsx' }),
      (error) => error.message === 'empty_batch',
    );
  });

  test('rejects batches above the documented 100-row limit', () => {
    const lines = ['מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל'];
    for (let index = 0; index <= MAX_BUSINESS_BATCH_ROWS; index += 1) {
      lines.push(`ORD-${index},נמען ${index},0501234567,הרצל,${index + 1},תל אביב,2026-08-03,10:00,קטן`);
    }
    assert.throws(
      () => parseBusinessBatchFile(encode(lines.join('\n')), { fileName: 'too-many.csv' }),
      /too_many_rows/,
    );
  });

  test('rejects malformed XLSX archives before decompression', () => {
    assert.throws(
      () => parseBusinessBatchFile(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), { fileName: 'broken.xlsx' }),
      /invalid_xlsx/,
    );
  });

  test('rejects malformed quoted CSV instead of silently shifting columns', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל',
      'ORD-1,"נועה,0501234567,הרצל,10,תל אביב,2026-08-03,09:00,קטן',
    ].join('\n');
    assert.throws(
      () => parseBusinessBatchFile(encode(csv), { fileName: 'broken.csv' }),
      /invalid_csv/,
    );
  });

  test('rejects duplicate external ids and dates outside the booking horizon', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,תאריך,שעה,גודל',
      'ORD-1,נועה,0501234567,הרצל,10,תל אביב,2026-07-27,09:00,קטן',
      'ord-1,עמית,0501234567,הרצל,11,תל אביב,2026-10-27,10:00,קטן',
    ].join('\n');
    const [past, future] = parseBusinessBatchFile(encode(csv), {
      fileName: 'recipients.csv',
      today: '2026-07-28',
    });
    assert.deepEqual(past.errors, ['pickup_date_in_past', 'duplicate_external_id']);
    assert.deepEqual(future.errors, ['pickup_date_too_far', 'duplicate_external_id']);
  });

  test('validates structured address segments before composing the operational address', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,כניסה,קומה,דירה,תאריך,שעה,גודל',
      'ORD-1,נועה,0501234567,הרצל,10 א ב,תל אביב,כניסה ראשית-ב,קומה מאה,12/4,2026-08-03,09:00,קטן',
    ].join('\n');

    const [row] = parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' });
    assert.deepEqual(row.errors, [
      'invalid_delivery_house_number',
      'invalid_delivery_floor',
      'invalid_delivery_apartment',
      'invalid_delivery_entrance',
    ]);
  });

  test('normalizes obvious labels and spacing in structured address fields with approval metadata', () => {
    const csv = [
      'מזהה משלוח,שם,טלפון,רחוב,מספר בית,עיר,כניסה,קומה,דירה,תאריך,שעה,גודל',
      'ORD-1,נועה,0501234567,הרצל,10 א,תל אביב,כניסה ב,קומה 2,דירה 12,2026-08-03,09:00,קטן',
    ].join('\n');

    const [row] = parseBusinessBatchFile(encode(csv), { fileName: 'recipients.csv' });
    assert.equal(row.delivery_house_number, '10א');
    assert.equal(row.delivery_entrance, 'ב');
    assert.equal(row.delivery_floor, '2');
    assert.equal(row.delivery_apartment, '12');
    assert.equal(row.delivery_address, 'הרצל 10א, כניסה ב, קומה 2, דירה 12');
    assert.deepEqual(row.corrections.map(({ field, from, to }) => ({ field, from, to })), [
      { field: 'delivery_house_number', from: '10 א', to: '10א' },
      { field: 'delivery_entrance', from: 'כניסה ב', to: 'ב' },
      { field: 'delivery_floor', from: 'קומה 2', to: '2' },
      { field: 'delivery_apartment', from: 'דירה 12', to: '12' },
    ]);
  });
});
