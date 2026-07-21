import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const READINESS_SQL = `SELECT
  ((SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'drivers', 'driver_sessions', 'driver_shifts', 'driver_assignments',
        'driver_routes', 'driver_route_stops', 'driver_execution_events'
      )) +
   (SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_driver_sessions_access', 'idx_driver_shifts_current',
        'idx_driver_events_shift'
      ))) AS migration_014_items,
  ((SELECT COUNT(*) FROM pragma_table_info('driver_routes')
      WHERE name = 'onboard_order_ids_json') +
   (SELECT COUNT(*) FROM pragma_table_info('driver_route_stops')
      WHERE name IN ('task_type', 'required_predecessor_stop_id',
                     'service_duration_seconds'))) AS migration_015_columns,
  ((SELECT COUNT(*) FROM pragma_table_info('driver_routes')
      WHERE name = 'plan_fingerprint') +
   (SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'table' AND name = 'driver_location_samples') +
   (SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_driver_location_shift', 'idx_driver_location_retention'
      ))) AS migration_016_items,
  ((SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'table' AND name = 'driver_task_proofs') +
   (SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_driver_task_proofs_order'))
    AS migration_017_items;`;

const EXPECTED = Object.freeze({
  migration_014_items: 10,
  migration_015_columns: 4,
  migration_016_items: 4,
  migration_017_items: 2,
});

export function validateDriverSchemaSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ['D1 returned no driver-schema readiness row.'];
  }
  const errors = [];
  for (const [field, expected] of Object.entries(EXPECTED)) {
    const actual = Number(snapshot[field]);
    if (!Number.isInteger(actual) || actual !== expected) {
      errors.push(`${field}: expected ${expected}, received ${snapshot[field] ?? 'missing'}.`);
    }
  }
  return errors;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`Missing required argument ${name}.`);
  }
  return process.argv[index + 1];
}

function parseWranglerResult(stdout) {
  let payload;
  try { payload = JSON.parse(stdout); } catch {
    throw new Error('Wrangler did not return valid JSON for the driver-schema check.');
  }
  const snapshot = payload?.[0]?.results?.[0];
  const errors = validateDriverSchemaSnapshot(snapshot);
  if (errors.length) throw new Error(errors.join(' '));
  return snapshot;
}

function main() {
  const database = argument('--database');
  const config = argument('--config');
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(executable, [
    'wrangler', 'd1', 'execute', database,
    '--remote', '--yes', '--json',
    '--config', config,
    '--command', READINESS_SQL,
  ], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Unable to query remote D1 schema.${detail ? ` ${detail}` : ''}`);
  }
  const snapshot = parseWranglerResult(result.stdout);
  console.log(
    `Driver schema ready: migration 014 (${snapshot.migration_014_items}/10), `
    + `015 (${snapshot.migration_015_columns}/4), 016 (${snapshot.migration_016_items}/4), `
    + `017 (${snapshot.migration_017_items}/2).`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try { main(); } catch (error) {
    console.error(`::error::Driver schema readiness failed: ${error.message}`);
    process.exitCode = 1;
  }
}
