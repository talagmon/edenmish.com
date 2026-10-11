// Offline only: no deployment, key access, grants, dates or provider requests.
import {readFileSync, writeFileSync, statSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workerName = 'edenmish-ops-staging';
const databaseId = 'e1fcce7f-a232-4258-b181-f1ab17b25639';
const routes = [
  {pattern:'find-staging.edenmish.com', custom_domain:true},
  {pattern:'ops-staging.edenmish.com', custom_domain:true},
];
export const blankTemplateNames = ['WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE','WHATSAPP_OPS_PAYMENT_TEMPLATE'];
export function makeOffConfig(base, entry = join(root,'worker/src/index.js')) {
  const allowed = ['name','main','compatibility_date','routes','triggers','vars','ai','secrets','d1_databases'];
  const allowedSecrets = ['OPS_PIN','SESSION_SECRET','DRIVER_ONE_TIME_CODE','GOOGLE_PLACES_SERVER_KEY','GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON','SENDGRID_API_KEY','APNS_TEAM_ID','APNS_KEY_ID','APNS_PRIVATE_KEY_P8'];
  if (Object.keys(base).some(k=>!allowed.includes(k)) || base.name!==workerName
      || base.compatibility_date!=='2024-11-01' || JSON.stringify(base.routes)!==JSON.stringify(routes)
      || base.d1_databases?.length!==1 || base.d1_databases[0].database_id!==databaseId
      || base.d1_databases[0].binding!=='DB' || base.d1_databases[0].database_name!=='edenmish-staging'
      || Object.keys(base.d1_databases[0]).some(k=>!['binding','database_name','database_id'].includes(k))
      || (base.ai && JSON.stringify(base.ai)!==JSON.stringify({binding:'AI'}))
      || (base.secrets && (Object.keys(base.secrets).join(',')!=='required'
        || !Array.isArray(base.secrets.required) || base.secrets.required.some(k=>!allowedSecrets.includes(k))))
      || typeof base.vars!=='object' || !base.vars || Array.isArray(base.vars)
      || Object.entries(base.vars).some(([k,v])=>typeof v!=='string'||/TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE_KEY|MAPS_KEY/.test(k))) {
    throw Error('staging_source_unverified');
  }
  const vars = Object.fromEntries(Object.entries(base.vars).filter(([k])=>!k.startsWith('WHATSAPP_BOOKING_')));
  Object.assign(vars, {
    WHATSAPP_BOOKING_ENABLED:'off', WHATSAPP_BOOKING_SEND_ENABLED:'off', WHATSAPP_BOOKING_MODEL_ENABLED:'off',
    WHATSAPP_BOOKING_STORAGE_READY:'on', WHATSAPP_BOOKING_MODE:'conversation_only',
    WHATSAPP_BOOKING_VOICE_ENABLED:'off', WHATSAPP_BOOKING_VOICE_APPROVED:'off', WHATSAPP_BOOKING_VOICE_PROFILE:'off',
    WHATSAPP_BOOKING_CONTINUATION_APPROVED:'off', WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'off',
    WHATSAPP_BOOKING_READINESS_APPROVED:'off', WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED:'off',
    WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED:'off',
    AUTO_DRIVER_DISPATCH:'off', ROUTE_OPTIMIZATION_PROVIDER:'off',
    EMAIL_RECIPIENT_POLICY:'allowlist', EMAIL_RECIPIENT_ALLOWLIST:'',
    TWILIO_RECIPIENT_POLICY:'allowlist', TWILIO_RECIPIENT_ALLOWLIST:'',
  });
  for(const name of blankTemplateNames) vars[name]='';
  if(Object.keys(vars).length>64) throw Error('variable_limit');
  return {...base, main:resolve(entry), vars, triggers:{crons:[]}};
}
export function validateOffConfig(config, entry) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
  if(JSON.stringify(canonical(makeOffConfig(config,entry)))!==JSON.stringify(canonical(config))) throw Error('off_config_changed');
  return true;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [input,output]=process.argv.slice(2);
    if(!input||!output||(statSync(input).mode&0o077)||(statSync(dirname(resolve(output))).mode&0o077)) throw Error('private_paths_required');
    const config=makeOffConfig(JSON.parse(readFileSync(input,'utf8')));
    validateOffConfig(config,join(root,'worker/src/index.js'));
    const body=JSON.stringify(config,null,2)+'\n';writeFileSync(output,body,{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({prepared:true,networkCalls:0,migrationRequired:false,grants:0,windows:0,crons:0,
      configSha256:createHash('sha256').update(body).digest('hex')}));
  } catch { console.error('OFF preparation refused; inspect nonsecret source shape and private file permissions.'); process.exitCode=1; }
}
