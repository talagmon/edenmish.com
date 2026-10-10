import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const migration=new URL('../migrations/044_whatsapp_continuation_sol.sql',import.meta.url);
const normalize=sql=>sql.replace(/--[^\n]*/g,'').replace(/\bIF NOT EXISTS\b/gi,'').replace(/\s+/g,'').replace(/;$/,'').toLowerCase();
const definitions=readFileSync(migration,'utf8').replace(/--[^\n]*/g,'').match(/CREATE TRIGGER[\s\S]*?END;|CREATE (?:TABLE|INDEX|TRIGGER)[\s\S]*?;/g);
const expected=new Map(definitions.map(sql=>[sql.match(/(?:TABLE|INDEX|TRIGGER)\s+IF NOT EXISTS\s+(\w+)/i)[1],normalize(sql)]));
export const SOL_SCHEMA_SQL=`SELECT name,sql FROM sqlite_master WHERE name IN (${[...expected.keys()].map(n=>`'${n}'`).join(',')});`;
export function solSchemaReady(rows){
 return Array.isArray(rows)&&rows.length===expected.size&&new Set(rows.map(x=>x.name)).size===expected.size
  &&rows.every(row=>expected.has(row.name)&&normalize(row.sql)===expected.get(row.name));
}
// Deliberately read-only and staging-only. Applying migration 044 is a separate
// explicit operator action; this CLI never resets pilot tables or usage records.
export function checkSolSchema(config){
 const cfg=readFileSync(config,'utf8');
 if(!/^name\s*=\s*"edenmish-ops-staging"\s*$/m.test(cfg)
   ||!/^database_name\s*=\s*"edenmish-staging"\s*$/m.test(cfg))throw new Error('Expected staging config.');
 const r=spawnSync(process.execPath,[new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url).pathname,
  'd1','execute','edenmish-staging','--remote','--config',config,'--command',SOL_SCHEMA_SQL,'--json'],
  {encoding:'utf8',env:{...process.env,WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false'},maxBuffer:1000000});
 if(r.status!==0)throw new Error('Schema check failed; no provider output retained.');
 const parsed=JSON.parse(r.stdout);
 if(!solSchemaReady(parsed?.[0]?.results))throw new Error('Migration 044 is absent or differs; pilot blocked.');
 console.log('Continuation grant schema 044 verified; no changes made.');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.length!==4||process.argv[2]!=='--config')throw new Error('Usage: --config <staging config>');
 checkSolSchema(process.argv[3]);
}
