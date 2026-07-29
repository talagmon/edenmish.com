import { unzipSync } from 'fflate';

import { normalizeIlPhone } from './validate.js';

export const MAX_BUSINESS_BATCH_BYTES = 1024 * 1024;
export const MAX_BUSINESS_BATCH_ROWS = 100;
export const BUSINESS_BATCH_MAX_ADVANCE_DAYS = 90;

const MAX_XLSX_ENTRIES = 100;
const MAX_XLSX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024;
const REQUIRED_FIELDS = [
  'external_id',
  'recipient_name',
  'recipient_phone',
  'delivery_street',
  'delivery_house_number',
  'delivery_city',
  'pickup_date',
  'pickup_hour',
  'package_size',
];
const HEADER_ALIASES = {
  external_id: ['מזהה משלוח', 'מזהה חיצוני', 'מספר משלוח לקוח', 'external delivery id', 'external id', 'shipment id'],
  recipient_name: ['שם נמען', 'שם', 'recipient name', 'name'],
  recipient_phone: ['טלפון נמען', 'טלפון', 'recipient phone', 'phone', 'mobile'],
  delivery_street: ['רחוב מסירה', 'שם רחוב', 'רחוב', 'delivery street', 'street name', 'street'],
  delivery_house_number: ['מספר בית', 'מס בית', 'מספר', 'house number', 'street number'],
  delivery_city: ['עיר מסירה', 'עיר', 'delivery city', 'city'],
  delivery_entrance: ['כניסה', 'כניסה לבניין', 'entrance', 'building entrance'],
  delivery_floor: ['קומה', 'floor'],
  delivery_apartment: ['דירה', 'מספר דירה', 'apt', 'apartment', 'apartment number'],
  pickup_date: ['תאריך איסוף', 'תאריך', 'pickup date', 'date'],
  pickup_hour: ['שעת איסוף', 'חלון איסוף', 'שעה', 'pickup time', 'pickup hour', 'time slot', 'time'],
  package_size: ['גודל חבילה', 'גודל', 'package size', 'size'],
  reference: ['לקוח/ספק', 'לקוח ספק', 'לקוח', 'ספק', 'customer/supplier', 'customer supplier', 'reference'],
  contents: ['תכולה', 'פריט', 'תיאור חבילה', 'contents', 'package'],
  notes: ['הערות לשליח', 'הערות', 'הערה', 'courier notes', 'delivery notes', 'notes', 'note'],
};
const FIELD_LIMITS = {
  external_id: 80,
  recipient_name: 120,
  recipient_phone: 32,
  delivery_street: 120,
  delivery_house_number: 20,
  delivery_city: 100,
  delivery_entrance: 20,
  delivery_floor: 20,
  delivery_apartment: 20,
  pickup_date: 10,
  pickup_hour: 5,
  package_size: 20,
  reference: 120,
  contents: 120,
  notes: 500,
};

function normalizeHeader(value) {
  return String(value == null ? '' : value)
    .replace(/[\u200e\u200f]/g, '')
    .replace(/[״"'׳`]/g, '')
    .replace(/[*:]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const ALIAS_LOOKUP = new Map(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) => (
    aliases.map((alias) => [normalizeHeader(alias), field])
  ))
);

function decodeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripXmlTags(value) {
  return decodeXml(String(value || '').replace(/<[^>]*>/g, ''));
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function worksheetRows(xml, sharedStrings) {
  const rows = [];
  const rowPattern = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(xml))) {
    const rowNumber = Number(rowMatch[1].match(/\br="(\d+)"/i)?.[1]);
    const row = [];
    const cellPattern = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[2]))) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || '';
      const ref = attrs.match(/\br="([^"]+)"/i)?.[1] || '';
      const type = attrs.match(/\bt="([^"]+)"/i)?.[1] || '';
      const raw = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i)?.[1];
      let value = '';
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)].map((match) => stripXmlTags(match[1])).join('');
      } else if (type === 's') {
        value = sharedStrings[Number(raw)] ?? '';
      } else if (raw != null) {
        value = decodeXml(raw);
      }
      row[columnIndex(ref)] = value;
    }
    if (Number.isSafeInteger(rowNumber) && rowNumber > 0) rows[rowNumber - 1] = row;
    else rows.push(row);
  }
  return rows;
}

function sharedStringValues(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi)].map((match) => (
    [...match[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
      .map((text) => stripXmlTags(text[1]))
      .join('')
  ));
}

function safeZipSummary(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('invalid_xlsx');
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount < 1 || entryCount > MAX_XLSX_ENTRIES || centralOffset >= bytes.byteLength) {
    throw new Error('unsafe_xlsx');
  }
  let offset = centralOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('invalid_xlsx');
    }
    uncompressedTotal += view.getUint32(offset + 24, true);
    if (uncompressedTotal > MAX_XLSX_UNCOMPRESSED_BYTES) throw new Error('unsafe_xlsx');
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entryCount, uncompressedTotal };
}

function worksheetPaths(files) {
  const decoder = new TextDecoder();
  const workbook = files['xl/workbook.xml'] ? decoder.decode(files['xl/workbook.xml']) : '';
  const relationships = files['xl/_rels/workbook.xml.rels'] ? decoder.decode(files['xl/_rels/workbook.xml.rels']) : '';
  const paths = [];
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/gi)) {
    const relationshipId = match[1];
    const escaped = relationshipId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = relationships.match(new RegExp(`<Relationship\\b[^>]*\\bId="${escaped}"[^>]*\\bTarget="([^"]+)"`, 'i'))?.[1]
      || relationships.match(new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${escaped}"`, 'i'))?.[1];
    if (target) {
      const normalized = target.replace(/^\/+/, '').replace(/^\.\//, '');
      paths.push(normalized.startsWith('xl/') ? normalized : `xl/${normalized}`);
    }
  }
  if (paths.length) return [...new Set(paths)];
  return Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
}

function parseXlsx(bytes) {
  safeZipSummary(bytes);
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('invalid_xlsx');
  }
  const decoder = new TextDecoder();
  const shared = files['xl/sharedStrings.xml']
    ? sharedStringValues(decoder.decode(files['xl/sharedStrings.xml']))
    : [];
  const sheets = worksheetPaths(files)
    .filter((sheetPath) => files[sheetPath])
    .map((sheetPath) => {
      const rows = worksheetRows(decoder.decode(files[sheetPath]), shared);
      return { rows, score: headerRecognitionScore(rows) };
    });
  if (!sheets.length) throw new Error('invalid_xlsx');
  const candidates = [...sheets].sort((left, right) => right.score - left.score);
  const workbookXml = files['xl/workbook.xml'] ? decoder.decode(files['xl/workbook.xml']) : '';
  return {
    rows: candidates[0].rows,
    sheets: sheets.map((sheet) => sheet.rows),
    date1904: /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(?:1|true)"/i.test(workbookXml),
  };
}

function detectDelimiter(text) {
  const sample = String(text || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const counts = [',', '\t', ';'].map((delimiter) => ({
    delimiter,
    count: [...sample].filter((character) => character === delimiter).length,
  }));
  return counts.sort((a, b) => b.count - a.count)[0]?.delimiter || ',';
}

function parseDelimited(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(source);
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('invalid_csv');
  row.push(value);
  if (row.some((cell) => String(cell).trim())) rows.push(row);
  return rows;
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizePickupDate(value, options = {}) {
  const raw = String(value == null ? '' : value).trim();
  const canonical = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (canonical) {
    const [year, month, day] = canonical.slice(1).map(Number);
    return validDateParts(year, month, day) ? { value: raw, correction: null } : null;
  }

  // Native Excel dates are stored as day serials even when displayed as
  // yyyy-mm-dd. This is representation normalization, not a user correction.
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const serial = Math.floor(Number(raw));
    if (serial >= 20_000 && serial <= 100_000) {
      const epoch = options.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
      const date = new Date(epoch + serial * 86_400_000);
      return {
        value: isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
        correction: null,
      };
    }
  }

  const dayFirst = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[2]);
    const year = Number(dayFirst[3]);
    if (validDateParts(year, month, day)) {
      const normalized = isoDate(year, month, day);
      return {
        value: normalized,
        correction: {
          field: 'pickup_date',
          from: raw,
          to: normalized,
          reason: 'normalized_date_format',
          confidence: 'high',
        },
      };
    }
  }

  const yearFirst = raw.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})$/);
  if (yearFirst) {
    const year = Number(yearFirst[1]);
    const month = Number(yearFirst[2]);
    const day = Number(yearFirst[3]);
    if (validDateParts(year, month, day)) {
      const normalized = isoDate(year, month, day);
      return {
        value: normalized,
        correction: {
          field: 'pickup_date',
          from: raw,
          to: normalized,
          reason: 'normalized_date_format',
          confidence: 'high',
        },
      };
    }
  }
  return null;
}

function normalizePickupHour(value) {
  const raw = String(value == null ? '' : value).trim();
  if (/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw)) {
    const numeric = Number(raw);
    const hour = Math.round(numeric * 24);
    if (hour >= 0 && hour <= 23 && Math.abs(numeric * 24 - hour) < 1e-8) {
      return { value: hour, correction: null };
    }
  }
  const match = raw.match(/^(\d{1,2})(?::00)?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const canonical = `${String(hour).padStart(2, '0')}:00`;
  return {
    value: hour,
    correction: raw === canonical ? null : {
      field: 'pickup_hour',
      from: raw,
      to: canonical,
      reason: 'normalized_pickup_hour',
      confidence: 'high',
    },
  };
}

function normalizePackageSize(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (['small', 's', 'קטן', 'קטנה'].includes(normalized)) return 'small';
  if (['medium', 'm', 'בינוני', 'בינונית'].includes(normalized)) return 'medium';
  return null;
}

function validHouseNumber(value) {
  return /^\d{1,4}[A-Za-zא-ת]?(?:[/-]\d{1,4})?$/.test(String(value || '').trim());
}

function validFloor(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  if (['קרקע', 'לובי', 'מרתף'].includes(normalized)) return true;
  if (!/^-?\d{1,3}$/.test(normalized)) return false;
  const floor = Number(normalized);
  return floor >= -5 && floor <= 100;
}

function validUnitValue(value) {
  const normalized = String(value || '').trim();
  return !normalized || /^[A-Za-zא-ת0-9]{1,6}$/.test(normalized);
}

function normalizedStructuredValue(field, rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return { value: '', correction: null };
  let value = raw;
  if (field === 'delivery_house_number') {
    value = raw.replace(/\s+/g, '').replace(/[–—]/g, '-');
    if (!validHouseNumber(value)) return null;
  } else if (field === 'delivery_floor') {
    value = raw.replace(/^קומה\s+/i, '').trim();
    if (!validFloor(value)) return null;
  } else if (field === 'delivery_entrance') {
    value = raw.replace(/^כניסה\s+/i, '').trim();
    if (!validUnitValue(value)) return null;
  } else if (field === 'delivery_apartment') {
    value = raw.replace(/^(?:דירה|דירת)\s+/i, '').trim();
    if (!validUnitValue(value)) return null;
  }
  return {
    value,
    correction: value === raw ? null : {
      field,
      from: raw,
      to: value,
      reason: `normalized_${field}`,
      confidence: 'high',
    },
  };
}

export function normalizeBusinessAddressInput(input = {}, prefix = 'delivery') {
  const source = {
    street: String(input.street || '').trim(),
    house_number: String(input.house_number || '').trim(),
    city: String(input.city || '').trim(),
    entrance: String(input.entrance || '').trim(),
    floor: String(input.floor || '').trim(),
    apartment: String(input.apartment || '').trim(),
  };
  const errors = [];
  for (const field of ['street', 'house_number', 'city']) {
    if (!source[field]) errors.push(`missing_${prefix}_${field}`);
  }
  const limits = {
    street: FIELD_LIMITS.delivery_street,
    house_number: FIELD_LIMITS.delivery_house_number,
    city: FIELD_LIMITS.delivery_city,
    entrance: FIELD_LIMITS.delivery_entrance,
    floor: FIELD_LIMITS.delivery_floor,
    apartment: FIELD_LIMITS.delivery_apartment,
  };
  for (const [field, limit] of Object.entries(limits)) {
    if (source[field].length > limit) errors.push(`too_long_${prefix}_${field}`);
  }
  const houseNumber = normalizedStructuredValue('delivery_house_number', source.house_number);
  const entrance = normalizedStructuredValue('delivery_entrance', source.entrance);
  const floor = normalizedStructuredValue('delivery_floor', source.floor);
  const apartment = normalizedStructuredValue('delivery_apartment', source.apartment);
  if (source.house_number && !houseNumber) errors.push(`invalid_${prefix}_house_number`);
  if (source.entrance && !entrance) errors.push(`invalid_${prefix}_entrance`);
  if (source.floor && !floor) errors.push(`invalid_${prefix}_floor`);
  if (source.apartment && !apartment) errors.push(`invalid_${prefix}_apartment`);
  const result = {
    street: source.street,
    house_number: houseNumber?.value || source.house_number,
    city: source.city,
    entrance: entrance?.value || source.entrance,
    floor: floor?.value || source.floor,
    apartment: apartment?.value || source.apartment,
    corrections: [houseNumber, entrance, floor, apartment]
      .map((item) => item?.correction)
      .filter(Boolean)
      .map((correction) => ({
        ...correction,
        field: correction.field.replace(/^delivery_/, `${prefix}_`),
        reason: correction.reason.replace(/^normalized_delivery_/, `normalized_${prefix}_`),
      })),
    errors: [...new Set(errors)],
  };
  result.address = composeDeliveryAddress({
    delivery_street: result.street,
    delivery_house_number: result.house_number,
    delivery_entrance: result.entrance,
    delivery_floor: result.floor,
    delivery_apartment: result.apartment,
  });
  return result;
}

export function composeDeliveryAddress(parts) {
  const street = String(parts.delivery_street || '').trim();
  const houseNumber = String(parts.delivery_house_number || '').trim();
  const base = [street, houseNumber].filter(Boolean).join(' ');
  const details = [
    parts.delivery_entrance ? `כניסה ${String(parts.delivery_entrance).trim()}` : '',
    parts.delivery_floor ? `קומה ${String(parts.delivery_floor).trim()}` : '',
    parts.delivery_apartment ? `דירה ${String(parts.delivery_apartment).trim()}` : '',
  ].filter(Boolean);
  return `${base}${details.length ? `, ${details.join(', ')}` : ''}`;
}

function headerMapping(rows) {
  let selected = null;
  const scanLimit = Math.min(rows.length, 20);
  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const fields = {};
    (rows[rowIndex] || []).forEach((value, column) => {
      const field = ALIAS_LOOKUP.get(normalizeHeader(value));
      if (field && fields[field] == null) fields[field] = column;
    });
    const score = Object.keys(fields).length;
    if (!selected || score > selected.score) selected = { rowIndex, fields, score };
  }
  const missing = REQUIRED_FIELDS.filter((field) => selected?.fields[field] == null);
  if (missing.length) {
    const error = new Error('missing_headers');
    error.missing = missing;
    throw error;
  }
  return selected;
}

function headerRecognitionScore(rows) {
  let score = 0;
  const scanLimit = Math.min(rows.length, 20);
  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const fields = new Set();
    for (const value of rows[rowIndex] || []) {
      const field = ALIAS_LOOKUP.get(normalizeHeader(value));
      if (field) fields.add(field);
    }
    score = Math.max(score, fields.size);
  }
  return score;
}

function dateWindowError(value, today, maxAdvanceDays) {
  if (!today || !value) return null;
  const selected = Date.parse(`${value}T00:00:00Z`);
  const start = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(selected) || !Number.isFinite(start)) return null;
  const days = Math.round((selected - start) / 86_400_000);
  if (days < 0) return 'pickup_date_in_past';
  if (days > maxAdvanceDays) return 'pickup_date_too_far';
  return null;
}

export function normalizeBusinessBatchRows(rows, options = {}) {
  const header = headerMapping(rows);
  const results = [];
  for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const source = rows[rowIndex] || [];
    const values = {};
    for (const field of Object.keys(HEADER_ALIASES)) {
      const column = header.fields[field];
      values[field] = column == null ? '' : String(source[column] == null ? '' : source[column]).trim();
    }
    if (!Object.values(values).some(Boolean)) continue;
    const errors = [];
    for (const field of REQUIRED_FIELDS) if (!values[field]) errors.push(`missing_${field}`);
    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
      if (values[field].length > limit) errors.push(`too_long_${field}`);
    }
    const phone = normalizeIlPhone(values.recipient_phone);
    if (values.recipient_phone && !phone) errors.push('invalid_recipient_phone');
    const pickupDate = normalizePickupDate(values.pickup_date, options);
    if (values.pickup_date && !pickupDate) errors.push('invalid_pickup_date');
    const windowError = dateWindowError(
      pickupDate?.value,
      options.today,
      Number.isFinite(options.maxAdvanceDays) ? options.maxAdvanceDays : BUSINESS_BATCH_MAX_ADVANCE_DAYS,
    );
    if (windowError) errors.push(windowError);
    const pickupHour = normalizePickupHour(values.pickup_hour);
    if (values.pickup_hour && pickupHour == null) errors.push('invalid_pickup_hour');
    const packageSize = normalizePackageSize(values.package_size);
    if (values.package_size && !packageSize) errors.push('invalid_package_size');
    const houseNumber = normalizedStructuredValue('delivery_house_number', values.delivery_house_number);
    const floor = normalizedStructuredValue('delivery_floor', values.delivery_floor);
    const apartment = normalizedStructuredValue('delivery_apartment', values.delivery_apartment);
    const entrance = normalizedStructuredValue('delivery_entrance', values.delivery_entrance);
    if (values.delivery_house_number && !houseNumber) errors.push('invalid_delivery_house_number');
    if (values.delivery_floor && !floor) errors.push('invalid_delivery_floor');
    if (values.delivery_apartment && !apartment) errors.push('invalid_delivery_apartment');
    if (values.delivery_entrance && !entrance) errors.push('invalid_delivery_entrance');
    const corrections = [
      pickupDate?.correction,
      pickupHour?.correction,
      houseNumber?.correction,
      entrance?.correction,
      floor?.correction,
      apartment?.correction,
    ].filter(Boolean);
    const result = {
      row_number: rowIndex + 1,
      external_id: values.external_id,
      recipient_name: values.recipient_name,
      recipient_phone: phone || values.recipient_phone,
      delivery_street: values.delivery_street,
      delivery_house_number: houseNumber?.value || values.delivery_house_number,
      delivery_city: values.delivery_city,
      delivery_entrance: entrance?.value || values.delivery_entrance,
      delivery_floor: floor?.value || values.delivery_floor,
      delivery_apartment: apartment?.value || values.delivery_apartment,
      pickup_date: pickupDate?.value || values.pickup_date,
      pickup_hour: pickupHour == null ? values.pickup_hour : pickupHour.value,
      package_size: packageSize || values.package_size,
      reference: values.reference,
      contents: values.contents,
      notes: values.notes,
      corrections,
      errors: [...new Set(errors)],
    };
    result.delivery_address = composeDeliveryAddress(result);
    results.push(result);
    if (results.length > MAX_BUSINESS_BATCH_ROWS) throw new Error('too_many_rows');
  }
  if (!results.length) throw new Error('empty_batch');
  const externalIds = new Map();
  for (const row of results) {
    const key = row.external_id.trim().toLocaleLowerCase('he');
    if (!key) continue;
    const prior = externalIds.get(key);
    if (prior) {
      prior.errors = [...new Set([...prior.errors, 'duplicate_external_id'])];
      row.errors = [...new Set([...row.errors, 'duplicate_external_id'])];
    } else {
      externalIds.set(key, row);
    }
  }
  return results;
}

export function parseBusinessBatchFile(input, options = {}) {
  const parsed = readBusinessBatchTable(input, options);
  return normalizeBusinessBatchRows(parsed.rows, { ...options, date1904: parsed.date1904 });
}

export function readBusinessBatchTable(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.byteLength) throw new Error('empty_file');
  if (bytes.byteLength > MAX_BUSINESS_BATCH_BYTES) throw new Error('payload_too_large');
  const fileName = String(options.fileName || '').toLowerCase();
  const contentType = String(options.contentType || '').toLowerCase();
  const isCsv = fileName.endsWith('.csv') || contentType.includes('csv') || contentType.includes('text/plain');
  if (!isCsv) return parseXlsx(bytes);
  const rows = parseDelimited(new TextDecoder().decode(bytes));
  return { rows, sheets: [rows], date1904: false };
}
