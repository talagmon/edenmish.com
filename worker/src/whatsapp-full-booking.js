import { productionRehearsal } from './production-rehearsal-context.js';
import { rehearsalSelected, rehearsalSpec, activeRehearsal, rehearsalOrigin } from './payment-rehearsal-capability.js';
import { BOOKING_DEADLINES } from './whatsapp-booking-deadlines.js';
import { safeBookingRejection } from './whatsapp-booking-diagnostics.js';
// Independent full-booking authority. No provider IO, credentials in storage,
// refunds, or implicit activation. Authenticated Ops calls issuance explicitly.
export const FULL_BOOKING_PROFILE = Object.freeze({ execution: 'durable-v1', model: 'gpt-6.1-sol', reasoning_effort: 'low', service_tier: 'default', max_output_tokens: 1024, input_tokens: 16384, request_bytes: 8192, soft_timeout_ms: BOOKING_DEADLINES.softMs, transport_timeout_ms: BOOKING_DEADLINES.transportMs, timeout_ms: BOOKING_DEADLINES.customerMs });
export const FULL_BOOKING_COSTS = Object.freeze({ inbound: 10300, outbound: 11300, address: 32000, model: 56320 });
const KINDS = Object.keys(FULL_BOOKING_COSTS);
const FLAGS = ['WHATSAPP_BOOKING_ENABLED', 'WHATSAPP_BOOKING_SEND_ENABLED', 'WHATSAPP_BOOKING_MODEL_ENABLED'];
const APPROVALS = ['WHATSAPP_BOOKING_FULL_APPROVED', 'WHATSAPP_BOOKING_FULL_SCHEMA_READY', 'WHATSAPP_BOOKING_DURABLE_READY', 'WHATSAPP_BOOKING_STORAGE_READY', 'WHATSAPP_BOOKING_PRIVACY_APPROVED'];
const FIELDS = ['version','environment','budget_id','grant_id','source_sha256','starts_at','expires_at','budget_micros','retained_micros','allocation_micros','limits','account_sid','sender','recipients','booking_url','webhook_url',...Object.keys(FULL_BOOKING_PROFILE),'costs'];
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const changed = result => Number(result?.meta?.changes || 0) === 1;
export const fullBookingSelected = env => Object.hasOwn(env, 'WHATSAPP_BOOKING_FULL_CONFIG');
export function fullBookingSpec(env) {
  try {
    if (typeof env.WHATSAPP_BOOKING_FULL_CONFIG !== 'string' || env.WHATSAPP_BOOKING_FULL_CONFIG.length > 8192) return null;
    const raw = JSON.parse(env.WHATSAPP_BOOKING_FULL_CONFIG);
    if (!exact(raw,FIELDS) || raw.version !== 1 || !['staging','production'].includes(raw.environment)
      || !id(raw.budget_id) || !id(raw.grant_id) || !/^[a-f0-9]{64}$/.test(raw.source_sha256)
      || !integer(raw.starts_at,1,8640000000000000) || !integer(raw.expires_at,raw.starts_at+1,raw.starts_at+86400000)
      || !integer(raw.budget_micros,1,100000000) || !integer(raw.retained_micros,0,raw.budget_micros)
      || !integer(raw.allocation_micros,1,raw.budget_micros-raw.retained_micros)
      || !exact(raw.limits,KINDS) || KINDS.some(kind => !integer(raw.limits[kind],0,kind==='model'?100:kind==='address'?100:1000))
      || !exact(raw.costs,KINDS) || KINDS.some(kind => raw.costs[kind] !== FULL_BOOKING_COSTS[kind])
      || Object.entries(FULL_BOOKING_PROFILE).some(([key,value]) => raw[key] !== value)
      || !/^AC[a-fA-F0-9]{32}$/.test(raw.account_sid) || !/^whatsapp:\+[1-9]\d{7,14}$/.test(raw.sender)
      || !Array.isArray(raw.recipients) || raw.recipients.length < 1 || raw.recipients.length > 10
      || raw.recipients.some(phone => typeof phone !== 'string' || !/^\+972[1-9]\d{7,8}$/.test(phone))
      || new Set(raw.recipients).size !== raw.recipients.length) return null;
    const booking = new URL(raw.booking_url), webhook = new URL(raw.webhook_url);
    const isolated=rehearsalSelected(env);
    if(isolated && (!rehearsalSpec(env)||raw.environment!==(env[productionRehearsal]?'production':'staging')||raw.recipients.length!==1||raw.recipients[0]!==rehearsalSpec(env).phone||raw.starts_at!==rehearsalSpec(env).starts_at||raw.expires_at!==rehearsalSpec(env).expires_at))return null;
    if (booking.origin !== raw.booking_url || booking.origin !== (isolated?rehearsalOrigin(env):raw.environment==='staging'?'https://staging.edenmish.com':'https://edenmish.com')
      || webhook.protocol !== 'https:' || webhook.username || webhook.password || webhook.search || webhook.hash
      || webhook.pathname !== '/webhooks/twilio/booking'
      || webhook.hostname !== (isolated?new URL(rehearsalOrigin(env)).hostname:raw.environment==='staging'?'ops-staging.edenmish.com':'find.edenmish.com')) return null;
    // Canonical property order makes immutable bindings independent of JSON order.
    return Object.fromEntries(FIELDS.map(key => [key,key==='recipients'?[...raw.recipients].sort():['limits','costs'].includes(key)?Object.fromEntries(KINDS.map(kind=>[kind,raw[key][kind]])):raw[key]]));
  } catch { return null; }
}
function configuration(env, now, issuing) {
  const spec = fullBookingSpec(env);
  if (!spec || typeof env.WHATSAPP_BOOKING_QUEUE?.send!=='function' || !Number.isSafeInteger(now) || !APPROVALS.every(key=>env[key]==='on') || env.WHATSAPP_BOOKING_MODE!=='full'
    || env.WHATSAPP_BOOKING_MULTILINGUAL_ENABLED!=='on' || env.WHATSAPP_BOOKING_MODEL!==spec.model || env.WHATSAPP_BOOKING_REASONING_EFFORT!==spec.reasoning_effort
    || env.WHATSAPP_BOOKING_PROVIDER!=='twilio' || env.TWILIO_ACCOUNT_SID!==spec.account_sid || env.TWILIO_BOOKING_FROM!==spec.sender
    || env.BOOKING_URL!==spec.booking_url || env.TWILIO_BOOKING_WEBHOOK_URL!==spec.webhook_url || env.TWILIO_RECIPIENT_POLICY!=='allowlist'
    || !FLAGS.every(key=>env[key]===(issuing?'off':'on')) || now>=spec.expires_at || (!issuing && now<spec.starts_at)) return null;
  const recipients = String(env.TWILIO_RECIPIENT_ALLOWLIST || '').split(/[\s,]+/).filter(Boolean).sort();
  if (JSON.stringify(recipients)!==JSON.stringify(spec.recipients)) return null;
  // Residual selected pilots, continuation grants, readiness tests or voice
  // configuration cannot share this independent full-booking authorization.
  if (Object.entries(env).some(([key,value]) => /^WHATSAPP_BOOKING_(?:PILOT_|CONTINUATION_|VOICE_|READINESS_)/.test(key) && value!=null && value!=='' && value!=='off')) return null;
  if (!issuing && (!['WHATSAPP_BOOKING_MODEL_ENABLED','WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED','WHATSAPP_BOOKING_MODEL_EVAL_APPROVED','WHATSAPP_BOOKING_MODEL_SPEND_APPROVED'].every(key=>env[key]==='on')
    || !/^sk-[A-Za-z0-9_-]{12,}$/.test(env.WHATSAPP_BOOKING_FULL_OPENAI_API_KEY || '') || !env.TWILIO_AUTH_TOKEN || !env.SESSION_SECRET)) return null;
  return spec;
}
export const fullBookingReady = (env,now=Date.now()) => !!configuration(env,typeof now==='function'?now():now,false);
const clockFor = value => typeof value==='function'?value:()=>value;
const rootSpec = spec => ({ environment:spec.environment,budget_id:spec.budget_id,budget_micros:spec.budget_micros,retained_micros:spec.retained_micros,account_sid:spec.account_sid,sender:spec.sender,recipients:spec.recipients,booking_url:spec.booking_url,webhook_url:spec.webhook_url,costs:spec.costs });
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join(''); }
async function binding(spec) { return {grant:await hash(spec),root:await hash(rootSpec(spec))}; }
export async function fullBookingCanProceed(env, now=Date.now) {
  const clock=clockFor(now); now=clock();
  if(rehearsalSelected(env) && !await activeRehearsal(env,null,now))return false;
  const spec = configuration(env,now,false); if (!spec || !env.DB) return false;
  try {
    const hashes = await binding(spec);
    const row = await env.DB.prepare(`SELECT g.binding_hash, g.root_binding, g.stopped_reason, g.starts_at, g.expires_at, b.binding_hash AS budget_binding, b.stopped_reason AS budget_stop FROM whatsapp_full_booking_grants g JOIN whatsapp_full_booking_budgets b ON b.environment=g.environment WHERE g.id=?`).bind(spec.grant_id).first();
    const fresh=clock();
    return fullBookingReady(env,fresh) && !!row && row.binding_hash===hashes.grant && row.root_binding===hashes.root && row.budget_binding===hashes.root && row.stopped_reason==null && row.budget_stop==null && fresh>=row.starts_at && fresh<row.expires_at;
  } catch { return false; }
}
export async function issueFullBookingGrant(env, request, now=Date.now) {
  const clock=clockFor(now); now=clock();
  const spec = configuration(env,now,true);
  if (!spec || !env.DB || !exact(request,['version','grant_id','budget_id','source_sha256','approve']) || request.approve!==true || request.version!==1 || ['grant_id','budget_id','source_sha256'].some(key=>request[key]!==spec[key])) return false;
  try {
    const hashes=await binding(spec); now=clock();
    if (!configuration(env,now,true)) return false;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_full_booking_budgets (environment,budget_id,binding_hash,cap_micros,retained_micros,created_at) VALUES (?,?,?,?,?,?)`).bind(spec.environment,spec.budget_id,hashes.root,spec.budget_micros,spec.retained_micros,now),
      env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_full_booking_grants (id,environment,budget_id,binding_hash,root_binding,source_sha256,starts_at,expires_at,allocation_micros,inbound_limit,outbound_limit,address_limit,model_limit,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(spec.grant_id,spec.environment,spec.budget_id,hashes.grant,hashes.root,spec.source_sha256,spec.starts_at,spec.expires_at,spec.allocation_micros,...KINDS.map(kind=>spec.limits[kind]),now),
    ]);
    const row=await env.DB.prepare(`SELECT g.binding_hash,g.stopped_reason,b.binding_hash AS root_binding,b.stopped_reason AS root_stop FROM whatsapp_full_booking_grants g JOIN whatsapp_full_booking_budgets b ON b.environment=g.environment WHERE g.id=?`).bind(spec.grant_id).first();
    return !!row && row.binding_hash===hashes.grant && row.root_binding===hashes.root && row.stopped_reason==null && row.root_stop==null;
  } catch { return false; }
}
export async function reserveFullBookingOperation(env, kind, key, now=Date.now) {
  const clock=clockFor(now);
  const spec=fullBookingSpec(env);
  if (!spec || !KINDS.includes(kind) || !id(key) || !await fullBookingCanProceed(env,clock)) return false;
  now=clock(); if (!fullBookingReady(env,now)) return false;
  try {
    // D1 meta.changes includes the counter-trigger writes. RETURNING identifies
    // this statement's winning insert without guessing from aggregate changes or
    // reading a hold that another concurrent caller might have created.
    const result=await env.DB.prepare(`INSERT INTO whatsapp_full_booking_operations (grant_id,kind,operation_key,reserved_micros,status,created_at) SELECT ?,?,?,?,'pending',? WHERE NOT EXISTS (SELECT 1 FROM whatsapp_full_booking_operations WHERE grant_id=? AND kind=? AND operation_key=?) RETURNING operation_key`).bind(spec.grant_id,kind,key,FULL_BOOKING_COSTS[kind],now,spec.grant_id,kind,key).first();
    return result?.operation_key===key;
  } catch { return false; }
}
const OUTCOMES = new Set(['success','failed','uncertain','timeout','http_error','invalid_response','proposal_rejected','model_failure','provider_failure','valid_proposal','settlement_unconfirmed','transport_failure','response_size','response_json','response_envelope','refusal','expired','pilot_limit','input_token_count','input_limit','usage_unverified','proposal_json','proposal_schema','readiness_mismatch']);
const STOPS = new Set(['operator_stop','expired','budget_exhausted','model_failure','provider_failure','uncertain','configuration_changed']);
function diagnosticsOnly(value) {
  const result={};
  if (OUTCOMES.has(value?.outcome)) result.outcome=value.outcome;
  if (integer(value?.httpStatus,100,599)) result.httpStatus=value.httpStatus;
  if (integer(value?.elapsedMs,0,3600000)) result.elapsedMs=value.elapsedMs;
  if (typeof value?.softLatencyWarning==='boolean') result.softLatencyWarning=value.softLatencyWarning;
  for (const key of ['modelLatencyMs','turnLatencyMs']) if (integer(value?.[key],0,BOOKING_DEADLINES.operatorMs)) result[key]=value[key];
  const usage=value?.verifiedUsage;
  if (usage && integer(usage.input,0,16384) && integer(usage.cached,0,usage.input) && integer(usage.output,0,1024) && integer(usage.reasoning,0,usage.output)) result.verifiedUsage={input:usage.input,cached:usage.cached,output:usage.output,reasoning:usage.reasoning};
  const rejection=safeBookingRejection(value?.proposalRejection);
  if (rejection) result.proposalRejection=rejection;
  const stages={};
  for (const key of ['initial_off','reservation','presend_off','transport','usage_validation','envelope','proposal_validation','semantics','final_off','settlement','source_fingerprint','deployments_list','version_view','history_read','history_hash','model_reservation','presend_guard','provider_headers','response_body','postresponse_guard','strict_proposal','model_settlement','final_guard']) {
    const stage=value?.stageTimings?.[key];
    if (stage && integer(stage.calls,1,32) && integer(stage.totalMs,0,1920000) && integer(stage.maxMs,0,60000) && stage.maxMs<=stage.totalMs && stage.totalMs<=stage.calls*stage.maxMs) stages[key]={calls:stage.calls,totalMs:stage.totalMs,maxMs:stage.maxMs};
  }
  if(Object.keys(stages).length) result.stageTimings=stages;
  // Deliberately omit arbitrary keys, raw response data, text and errors.
  return JSON.stringify(result);
}
export async function finishFullBookingOperation(env, kind, key, success, diagnostics={}, now=Date.now) {
  const clock=clockFor(now); now=clock();
  const spec=fullBookingSpec(env);
  if (!spec || !env.DB || !KINDS.includes(kind) || !id(key) || typeof success!=='boolean' || !Number.isSafeInteger(now)) return false;
  try {
    const hashes=await binding(spec);
    const result=await env.DB.prepare(`UPDATE whatsapp_full_booking_operations SET status=?,diagnostics_json=?,finished_at=? WHERE grant_id=? AND kind=? AND operation_key=? AND status='pending' AND created_at<=? AND EXISTS (SELECT 1 FROM whatsapp_full_booking_grants g WHERE g.id=grant_id AND g.binding_hash=?)`).bind(success?'settled':'uncertain',diagnosticsOnly(diagnostics),now,spec.grant_id,kind,key,now,hashes.grant).run();
    return changed(result);
  } catch { return false; }
}
export async function stopFullBookingGrant(env, reason='operator_stop', now=Date.now) {
  const clock=clockFor(now); now=clock();
  const spec=fullBookingSpec(env); if (!spec || !env.DB || !STOPS.has(reason) || !Number.isSafeInteger(now)) return false;
  try {
    const hashes=await binding(spec);
    const result=await env.DB.prepare(`UPDATE whatsapp_full_booking_grants SET stopped_reason=?,stopped_at=? WHERE id=? AND binding_hash=? AND stopped_reason IS NULL`).bind(reason,now,spec.grant_id,hashes.grant).run();
    return changed(result);
  } catch { return false; }
}
export async function fullBookingStopped(env) {
  const spec=fullBookingSpec(env);if(!spec||!env.DB)return false;
  const hashes=await binding(spec);
  const row=await env.DB.prepare('SELECT stopped_at,stopped_reason FROM whatsapp_full_booking_grants WHERE id=? AND binding_hash=?').bind(spec.grant_id,hashes.grant).first();
  return Number(row?.stopped_at)>0 && typeof row.stopped_reason==='string';
}
export async function fullBookingBindingHash(env) {
  const spec=fullBookingSpec(env);return spec?(await binding(spec)).grant:null;
}
