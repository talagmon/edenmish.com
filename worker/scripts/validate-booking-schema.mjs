import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assertStagingConfig } from './staging-safety.mjs';

const migration = new URL('../migrations/039_whatsapp_booking.sql', import.meta.url);
const normalize = sql => sql.replace(/--[^\n]*/g, '').replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, '').replace(/;$/, '').toLowerCase();
const definitions = readFileSync(migration, 'utf8').replace(/--[^\n]*/g, '').split(';')
  .map(sql => sql.trim()).filter(sql => /^CREATE /i.test(sql));
const expected = new Map(definitions.map(sql => [sql.match(/(?:TABLE|INDEX)\s+IF NOT EXISTS\s+(\w+)/i)[1], normalize(sql)]));
export const BOOKING_SCHEMA_SQL = `SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='orders') AS orders_present,
  (SELECT json_group_array(json_object('name',name,'type',type,'required',"notnull",'default',dflt_value))
    FROM pragma_table_info('orders') WHERE name='source_channel') AS source_columns,
  (SELECT json_group_array(json_object('name',name,'sql',sql)) FROM sqlite_master
    WHERE name IN (${[...expected.keys()].map(name => `'${name}'`).join(',')})) AS objects;`;

export function bookingSchemaState(row) {
  try {
    if (row?.orders_present !== 1) return 'invalid';
    const columns = JSON.parse(row.source_columns); const objects = JSON.parse(row.objects);
    if (!Array.isArray(columns) || !Array.isArray(objects)) return 'invalid';
    if (!columns.length && !objects.length) return 'absent';
    const column = columns[0];
    const validColumn = columns.length === 1 && column.name === 'source_channel'
      && column.type.toUpperCase() === 'TEXT' && column.required === 1 && column.default === "'website'";
    if (validColumn && objects.length === expected.size && new Set(objects.map(item => item.name)).size === expected.size
      && objects.every(item => expected.has(item.name) && normalize(item.sql) === expected.get(item.name))) return 'ready';
    return 'partial';
  } catch { return 'invalid'; }
}

export async function ensureBookingSchema({ query, apply, allowApply = false }) {
  const state = bookingSchemaState(await query());
  if (state === 'ready') return 'ready';
  if (state !== 'absent' || !allowApply) throw new Error(`Migration 039 schema is ${state}; deployment blocked. Inspect schema before applying or repairing it.`);
  await apply();
  if (bookingSchemaState(await query()) !== 'ready') throw new Error('Migration 039 did not produce the complete schema; deployment blocked.');
  return 'applied';
}

async function main() {
  const args = process.argv.slice(2);
  if (![4, 5].includes(args.length) || args[0] !== '--database' || args[2] !== '--config'
    || (args.length === 5 && args[4] !== '--apply-staging')) throw new Error('Use --database NAME --config PATH [--apply-staging].');
  const database = args[1]; const config = args[3];
  const allowApply = args.includes('--apply-staging');
  if (!['edenmish', 'edenmish-staging'].includes(database) || !config || config.startsWith('--')) throw new Error('Explicit supported database and config required.');
  if (allowApply && (database !== 'edenmish-staging' || basename(config) !== 'wrangler.staging.generated.toml')) throw new Error('Automatic 039 migration is staging-only.');
  if (database === 'edenmish-staging') assertStagingConfig(config);
  const run = extra => {
    const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      '--no-install', 'wrangler', 'd1', 'execute', database, '--remote', '--yes', '--json', '--config', config, ...extra,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024, env: process.env });
    // Provider output may contain sensitive diagnostics; never echo it.
    if (result.error || result.status !== 0) throw new Error('D1 schema operation failed; inspect privately. No provider output was logged.');
    let payload; try { payload = JSON.parse(result.stdout); } catch { throw new Error('Invalid D1 schema response.'); }
    if (!Array.isArray(payload) || !payload.length || payload.some(item => item.success !== true)) throw new Error('D1 did not confirm success.');
    return payload;
  };
  const status = await ensureBookingSchema({ allowApply,
    query: async () => run(['--command', BOOKING_SCHEMA_SQL])[0]?.results?.[0],
    apply: async () => run(['--file', fileURLToPath(migration)]),
  });
  console.log(`WhatsApp booking schema 039: ${status}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
