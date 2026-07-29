import { BUSINESS_BATCH_AI_FIELDS } from './business-batch-ai.js';

const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const MAX_STORED_MAPPINGS = BUSINESS_BATCH_AI_FIELDS.length;
const MAX_ACCOUNT_MAPPING_LAYOUTS = 20;

function normalizedMappings(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_STORED_MAPPINGS) {
    throw new Error('invalid_batch_mapping');
  }
  const byField = new Map();
  for (const item of value) {
    if (
      !BUSINESS_BATCH_AI_FIELDS.includes(item?.field)
      || !Number.isSafeInteger(item?.column_index)
      || item.column_index < 0
      || item.column_index > 23
      || !Number.isFinite(item?.confidence)
    ) {
      throw new Error('invalid_batch_mapping');
    }
    const mapping = {
      field: item.field,
      column_index: item.column_index,
      confidence: Math.max(0, Math.min(100, Math.round(item.confidence))),
    };
    const existing = byField.get(mapping.field);
    if (!existing || mapping.confidence > existing.confidence) byField.set(mapping.field, mapping);
  }
  if (!byField.size) throw new Error('invalid_batch_mapping');
  return [...byField.values()].sort((left, right) => (
    BUSINESS_BATCH_AI_FIELDS.indexOf(left.field) - BUSINESS_BATCH_AI_FIELDS.indexOf(right.field)
  ));
}

function normalizedSignature(value) {
  const signature = String(value || '').trim().toLowerCase();
  if (!SIGNATURE_PATTERN.test(signature)) throw new Error('invalid_batch_mapping');
  return signature;
}

export async function findBusinessBatchMappings(DB, accountId, signatures) {
  const uniqueSignatures = [...new Set(
    (signatures || [])
      .map((signature) => String(signature || '').trim().toLowerCase())
      .filter((signature) => SIGNATURE_PATTERN.test(signature)),
  )].slice(0, 60);
  if (!DB || !uniqueSignatures.length) return new Map();
  const placeholders = uniqueSignatures.map(() => '?').join(',');
  const result = await DB.prepare(
    `SELECT header_signature, mapping_json
     FROM business_batch_mappings
     WHERE account_id = ? AND header_signature IN (${placeholders})`
  ).bind(Number(accountId), ...uniqueSignatures).all();
  const mappings = new Map();
  for (const row of result.results || []) {
    try {
      mappings.set(row.header_signature, {
        signature: row.header_signature,
        mappings: normalizedMappings(JSON.parse(row.mapping_json)),
      });
    } catch {
      // Corrupt rows are ignored; the importer falls back to fresh AI mapping.
    }
  }
  return mappings;
}

export async function saveBusinessBatchMapping(DB, accountId, value, now = Date.now()) {
  const signature = normalizedSignature(value?.mapping_signature);
  const mappings = normalizedMappings(value?.mappings);
  await DB.prepare(
    `INSERT INTO business_batch_mappings
      (account_id, header_signature, mapping_json, created_at, updated_at, last_used_at, use_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(account_id, header_signature) DO UPDATE SET
       mapping_json = excluded.mapping_json,
       updated_at = excluded.updated_at`
  ).bind(
    Number(accountId),
    signature,
    JSON.stringify(mappings),
    now,
    now,
    null,
  ).run();
  await DB.prepare(
    `DELETE FROM business_batch_mappings
     WHERE account_id = ?
       AND id NOT IN (
         SELECT id
         FROM business_batch_mappings
         WHERE account_id = ?
         ORDER BY COALESCE(last_used_at, updated_at) DESC, id DESC
         LIMIT ?
       )`
  ).bind(
    Number(accountId),
    Number(accountId),
    MAX_ACCOUNT_MAPPING_LAYOUTS,
  ).run();
  return { signature, mappings };
}

export async function markBusinessBatchMappingUsed(DB, accountId, signature, now = Date.now()) {
  const normalized = normalizedSignature(signature);
  await DB.prepare(
    `UPDATE business_batch_mappings
     SET last_used_at = ?, use_count = use_count + 1
     WHERE account_id = ? AND header_signature = ?`
  ).bind(now, Number(accountId), normalized).run();
}

export async function listBusinessBatchMappings(DB, accountId) {
  if (!DB) return [];
  const result = await DB.prepare(
    `SELECT id, mapping_json, created_at, updated_at, last_used_at, use_count
     FROM business_batch_mappings
     WHERE account_id = ?
     ORDER BY COALESCE(last_used_at, updated_at) DESC, id DESC
     LIMIT ?`
  ).bind(Number(accountId), MAX_ACCOUNT_MAPPING_LAYOUTS).all();
  return (result.results || []).map((row) => {
    let fieldCount = 0;
    try {
      fieldCount = normalizedMappings(JSON.parse(row.mapping_json)).length;
    } catch {
      // Keep corrupt legacy rows visible so the account owner can remove them.
    }
    return {
      id: Number(row.id),
      approved_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
      use_count: Number(row.use_count || 0),
      field_count: fieldCount,
    };
  });
}

export async function deleteBusinessBatchMapping(DB, accountId, mappingId) {
  const id = Number(mappingId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('invalid_batch_mapping_id');
  }
  const result = await DB.prepare(
    `DELETE FROM business_batch_mappings
     WHERE id = ? AND account_id = ?`
  ).bind(id, Number(accountId)).run();
  return Number(result?.meta?.changes || 0) > 0;
}
