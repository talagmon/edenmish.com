import { readFileSync } from 'node:fs';

// Fail closed on unexpected/duplicate overrides in this deliberately simple
// checked-in template. A dispatch pilot needs a separately reviewed config.
export function validateStagingConfig(config, productionConfig) {
  const errors = [];
  let section = '';
  const entries = config.split('\n').map(line => {
    const heading = line.match(/^\s*(\[.+\])\s*(?:#.*)?$/);
    if (heading) section = heading[1];
    return { line, section };
  });
  const assignment = (name, value, requiredSection = '[vars]') => {
    const lines = entries.filter(({ line }) => new RegExp(`^\\s*["']?${name}["']?\\s*=`).test(line));
    if (lines.length !== 1 || lines[0].section !== requiredSection || !new RegExp(`^\\s*${name}\\s*=\\s*"${value}"\\s*(?:#.*)?$`).test(lines[0].line)) {
      errors.push(`Staging requires exactly one ${name} = "${value}".`);
    }
  };
  assignment('name', 'edenmish-ops-staging', '');
  assignment('database_name', 'edenmish-staging', '[[d1_databases]]');
  assignment('AUTO_DRIVER_DISPATCH', 'off');
  assignment('EMAIL_RECIPIENT_POLICY', 'allowlist');
  for (const flag of ['WHATSAPP_BOOKING_ENABLED', 'WHATSAPP_BOOKING_SEND_ENABLED', 'WHATSAPP_BOOKING_MODEL_ENABLED']) {
    assignment(flag, 'off');
  }
  if (/^\s*\[env[.\]]/m.test(config)) errors.push('Staging environment overrides require separate review.');
  const productionIds = [...productionConfig.matchAll(/^\s*database_id\s*=\s*"([^"]+)"/gm)].map(match => match[1]);
  if (!productionIds.length || productionIds.some(id => config.includes(id))) errors.push('Staging must not bind a production database.');
  return errors;
}

export function assertStagingConfig(path) {
  const errors = validateStagingConfig(readFileSync(path, 'utf8'), readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'));
  if (errors.length) throw new Error(errors.join(' '));
}
