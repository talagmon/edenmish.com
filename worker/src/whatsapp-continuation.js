import { continuationHistorySnapshot } from './whatsapp-continuation-snapshot.js';
import { localCopy } from './whatsapp-booking-i18n.js';
import { safeBookingRejection } from './whatsapp-booking-diagnostics.js';
import { lunaPilotConfiguration, lunaPilotBindingHash, lunaUsageUpperMicros } from './whatsapp-pilot-budget.js';

// New semantics; old LIMITS/hash/rows remain untouched. USD microdollars.
export const CONTINUATION = Object.freeze({ version: 1, windowMs: 1800000,
  inbound: 10, outbound: 10, address: 3, model: 6, inputTokens: 4096,
  outputTokens: 512, requestBytes: 8192, modelMicros: 30000,
  runMicros: 2000000, modelPoolMicros: 500000, feeCushionMicros: 500000 });
// Separately approved October 10 Sol-low session; prior holds are never refunded.
export const SOL_SESSION = Object.freeze({...CONTINUATION,version:4,windowMs:900000,
  inbound:12,outbound:12,model:4,inputTokens:16384,outputTokens:1024,
  modelMicros:56320,modelPoolMicros:820504,historicalMicros:735124,historicalModelMicros:595224});
// Fresh $1.65 authorization: prior $0.735124 stays retained separately.
// Reserve $0.03 for the independent audio ledger and $0.25 contingency up front.
export const VOICE_SESSION = Object.freeze({...SOL_SESSION,version:5,inbound:24,outbound:24,address:4,model:12,
  runMicros:2385124,modelPoolMicros:1271064,feeCushionMicros:280000});
// One fresh text-only release smoke test. Every old grant/hold remains retained.
export const REVIEW_SESSION = Object.freeze({...SOL_SESSION,version:6,inbound:8,outbound:8,address:2,model:1,
  historicalMicros:912564,historicalModelMicros:707864,feeCushionMicros:780000,
  runMicros:1986244,modelPoolMicros:764184});
export const REVIEW_PREFLIGHT = Object.freeze({id:'edenmish-release-smoke-20261010-r1',
  requestHash:'0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3',reservedMicros:56320});
export const REVIEW_R2_SESSION = Object.freeze({...REVIEW_SESSION,version:7,inbound:6,outbound:6,
  historicalMicros:968884,historicalModelMicros:764184,runMicros:1998804,modelPoolMicros:820504});
export const REVIEW_R2_PREFLIGHT = Object.freeze({...REVIEW_PREFLIGHT,id:'edenmish-release-smoke-20261011-r2'});
export const REVIEW_R3_SESSION = Object.freeze({...REVIEW_R2_SESSION,version:8,inbound:5,outbound:5,address:0,
  historicalMicros:1025204,historicalModelMicros:820504,runMicros:1969524,modelPoolMicros:876824});
export const REVIEW_R3_PREFLIGHT = Object.freeze({...REVIEW_PREFLIGHT,id:'edenmish-release-smoke-20261011-r3'});
const reviewR3 = env => env.WHATSAPP_BOOKING_CONTINUATION_VERSION==='8';
const reviewR2 = env => env.WHATSAPP_BOOKING_CONTINUATION_VERSION==='7';
const reviewSession = env => ['6','7','8'].includes(env.WHATSAPP_BOOKING_CONTINUATION_VERSION);
const reviewProof = env => reviewR3(env)?REVIEW_R3_PREFLIGHT:reviewR2(env)?REVIEW_R2_PREFLIGHT:REVIEW_PREFLIGHT;
const reviewAuthorization = env => reviewR3(env)?'release-smoke-022064-v3':reviewR2(env)?'release-smoke-030624-v2':'release-smoke-035-v1';
const voiceSession = env => env.WHATSAPP_BOOKING_CONTINUATION_VERSION==='5';
export const solSession = env => ['4','5','6','7','8'].includes(env.WHATSAPP_BOOKING_CONTINUATION_VERSION);
export function solUsageUpperMicros(usage) {
  const n=usage?.input_tokens,o=usage?.output_tokens,c=usage?.input_tokens_details?.cached_tokens,r=usage?.output_tokens_details?.reasoning_tokens;
  if(![n,o,c,r].every(Number.isSafeInteger)||n<0||o<0||c<0||r<0||c>n||r>o
    ||n>SOL_SESSION.inputTokens||o>SOL_SESSION.outputTokens||usage.total_tokens!==n+o)return null;
  return Math.ceil((n*5+o*20)*11/20);
}
export const continuationFailureNoticePolicy = env => env.WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY==='one-shot-v1';
export const failureNoticeText = (language,env={}) => !reviewSession(env) && language && language!=='he'
  ? localCopy(language,'I could not process those details. Automation is paused. Please contact a person to continue.')
  : 'לא הצלחתי לעבד את הפרטים. האוטומציה נעצרה. אפשר לפנות לנציג להמשך.';
const COST = Object.freeze({ inbound: 10300, outbound: 11300, address: 32000, model: 30000 });
const costs = env => solSession(env)?{...COST,model:SOL_SESSION.modelMicros}:COST;
const FLAGS = ['WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'];
export const continuationSelected = env => !!(env.WHATSAPP_BOOKING_CONTINUATION_ID || env.WHATSAPP_BOOKING_CONTINUATION_VERSION);
const retry = env => ['3','4','5','6','7','8'].includes(env.WHATSAPP_BOOKING_CONTINUATION_VERSION);
const followon = env => ['2','3','4','5','6','7','8'].includes(env.WHATSAPP_BOOKING_CONTINUATION_VERSION);
const historicalModel = (env,row) => retry(env)?row.historical_model_micros:row.historical_micros;
const historicalModelColumn = env => retry(env)?'historical_model_micros':'historical_micros';
const limits = env => reviewR3(env)?REVIEW_R3_SESSION:reviewR2(env)?REVIEW_R2_SESSION:reviewSession(env)?REVIEW_SESSION:voiceSession(env)?VOICE_SESSION:solSession(env)?SOL_SESSION:retry(env)?{...CONTINUATION,version:3,model:5}:followon(env)?{...CONTINUATION,version:2}:CONTINUATION;
const grantTable = env => reviewR3(env)?'whatsapp_continuation_review_r3_grants':reviewR2(env)?'whatsapp_continuation_review_r2_grants':reviewSession(env)?'whatsapp_continuation_review_grants':voiceSession(env)?'whatsapp_continuation_voice_grants':solSession(env)?'whatsapp_continuation_sol_grants':retry(env)?'whatsapp_continuation_retry_grants':followon(env)?'whatsapp_continuation_followon_grants':'whatsapp_continuation_grants';
const operationTable = env => reviewR3(env)?'whatsapp_continuation_review_r3_operations':reviewR2(env)?'whatsapp_continuation_review_r2_operations':reviewSession(env)?'whatsapp_continuation_review_operations':voiceSession(env)?'whatsapp_continuation_voice_operations':solSession(env)?'whatsapp_continuation_sol_operations':retry(env)?'whatsapp_continuation_retry_operations':followon(env)?'whatsapp_continuation_followon_operations':'whatsapp_continuation_operations';
const grantId = env => `${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-${reviewR3(env)?8:reviewR2(env)?7:reviewSession(env)?6:voiceSession(env)?5:solSession(env)?4:retry(env)?3:followon(env)?2:1}`;
const opId = (env, kind, key) => `${grantId(env)}:${kind}:${key}`;
const changes = r => Number(r?.meta?.changes || 0);
async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function config(env, now, issuing = false) {
  const start=Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_START || ''), end=Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_END || '');
  return (solSession(env) ? lunaPilotConfiguration({...env,WHATSAPP_BOOKING_MODEL:'gpt-6-luna'})
      && env.WHATSAPP_BOOKING_MODEL==='gpt-6.1-sol' && env.WHATSAPP_BOOKING_REASONING_EFFORT==='low'
      && env.WHATSAPP_BOOKING_CONTINUATION_SOL_SCHEMA_READY==='on' : lunaPilotConfiguration(env))
    && (!reviewSession(env) || (env.WHATSAPP_BOOKING_CONTINUATION_REVIEW_SCHEMA_READY==='on'
      && env.WHATSAPP_BOOKING_MODE==='conversation_only' && env.WHATSAPP_BOOKING_MULTILINGUAL_ENABLED==='on'
      && env.WHATSAPP_BOOKING_VOICE_ENABLED==='off' && env.WHATSAPP_BOOKING_VOICE_PROFILE==='off'
      && /^[a-f0-9]{64}$/.test(env.WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256 || '')
      && env.WHATSAPP_BOOKING_REVIEW_AUTHORIZATION===reviewAuthorization(env)))
    && (!voiceSession(env) || (env.WHATSAPP_BOOKING_CONTINUATION_VOICE_SCHEMA_READY==='on' && env.WHATSAPP_BOOKING_MODE==='conversation_only'))
    && ['1','2','3','4','5','6','7','8'].includes(env.WHATSAPP_BOOKING_CONTINUATION_VERSION)
    && (!env.WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY || ['off','one-shot-v1'].includes(env.WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY))
    && env.WHATSAPP_BOOKING_CONTINUATION_ID===grantId(env)
    && env.WHATSAPP_BOOKING_CONTINUATION_SCHEMA_READY==='on'
    && (!followon(env) || env.WHATSAPP_BOOKING_CONTINUATION_FOLLOWON_SCHEMA_READY==='on')
    && (!retry(env) || (env.WHATSAPP_BOOKING_CONTINUATION_RETRY_SCHEMA_READY==='on' && continuationFailureNoticePolicy(env)))
    && env.WHATSAPP_BOOKING_CONTINUATION_APPROVED==='on'
    && env.WHATSAPP_BOOKING_CONTINUATION_COST_REVIEW==='bounded-v1'
    && env.WHATSAPP_BOOKING_CONTINUATION_COSTS_UNKNOWN==='off'
    && env.WHATSAPP_BOOKING_READINESS_APPROVED==='off'
    && env.WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED==='off'
    && env.WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED==='off'
    && !env.WHATSAPP_BOOKING_PILOT_STARTED_AT && !env.WHATSAPP_BOOKING_PILOT_EXPIRES_AT
    && FLAGS.every(k=>env[k]===(issuing?'off':'on'))
    && (issuing || env.WHATSAPP_BOOKING_MODEL_EVAL_APPROVED==='on')
    && Number.isFinite(start) && Number.isFinite(end) && end>start && end-start<=limits(env).windowMs
    && now<end && (issuing ? start>=now && start<=now+limits(env).windowMs : now>=start);
}
export const continuationIssuable = (env,now=Date.now()) => !!config(env,now,true);
export const continuationReady = (env,now=Date.now()) => !!config(env,now);
async function binding(env) {
  return hash([await lunaPilotBindingHash(env),limits(env),costs(env),env.WHATSAPP_BOOKING_CONTINUATION_ID,
    env.WHATSAPP_BOOKING_CONTINUATION_START,env.WHATSAPP_BOOKING_CONTINUATION_END,'bounded-v1',
    ...(continuationFailureNoticePolicy(env)?['failure-notice-one-shot-v1']:[]),
    ...(solSession(env)?['gpt-6.1-sol','low','no-counting-v1']:[]),
    ...(reviewSession(env)?[env.WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256,reviewProof(env),reviewAuthorization(env)]:[]) ]);
}
async function history(env,now=Date.now(),db=env.DB) {
  const root=await db.prepare('SELECT * FROM whatsapp_pilot_budgets WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  const rows=(await db.prepare('SELECT * FROM whatsapp_pilot_model_attempts WHERE pilot_id=? ORDER BY id').bind(env.WHATSAPP_BOOKING_PILOT_ID).all()).results || [];
  const base=`${env.WHATSAPP_BOOKING_PILOT_ID}:readiness:small_item`;
  if (!root || root.binding_hash!==await lunaPilotBindingHash(env) || root.attempts!==3 || root.charged_micros!==300000
    || root.lock_id!==null || root.started_at!==null || root.expires_at!==null || root.stopped_reason!=='transport_failure'
    || rows.length!==3 || rows.some((r,i)=>r.id!==base+['',':2',':3'][i] || r.charged_micros!==100000
      || r.status!==['uncertain','uncertain','settled'][i] || r.outcome!==['transport_failure','readiness_mismatch','valid_proposal'][i])) return null;
  // This run has had no handset use. Earlier, separately authorized IDs are excluded.
  const counters=(await db.prepare('SELECT key,count FROM rate_limits WHERE key LIKE ? ORDER BY key').bind(`wa-pilot:${env.WHATSAPP_BOOKING_PILOT_ID}:%`).all()).results || [];
  if(counters.some(r=>r.count!==0))return null;
  const original=await hash([root,rows,counters]);
  if(!followon(env))return original;
  // A second, separately approved window is only possible for an UNUSED expired
  // predecessor. Never transfer/refund spend or generalize to repeat windows.
  const prior=await db.prepare('SELECT * FROM whatsapp_continuation_grants WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  if(!prior || prior.id!==`${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-1` || prior.version!==1
    || prior.history_hash!==original || prior.expires_at>now || prior.lock_id!==null || prior.stopped_reason!==null
    || prior.historical_micros!==300000 || prior.fee_cushion_micros!==500000
    || ['spent_micros','model_micros','inbound','outbound','address','model'].some(k=>prior[k]!==0))return null;
  const operations=await db.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_operations WHERE grant_id=?').bind(prior.id).first();
  if(operations?.n!==0)return null;
  const previousHash=await hash([original,prior]);
  if(!retry(env))return previousHash;
  const stopped=await db.prepare('SELECT * FROM whatsapp_continuation_followon_grants WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  if(!stopped || stopped.id!==`${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-2` || stopped.version!==2
    || stopped.history_hash!==previousHash || stopped.expires_at>now || stopped.lock_id!==null || stopped.stopped_reason!=='provider_uncertain'
    || stopped.historical_micros!==300000 || stopped.fee_cushion_micros!==500000 || stopped.spent_micros!==105100 || stopped.model_micros!==30000
    || stopped.inbound!==4 || stopped.outbound!==3 || stopped.address!==0 || stopped.model!==1)return null;
  const ops=(await db.prepare('SELECT * FROM whatsapp_continuation_followon_operations WHERE grant_id=? ORDER BY id').bind(stopped.id).all()).results || [];
  if(ops.length!==8 || ops.reduce((sum,o)=>sum+o.reserved_micros,0)!==105100
    || ops.filter(o=>o.kind==='inbound' && o.status==='settled' && o.reserved_micros===10300).length!==4
    || ops.filter(o=>o.kind==='outbound' && o.status==='settled' && o.reserved_micros===11300).length!==3
    || ops.filter(o=>o.kind==='model' && o.status==='uncertain' && o.reserved_micros===30000 && o.finished_at!==null).length!==1)return null;
  const retryHistory=await hash([previousHash,stopped,ops]);
  if(!solSession(env))return retryHistory;
  const third=await db.prepare('SELECT * FROM whatsapp_continuation_retry_grants WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  if(!third || third.id!==`${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-3` || third.version!==3
    ||third.history_hash!==retryHistory||third.expires_at>now||third.lock_id!==null||third.stopped_reason!=='model_uncertain'
    ||third.historical_micros!==405100||third.historical_model_micros!==330000||third.fee_cushion_micros!==500000
    ||third.spent_micros!==94800||third.model_micros!==30000||third.inbound!==3||third.outbound!==3||third.address!==0||third.model!==1)return null;
  const thirdOps=(await db.prepare('SELECT * FROM whatsapp_continuation_retry_operations WHERE grant_id=? ORDER BY id').bind(third.id).all()).results||[];
  if(thirdOps.length!==7||thirdOps.reduce((sum,o)=>sum+o.reserved_micros,0)!==94800
    ||thirdOps.filter(o=>o.kind==='inbound'&&o.status==='settled'&&o.reserved_micros===10300).length!==3
    ||thirdOps.filter(o=>o.kind==='outbound'&&o.status==='settled'&&o.reserved_micros===11300).length!==3
    ||thirdOps.filter(o=>o.kind==='model'&&o.status==='uncertain'&&o.reserved_micros===30000&&o.finished_at!==null).length!==1)return null;
  const fourthHistory=await hash([retryHistory,third,thirdOps,{offlineModelHoldsMicros:235224}]);
  if(!voiceSession(env) && !reviewSession(env))return fourthHistory;
  const fourth=await db.prepare('SELECT * FROM whatsapp_continuation_sol_grants WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  if(!fourth||fourth.version!==4||fourth.id!==`${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-4`
    ||fourth.history_hash!==fourthHistory||fourth.expires_at>now||fourth.lock_id!==null||fourth.stopped_reason!==null
    ||fourth.historical_micros!==735124||fourth.historical_model_micros!==595224||fourth.fee_cushion_micros!==500000
    ||['spent_micros','model_micros','inbound','outbound','address','model'].some(k=>fourth[k]!==0))return null;
  const fourthOps=await db.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_sol_operations WHERE grant_id=?').bind(fourth.id).first();
  if(fourthOps?.n!==0)return null;
  const voiceHistory=await hash([fourthHistory,fourth,{newAuthorizationMicros:1650000,audioReservedMicros:30000}]);
  if(!reviewSession(env))return voiceHistory;
  const fifth=await db.prepare('SELECT * FROM whatsapp_continuation_voice_grants WHERE pilot_id=?').bind(env.WHATSAPP_BOOKING_PILOT_ID).first();
  if(!fifth || fifth.id!==`${env.WHATSAPP_BOOKING_PILOT_ID}:quote-v2-handset-5` || fifth.version!==5
    || fifth.history_hash!==voiceHistory || fifth.expires_at>now || fifth.lock_id!==null || fifth.stopped_reason!=='model_uncertain'
    || fifth.historical_micros!==735124 || fifth.historical_model_micros!==595224 || fifth.fee_cushion_micros!==280000
    || fifth.spent_micros!==121120 || fifth.model_micros!==56320 || fifth.inbound!==3 || fifth.outbound!==3 || fifth.address!==0 || fifth.model!==1)return null;
  const fifthOps=(await db.prepare('SELECT * FROM whatsapp_continuation_voice_operations WHERE grant_id=? ORDER BY id').bind(fifth.id).all()).results||[];
  if(fifthOps.length!==7 || fifthOps.reduce((n,o)=>n+o.reserved_micros,0)!==121120
    || fifthOps.filter(o=>o.kind==='inbound' && o.status==='settled' && o.reserved_micros===10300).length!==3
    || fifthOps.filter(o=>o.kind==='outbound' && o.status==='settled' && o.reserved_micros===11300).length!==3
    || fifthOps.filter(o=>o.kind==='model' && o.status==='uncertain' && o.reserved_micros===56320 && o.finished_at!==null).length!==1)return null;
  const audio=(await db.prepare('SELECT * FROM whatsapp_voice_grants ORDER BY id').all()).results||[];
  const audioAttempts=await db.prepare('SELECT COUNT(*) n FROM whatsapp_voice_attempts').first();
  if(audio.length!==1 || audio[0].used_calls!==0 || audio[0].reserved_micros!==0 || audio[0].approved_micros!==30000
    || audio[0].expires_at>now || audioAttempts?.n!==0)return null;
  let priorReview = [];
  if (reviewR2(env) || reviewR3(env)) {
    const failed = await db.prepare('SELECT * FROM whatsapp_review_preflight WHERE id=?').bind(REVIEW_PREFLIGHT.id).first();
    const counts = await db.prepare('SELECT (SELECT COUNT(*) FROM whatsapp_continuation_review_grants) AS grants, (SELECT COUNT(*) FROM whatsapp_continuation_review_operations) AS operations').first();
    if (!failed || failed.status!=='failed' || failed.reserved_micros!==56320 || failed.request_sha256!==REVIEW_PREFLIGHT.requestHash
      || failed.source_sha256!=='9463b47cce9e4ff77e49cb3640f6ae67789187f4d1a30630d14862b7a9de835f'
      || !Number.isSafeInteger(failed.finished_at) || failed.finished_at<failed.created_at || failed.finished_at>now
      || counts?.grants!==0 || counts?.operations!==0) return null;
    priorReview = [failed,counts,{unusedAllocationTransferredMicros:293680,previouslyUnallocatedMicros:12560}];
  }
  if (reviewR3(env)) {
    const failedR2 = await db.prepare('SELECT * FROM whatsapp_review_r2_preflight WHERE id=?').bind(REVIEW_R2_PREFLIGHT.id).first();
    const countsR2 = await db.prepare('SELECT (SELECT COUNT(*) FROM whatsapp_continuation_review_r2_grants) AS grants, (SELECT COUNT(*) FROM whatsapp_continuation_review_r2_operations) AS operations').first();
    if (!failedR2 || failedR2.status!=='failed' || failedR2.reserved_micros!==56320 || failedR2.request_sha256!==REVIEW_R2_PREFLIGHT.requestHash
      || failedR2.source_sha256!=='531f995ae64dd7f64f61fcebf864cfa68f2cf9b31f3e08a92c3a28a3a821682d'
      || !Number.isSafeInteger(failedR2.finished_at) || failedR2.finished_at<failedR2.created_at || failedR2.finished_at>now
      || countsR2?.grants!==0 || countsR2?.operations!==0) return null;
    priorReview = [failedR2,countsR2,...priorReview,{unusedV7TransferredMicros:220640,unusedV7ParkedMicros:29280,additionalUnallocatedMicros:0}];
  }
  const spec=reviewProof(env),table=reviewR3(env)?'whatsapp_review_r3_preflight':reviewR2(env)?'whatsapp_review_r2_preflight':'whatsapp_review_preflight';
  const proof=await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(spec.id).first();
  if(!proof || proof.status!=='matched' || proof.request_sha256!==spec.requestHash
    || proof.source_sha256!==env.WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256 || proof.reserved_micros!==spec.reservedMicros
    || !Number.isSafeInteger(proof.finished_at) || proof.finished_at<proof.created_at || proof.finished_at>now
    || proof.finished_at>=proof.expires_at || now>=proof.expires_at || proof.created_at<fifth.expires_at
    || (reviewR2(env) || reviewR3(env)) && (proof.created_at<priorReview[0].finished_at || proof.expires_at<Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_END)))return null;
  return hash([voiceHistory,fifth,fifthOps,audio,...priorReview,proof,{allCushionsRetainedMicros:780000}]);
}
// Authenticated operator issuance only; customer processing never calls this.
// Issuance is separately authorized; config is OFF and activation remains separate.
export async function issueContinuationGrant(env,now=Date.now()) {
  if(!config(env,now,true))return false;
  const historical=await history(env,now);if(!historical)return false;
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO ${grantTable(env)}
    (id,pilot_id,version,binding_hash,history_hash,starts_at,expires_at,historical_micros,fee_cushion_micros,created_at${retry(env)?',historical_model_micros':''})
    VALUES (?,?,?,?,?,?,?,${reviewR3(env)?1025204:reviewR2(env)?968884:reviewSession(env)?912564:solSession(env)?735124:retry(env)?405100:300000},${limits(env).feeCushionMicros},?${reviewR3(env)?',820504':reviewR2(env)?',764184':reviewSession(env)?',707864':solSession(env)?',595224':retry(env)?',330000':''})`).bind(grantId(env),env.WHATSAPP_BOOKING_PILOT_ID,Number(env.WHATSAPP_BOOKING_CONTINUATION_VERSION),await binding(env),historical,
      Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_START),Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_END),now).run();
  return changes(result)===1;
}
// Advance the logical caller time across awaits, including deterministic fixture clocks.
// Monotonic elapsed time and a wall-clock high-water mark never move backwards.
const freshClock=now=>{const wall=Date.now(),mono=performance.now();let elapsed=0;return ()=>{elapsed=Math.max(elapsed,Date.now()-wall,Math.floor(performance.now()-mono));return now+elapsed;};};
async function activeReviewR3(env,now,allowStopped,fresh){
  try{
    const snapshot=await continuationHistorySnapshot(env.DB,env.WHATSAPP_BOOKING_PILOT_ID,[REVIEW_PREFLIGHT.id,REVIEW_R2_PREFLIGHT.id,REVIEW_R3_PREFLIGHT.id]);
    const historical=await history(env,fresh(),snapshot);if(!historical)return null;
    snapshot.assertConsumed();
    const expectedBinding=await binding(env);
    // Mutable stop/counters/lock are deliberately read AFTER the history transaction.
    const row=await env.DB.prepare(`SELECT * FROM ${grantTable(env)} WHERE id=?`).bind(grantId(env)).first();
    now=fresh();
    if(!continuationReady(env,now)||!row||row.version!==8||row.binding_hash!==expectedBinding||row.history_hash!==historical
      ||(!allowStopped&&row.stopped_reason)||now<row.starts_at||now>=row.expires_at||now>=snapshot.proofExpiresAt
      ||row.historical_micros+row.fee_cushion_micros+row.spent_micros>limits(env).runMicros
      ||historicalModel(env,row)+row.model_micros>limits(env).modelPoolMicros)return null;
    return row;
  }catch{return null;}
}
async function active(env,now,allowStopped=false,fresh=freshClock(now)) {
  if(!continuationReady(env,now))return null;
  if(reviewR3(env))return activeReviewR3(env,now,allowStopped,fresh);
  const row=await env.DB.prepare(`SELECT * FROM ${grantTable(env)} WHERE id=?`).bind(grantId(env)).first();
  if(!row || row.version!==Number(env.WHATSAPP_BOOKING_CONTINUATION_VERSION) || row.binding_hash!==await binding(env) || row.history_hash!==await history(env,now)
    || (!allowStopped && row.stopped_reason) || now<row.starts_at || now>=row.expires_at
    || row.historical_micros+row.fee_cushion_micros+row.spent_micros>limits(env).runMicros
    || historicalModel(env,row)+row.model_micros>limits(env).modelPoolMicros)return null;
  return row;
}
export async function continuationCanProceed(env,now=Date.now()) {return !!await active(env,now);}
export async function stopContinuation(env,reason='operator_stop') {
  if(!continuationSelected(env))return;
  const safe=['operator_stop','provider_uncertain','cost_unknown','expired','model_failure'].includes(reason)?reason:'provider_uncertain';
  // An explicit stop/rejected delivery revokes the narrow notice permission too.
  await env.DB.prepare(`UPDATE ${grantTable(env)} SET stopped_reason=CASE WHEN stopped_reason='model_uncertain' THEN ? ELSE COALESCE(stopped_reason,?) END WHERE id=?`).bind(safe,safe,grantId(env)).run();
}
export async function reserveContinuation(env,kind,key,now=Date.now()) {
  if(!Object.hasOwn(COST,kind) || !/^[A-Za-z0-9:_-]{1,160}$/.test(key || ''))return null;
  const fresh=freshClock(now);
  const row=await active(env,now,false,fresh);if(!row)return null;
  if(reviewR3(env)){now=fresh();if(!continuationReady(env,now)||now>=row.expires_at)return null;}
  const id=opId(env,kind,key), cost=costs(env)[kind], model=kind==='model';
  // Only allowlisted enum names enter SQL. Reserve and immutable operation insert
  // are one D1 transaction; a duplicate can never authorize repeat provider IO.
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE ${grantTable(env)} SET ${kind}=${kind}+1,
      spent_micros=spent_micros+?,model_micros=model_micros+?,lock_id=CASE WHEN ?=1 THEN ? ELSE lock_id END
      WHERE id=? AND binding_hash=? AND history_hash=? AND stopped_reason IS NULL AND lock_id IS NULL
      AND starts_at<=? AND expires_at>? AND ${kind}<?
      AND ${historicalModelColumn(env)}+model_micros+?<=? AND historical_micros+fee_cushion_micros+spent_micros+?<=?
      AND NOT EXISTS (SELECT 1 FROM ${operationTable(env)} WHERE id=?)`)
      .bind(cost,model?cost:0,Number(kind!=='inbound'),id,row.id,row.binding_hash,row.history_hash,now,now,limits(env)[kind],model?cost:0,
        limits(env).modelPoolMicros,cost,limits(env).runMicros,id),
    env.DB.prepare(`INSERT OR IGNORE INTO ${operationTable(env)} (id,grant_id,kind,status,reserved_micros,created_at)
      SELECT ?,?,?,?, ?,? WHERE changes()=1`).bind(id,row.id,kind,kind==='inbound'?'settled':'pending',cost,now),
  ]);
  return changes(result[0]) && changes(result[1]) ? id : null;
}
export async function finishContinuation(env,kind,key,{ok=false,usage=null,diagnostic=null}={},now=Date.now()) {
  const id=opId(env,kind,key);
  const valid=ok && continuationReady(env,now) && await continuationCanProceed(env,now)
    && (kind!=='model' || (usage?.input_tokens<=limits(env).inputTokens && usage?.output_tokens<=limits(env).outputTokens
      && (solSession(env)?solUsageUpperMicros:lunaUsageUpperMicros)(usage)!==null
      && (solSession(env)?solUsageUpperMicros:lunaUsageUpperMicros)(usage)<=limits(env).modelMicros));
  // Never refund. Late success cannot revive an uncertain result or clear a stop.
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${operationTable(env)} SET status=?,outcome=?,input_tokens=?,output_tokens=?,finished_at=?
      WHERE id=? AND grant_id=? AND status='pending'`).bind(valid?'settled':'uncertain',valid?'valid':diagnosticOutcome(diagnostic),valid?usage?.input_tokens??null:null,
        valid?usage?.output_tokens??null:null,now,id,grantId(env)),
    env.DB.prepare(`UPDATE ${grantTable(env)} SET stopped_reason=COALESCE(stopped_reason,?),
      lock_id=CASE WHEN lock_id=? THEN NULL ELSE lock_id END WHERE id=? AND changes()=1`)
      .bind(valid?null:kind==='model' && continuationFailureNoticePolicy(env)?'model_uncertain':'provider_uncertain',id,grantId(env)),
  ]);
}


function diagnosticOutcome(value) {
  const categories=['http_error','response_size','response_json','response_envelope','refusal','proposal_json',
    'proposal_schema','usage_unverified','expired','input_token_count','input_limit','timeout','transport_failure'];
  if(!value || !categories.includes(value.category))return 'uncertain';
  const number=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max?v:null;
  // Fixed categories/numbers only. Never provider error text, responses, prompts,
  // headers, identifiers, credentials, customer text or hidden reasoning.
  return JSON.stringify({category:value.category,http_status:Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?value.httpStatus:null,
    elapsed_ms:number(value.elapsedMs,120000),counted_input_tokens:number(value.countedInput,1000000),output_tokens:number(value.outputTokens,100000),
    ...(value.category==='proposal_schema' && safeBookingRejection(value.proposalRejection)?{proposal_rejection:safeBookingRejection(value.proposalRejection)}:{})});
}
const noticeId=env=>opId(env,'outbound','failure-notice');
const noticeReply=key=>/^[a-f0-9]{64}:0$/.test(key || '');
// Opt-in future-grant policy only. One fixed notice may use ONE remaining send
// slot after a model-only stop. This never clears the stop or releases any hold.
export async function claimContinuationFailureNotice(env,replyId,now=Date.now()) {
  if(!continuationFailureNoticePolicy(env) || !noticeReply(replyId))return false;
  const grant=await active(env,now,true);if(!grant || grant.stopped_reason!=='model_uncertain')return false;
  const reply=await env.DB.prepare(`SELECT r.body,r.kind,r.state,c.phase,c.recipient,c.state_json FROM whatsapp_booking_replies r
    JOIN whatsapp_booking_conversations c ON c.id=r.conversation_id WHERE r.id=?`).bind(replyId).first();
  if(!reply || reply.kind!=='model_failure_notice' || reply.state!=='sending' || reply.phase!=='handoff'
    || reply.recipient!==env.TWILIO_RECIPIENT_ALLOWLIST)return false;
  let state;try{state=JSON.parse(reply.state_json);}catch{return false;}
  if(!state || state.continuation_id!==grant.id || !state.conversation_only || reply.body!==failureNoticeText(state.language,env))return false;
  const id=noticeId(env),modelId=opId(env,'model',replyId.slice(0,-2)),cost=COST.outbound;
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE ${grantTable(env)} SET outbound=outbound+1,spent_micros=spent_micros+?,lock_id=?
      WHERE id=? AND binding_hash=? AND history_hash=? AND stopped_reason='model_uncertain' AND lock_id IS NULL
      AND starts_at<=? AND expires_at>? AND outbound<? AND historical_micros+fee_cushion_micros+spent_micros+?<=?
      AND EXISTS(SELECT 1 FROM ${operationTable(env)} WHERE id=? AND kind='model' AND status='uncertain' AND finished_at BETWEEN ? AND ?)
      AND NOT EXISTS(SELECT 1 FROM ${operationTable(env)} WHERE id=?)`)
      .bind(cost,id,grant.id,grant.binding_hash,grant.history_hash,now,now,limits(env).outbound,cost,limits(env).runMicros,modelId,now-15000,now,id),
    env.DB.prepare(`INSERT OR IGNORE INTO ${operationTable(env)} (id,grant_id,kind,status,reserved_micros,outcome,created_at)
      SELECT ?,?,'outbound','pending',?,?,? WHERE changes()=1`).bind(id,grant.id,cost,'notice_sending:'+replyId,now),
  ]);
  return changes(result[0])===1 && changes(result[1])===1;
}
export async function continuationFailureNoticeCanSend(env,replyId,now=Date.now()) {
  if(!continuationFailureNoticePolicy(env) || !noticeReply(replyId))return false;
  const row=await active(env,now,true);if(!row || row.stopped_reason!=='model_uncertain' || row.lock_id!==noticeId(env))return false;
  const op=await env.DB.prepare(`SELECT status,outcome,created_at FROM ${operationTable(env)} WHERE id=?`).bind(noticeId(env)).first();
  return op?.status==='pending' && op.created_at<=now && now-op.created_at<15000 && op.outcome==='notice_sending:'+replyId;
}
export async function finishContinuationFailureNotice(env,replyId,ok,now=Date.now()) {
  if(!noticeReply(replyId))return;
  const valid=ok && await continuationFailureNoticeCanSend(env,replyId,now),id=noticeId(env);
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${operationTable(env)} SET status=?,outcome=?,finished_at=? WHERE id=? AND status='pending' AND outcome=?`)
      .bind(valid?'settled':'uncertain',valid?'notice_sent':'notice_uncertain',now,id,'notice_sending:'+replyId),
    env.DB.prepare(`UPDATE ${grantTable(env)} SET lock_id=NULL WHERE id=? AND lock_id=? AND changes()=1`).bind(grantId(env),id),
  ]);
}
