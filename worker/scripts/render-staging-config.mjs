import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'wrangler.staging.toml');
const target = join(root, 'wrangler.staging.generated.toml');
const databaseId = String(process.env.STAGING_D1_DATABASE_ID || '').trim();

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error('STAGING_D1_DATABASE_ID must be a valid D1 database UUID');
}

const template = readFileSync(source, 'utf8');
writeFileSync(target, template.replace('__STAGING_D1_DATABASE_ID__', databaseId));
console.log('Rendered wrangler.staging.generated.toml');
