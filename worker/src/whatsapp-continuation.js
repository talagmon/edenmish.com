import { lunaPilotConfiguration, lunaPilotBindingHash, lunaUsageUpperMicros } from './whatsapp-pilot-budget.js';

// New semantics; old LIMITS/hash/rows remain untouched. USD microdollars.
export const CONTINUATION = Object.freeze({ version: 1, windowMs: 1800000,
  inbound: 10, outbound: 10, address: 3, model: 6, inputTokens: 4096,
  outputTokens: 512, requestBytes: 8192, modelMicros: 30000,
  runMicros: 2000000, modelPoolMicros: 500000, feeCushionMicros: 500000 });
const COST = Object.freeze({ inbound: 10300, outbound: 11300, address: 32000, model: 30000 });
const FLAGS = ['WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'];
export const continuationSelected = env => !!(env.WHATSAPP_BOOKING_CONTINUATION_ID || env.WHATSAPP_BOOKING_CONTINUATION_VERSION);
const followon = env => env.WHATSAPP_BOOKING_CONTINUATION_VERSION==='2';
const grantTable = env => followon(env)?'whatsapp_continuation_followon_grants':'whatsapp_continuation_grants';
const operationTable = env => followon(env)?'whatsapp_continuation_followon_operations':'whatsapp_continuation_operations';
const grantId = env => `${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-${followon(env)?2:1}`;
const opId = (env, kind, key) => `${grantId(env)}:${kind}:${key}`;
const changes = r => Number(r?.meta?.changes || 0);
async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function config(env, now, issuing = false) {
  const start=Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_START || ''), end=Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_END || '');
  return lunaPilotConfiguration(env) && ['1','2'].includes(env.WHATSAPP_BOOKING_CONTINUATION_VERSION)
    && env.WHATSAPP_BOOKING_CONTINUATION_ID===grantId(env)
    && env.WHATSAPP_BOOKING_CONTINUATION_SCHEMA_READY==='on'
    && (!followon(env) || env.WHATSAPP_BOOKING_CONTINUATION_FOLLOWON_SCHEMA_READY==='on')
    && env.WHATSAPP_BOOKING_CONTINUATION_APPROVED==='on'
    && env.WHATSAPP_BOOKING_CONTINUATION_COST_REVIEW==='bounded-v1'
    && env.WHATSAPP_BOOKING_CONTINUATION_COSTS_UNKNOWN==='off'
    && env.WHATSAPP_BOOKING_READINESS_APPROVED==='off'
    && env.WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED==='off'
    && env.WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED==='off'
    && !env.WHATSAPP_BOOKING_PILOT_STARTED_AT && !env.WHATSAPP_BOOKING_PILOT_EXPIRES_AT
    && FLAGS.every(k=>env[k]===(issuing?'off':'on'))
    && (issuing || env.WHATSAPP_BOOKING_MODEL_EVAL_APPROVED==='on')
    && Number.isFinite(start) && Number.isFinite(end) && end>start && end-start<=CONTINUATION.windowMs
    && now<end && (issuing ? start>=now && start<=now+CONTINUATION.windowMs : now>=start);
}
export const continuationIssuable = (env,now=Date.now()) => !!config(env,now,true);
export const continuationReady = (env,now=Date.now()) => !!config(env,now);
async function binding(env) {
  return hash([await lunaPilotBindingHash(env),followon(env)?{...CONTINUATION,version:2}:CONTINUATION,COST,env.WHATSAPP_BOOKING_CONTINUATION_ID,
    env.WHATSAPP_BOOKING_CONTINUATION_START,env.WHATSAPP_BOOKING_CONTINUATION_END,'bounded-v1']);
}
async function history(env,now=Date.now()) {
  const root=await env.DB.prepare('SELECT * FROM whatsapp_pilot_budgets WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  const rows=(await env.DB.prepare('SELECT * FROM whatsapp_pilot_model_attempts WHERE pilot_id=? ORDER BY id').bind(env.WHATSAPP_BOOKING_PILOT_ID).all()).results || [];
  const base=`${env.WHATSAPP_BOOKING_PILOT_ID}:readiness:small_item`;
  if (!root || root.binding_hash!==await lunaPilotBindingHash(env) || root.attempts!==3 || root.charged_micros!==300000
    || root.lock_id!==null || root.started_at!==null || root.expires_at!==null || root.stopped_reason!=='transport_failure'
    || rows.length!==3 || rows.some((r,i)=>r.id!==base+['',':2',':3'][i] || r.charged_micros!==100000
      || r.status!==['uncertain','uncertain','settled'][i] || r.outcome!==['transport_failure','readiness_mismatch','valid_proposal'][i])) return null;
  // This run has had no handset use. Earlier, separately authorized IDs are excluded.
  const counters=(await env.DB.prepare('SELECT key,count FROM rate_limits WHERE key LIKE ? ORDER BY key').bind(`wa-pilot:${env.WHATSAPP_BOOKING_PILOT_ID}:%`).all()).results || [];
  if(counters.some(r=>r.count!==0))return null;
  const original=await hash([root,rows,counters]);
  if(!followon(env))return original;
  // A second, separately approved window is only possible for an UNUSED expired
  // predecessor. Never transfer/refund spend or generalize to repeat windows.
  const prior=await env.DB.prepare('SELECT * FROM whatsapp_continuation_grants WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  if(!prior || prior.id!==`${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-1` || prior.version!==1
    || prior.history_hash!==original || prior.expires_at>now || prior.lock_id!==null || prior.stopped_reason!==null
    || prior.historical_micros!==300000 || prior.fee_cushion_micros!==500000
    || ['spent_micros','model_micros','inbound','outbound','address','model'].some(k=>prior[k]!==0))return null;
  const operations=await env.DB.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_operations WHERE grant_id=?').bind(prior.id).first();
  if(operations?.n!==0)return null;
  return hash([original,prior]);
}
// Authenticated operator issuance only; customer processing never calls this.
// Issuance is separately authorized; config is OFF and activation remains separate.
export async function issueContinuationGrant(env,now=Date.now()) {
  if(!config(env,now,true))return false;
  const historical=await history(env,now);if(!historical)return false;
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO ${grantTable(env)}
    (id,pilot_id,version,binding_hash,history_hash,starts_at,expires_at,historical_micros,fee_cushion_micros,created_at)
    VALUES (?,?,?,?,?,?,?,300000,500000,?)`).bind(grantId(env),env.WHATSAPP_BOOKING_PILOT_ID,Number(env.WHATSAPP_BOOKING_CONTINUATION_VERSION),await binding(env),historical,
      Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_START),Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_END),now).run();
  return changes(result)===1;
}
async function active(env,now) {
  if(!continuationReady(env,now))return null;
  const row=await env.DB.prepare(`SELECT * FROM ${grantTable(env)} WHERE id=?`).bind(grantId(env)).first();
  if(!row || row.version!==Number(env.WHATSAPP_BOOKING_CONTINUATION_VERSION) || row.binding_hash!==await binding(env) || row.history_hash!==await history(env,now)
    || row.stopped_reason || now<row.starts_at || now>=row.expires_at
    || row.historical_micros+row.fee_cushion_micros+row.spent_micros>CONTINUATION.runMicros
    || row.historical_micros+row.model_micros>CONTINUATION.modelPoolMicros)return null;
  return row;
}
export async function continuationCanProceed(env,now=Date.now()) {return !!await active(env,now);}
export async function stopContinuation(env,reason='operator_stop') {
  if(!continuationSelected(env))return;
  const safe=['operator_stop','provider_uncertain','cost_unknown','expired','model_failure'].includes(reason)?reason:'provider_uncertain';
  await env.DB.prepare(`UPDATE ${grantTable(env)} SET stopped_reason=COALESCE(stopped_reason,?) WHERE id=?`).bind(safe,grantId(env)).run();
}
export async function reserveContinuation(env,kind,key,now=Date.now()) {
  if(!Object.hasOwn(COST,kind) || !/^[A-Za-z0-9:_-]{1,160}$/.test(key || ''))return null;
  const row=await active(env,now);if(!row)return null;
  const id=opId(env,kind,key), cost=COST[kind], model=kind==='model';
  // Only allowlisted enum names enter SQL. Reserve and immutable operation insert
  // are one D1 transaction; a duplicate can never authorize repeat provider IO.
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE ${grantTable(env)} SET ${kind}=${kind}+1,
      spent_micros=spent_micros+?,model_micros=model_micros+?,lock_id=CASE WHEN ?=1 THEN ? ELSE lock_id END
      WHERE id=? AND binding_hash=? AND history_hash=? AND stopped_reason IS NULL AND lock_id IS NULL
      AND starts_at<=? AND expires_at>? AND ${kind}<?
      AND historical_micros+model_micros+?<=? AND historical_micros+fee_cushion_micros+spent_micros+?<=?
      AND NOT EXISTS (SELECT 1 FROM ${operationTable(env)} WHERE id=?)`)
      .bind(cost,model?cost:0,Number(kind!=='inbound'),id,row.id,row.binding_hash,row.history_hash,now,now,CONTINUATION[kind],model?cost:0,
        CONTINUATION.modelPoolMicros,cost,CONTINUATION.runMicros,id),
    env.DB.prepare(`INSERT OR IGNORE INTO ${operationTable(env)} (id,grant_id,kind,status,reserved_micros,created_at)
      SELECT ?,?,?,?, ?,? WHERE changes()=1`).bind(id,row.id,kind,kind==='inbound'?'settled':'pending',cost,now),
  ]);
  return changes(result[0]) && changes(result[1]) ? id : null;
}
export async function finishContinuation(env,kind,key,{ok=false,usage=null}={},now=Date.now()) {
  const id=opId(env,kind,key);
  const valid=ok && continuationReady(env,now) && await continuationCanProceed(env,now)
    && (kind!=='model' || (usage?.input_tokens<=CONTINUATION.inputTokens && usage?.output_tokens<=CONTINUATION.outputTokens
      && lunaUsageUpperMicros(usage)!==null && lunaUsageUpperMicros(usage)<=CONTINUATION.modelMicros));
  // Never refund. Late success cannot revive an uncertain result or clear a stop.
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${operationTable(env)} SET status=?,outcome=?,input_tokens=?,output_tokens=?,finished_at=?
      WHERE id=? AND grant_id=? AND status='pending'`).bind(valid?'settled':'uncertain',valid?'valid':'uncertain',valid?usage?.input_tokens??null:null,
        valid?usage?.output_tokens??null:null,now,id,grantId(env)),
    env.DB.prepare(`UPDATE ${grantTable(env)} SET stopped_reason=COALESCE(stopped_reason,?),
      lock_id=CASE WHEN lock_id=? THEN NULL ELSE lock_id END WHERE id=? AND changes()=1`)
      .bind(valid?null:'provider_uncertain',id,grantId(env)),
  ]);
}
