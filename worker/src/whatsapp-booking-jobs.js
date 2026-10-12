import { fullBookingSelected, fullBookingSpec, fullBookingCanProceed } from './whatsapp-full-booking.js';
import { admitDurableBookingEvent, processBookingEvent, sendBookingReplies, recoverDurableBookingLease, revokeDurableBookingJob } from './whatsapp-booking-store.js';
import { hasSensitiveBookingText } from './whatsapp-booking-model.js';
import { withBookingDeadline } from './whatsapp-booking-deadlines.js';

export const BOOKING_JOB_LIMITS = Object.freeze({ attempts:3, wakeups:3, leaseMs:5000, heartbeatMs:1000, maxPending:100, sweep:100 });
const active = row => row && ['pending','processing'].includes(row.state);
const terminal = row => row && !active(row);
const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0));
const aad = scope => encoder.encode(JSON.stringify([1,scope.eventKey,scope.conversationId,scope.grantId,scope.turnStartedAt,scope.deadlineAt]));
const scopeOf = job => ({eventKey:job.id,conversationId:job.conversation_id,grantId:job.grant_id,turnStartedAt:job.created_at,deadlineAt:job.deadline_at});
async function inboxKey(env, grantId) {
  if(typeof env.SESSION_SECRET!=='string' || !env.SESSION_SECRET)throw Error('inbox_key_unavailable');
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.SESSION_SECRET),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('edenmish-booking-inbox-v1'),info:encoder.encode(grantId)},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptBookingJob(env,event,scope) {
  const payload={id:event.id,phone:event.phone,at:event.at,echo:!!event.echo,
    text:typeof event.text==='string' && !hasSensitiveBookingText(event.text)?event.text:null,
    ...(event.unsupported==='location'?{unsupported:'location'}:{})};
  const raw=encoder.encode(JSON.stringify(payload));if(raw.length>8192)throw Error('inbox_payload_limit');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(scope)},await inboxKey(env,scope.grantId),raw);
  return JSON.stringify({v:1,iv:b64(iv),body:b64(new Uint8Array(cipher))});
}
export async function decryptBookingJob(env,job) {
  const envelope=JSON.parse(job.payload_cipher);
  if(!envelope || Object.keys(envelope).sort().join(',')!=='body,iv,v' || envelope.v!==1 || typeof envelope.body!=='string' || envelope.body.length>15000)throw Error('invalid_inbox');
  const iv=unb64(envelope.iv);if(iv.length!==12)throw Error('invalid_inbox');
  const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(scopeOf(job))},await inboxKey(env,job.grant_id),unb64(envelope.body));
  const event=JSON.parse(new TextDecoder().decode(raw));
  if(!event || Object.keys(event).some(key=>!['id','phone','at','echo','text','unsupported'].includes(key))
    || typeof event.id!=='string' || !/^[A-Za-z0-9._:=/-]{1,200}$/.test(event.id)
    || !/^\+972[1-9]\d{7,8}$/.test(event.phone||'') || event.at!==job.event_at || typeof event.echo!=='boolean'
    || event.text!==null && (typeof event.text!=='string'||event.text.length>2000||hasSensitiveBookingText(event.text))
    || event.unsupported!==undefined && event.unsupported!=='location')throw Error('invalid_inbox');
  return event;
}
export function durableBookingConfigured(env) {
  return fullBookingSelected(env) && env.WHATSAPP_BOOKING_DURABLE_READY==='on'
    && typeof env.WHATSAPP_BOOKING_QUEUE?.send==='function';
}
const readJob=(env,id)=>env.DB.prepare('SELECT * FROM whatsapp_booking_jobs WHERE id=?').bind(id).first();

// A publication is just a wake-up; the committed D1 row remains authoritative.
// Mark the bounded publication attempt before IO. Uncertain publication may be
// redelivered, but can never create a second model/send/order operation.
export async function publishBookingJob(env,id,clock=Date.now,{delaySeconds=0}={}) {
  if(!durableBookingConfigured(env))return false;
  const now=clock();
  if(!Number.isInteger(delaySeconds)||delaySeconds<0||delaySeconds>6)return false;
  const row=await env.DB.prepare(`UPDATE whatsapp_booking_jobs SET wakeups=wakeups+1,next_wakeup_at=?
    WHERE id=? AND state IN ('pending','processing') AND deadline_at>? AND wakeups<3 AND next_wakeup_at<=?
    RETURNING id,deadline_at`).bind(now+Math.max(1000,delaySeconds*1000),id,now+delaySeconds*1000,now).first();
  if(!row)return false;
  try {
    await withBookingDeadline(()=>env.WHATSAPP_BOOKING_QUEUE.send({version:1,id:row.id},{delaySeconds}),{timeoutMs:Math.max(0,Math.min(2000,row.deadline_at-clock())),clock});
    await env.DB.prepare('UPDATE whatsapp_booking_jobs SET published_at=? WHERE id=?').bind(clock(),row.id).run();
    return true;
  } catch { return false; }
}
export async function acceptDurableBookingEvent(env,event,now=Date.now()) {
  if(!durableBookingConfigured(env))return {status:503};
  const admitted=await admitDurableBookingEvent(env,event,now,{payloadCipher:scope=>encryptBookingJob(env,event,scope)});
  if(!admitted?.accepted)return {status:admitted?.backpressure?503:admitted?.disabled?503:500};
  const job=await readJob(env,admitted.eventKey);
  if(terminal(job))return {status:200,duplicate:!!admitted.duplicate};
  // A duplicate already queued/running needs no extra wake-up or reservation.
  if(admitted.duplicate && (job.state==='processing'||job.published_at!=null))return {status:200,duplicate:true};
  const published=await publishBookingJob(env,job.id);
  return {status:published?200:503,duplicate:!!admitted.duplicate};
}

async function ownsJob(env,job,clock=Date.now) {
  return !!await env.DB.prepare(`SELECT id FROM whatsapp_booking_jobs WHERE id=? AND state='processing' AND lease=? AND attempts=? AND lease_until>? AND deadline_at>?`).bind(job.id,job.lease,job.attempts,clock(),clock()).first();
}
async function heartbeat(env,job,clock=Date.now) {
  const now=clock();
  return !!await env.DB.prepare(`UPDATE whatsapp_booking_jobs SET lease_until=MIN(deadline_at,?) WHERE id=? AND state='processing' AND lease=? AND attempts=? AND lease_until>? AND deadline_at>? RETURNING id`).bind(now+BOOKING_JOB_LIMITS.leaseMs,job.id,job.lease,job.attempts,now,now).first();
}
async function finishJob(env,job,state,reason,clock=Date.now) {
  const now=clock();
  return !!await env.DB.prepare(`UPDATE whatsapp_booking_jobs SET state=?,reason=?,payload_cipher=NULL,finished_at=?
    WHERE id=? AND state='processing' AND lease=? AND attempts=? RETURNING id`).bind(state,reason,now,job.id,job.lease,job.attempts).first();
}
async function hasAttemptedProvider(env,job,{committed=false}={}) {
  // The event marker and draft/outbox were committed atomically. In that case
  // only already-attempted outbound segments are uncertain; no model replay.
  const kinds=committed?"kind='outbound'":"kind IN ('model','address','outbound')";
  const operation=await env.DB.prepare(`SELECT kind FROM whatsapp_full_booking_operations WHERE grant_id=? AND ${kinds}
    AND (operation_key=? OR substr(operation_key,1,65)=?) LIMIT 1`).bind(job.grant_id,job.id,job.id+':').first();
  if(operation)return true;
  if(committed)return false;
  const row=await env.DB.prepare('SELECT checkout_started_at FROM whatsapp_booking_conversations WHERE id=?').bind(job.conversation_id).first();
  return row?.checkout_started_at!=null;
}
async function pauseJob(env,job,state,reason,clock) {
  await revokeDurableBookingJob(env,job.id,{jobLease:job.lease,jobAttempt:job.attempts},clock());
  await finishJob(env,job,state,reason,clock);
}
// Return retry only for an unowned/busy pre-provider turn. Queue retries are
// wake-up retries; unique provider reservations forbid automatic billable replay.
export async function runBookingJob(env,id,services,{clock=Date.now,fetchImpl=globalThis.fetch}={}) {
  const prior=await readJob(env,id);if(!active(prior))return {done:true};
  const now=clock();
  if(prior.state==='processing' && prior.lease_until>now)return {retry:true,delaySeconds:Math.min(6,Math.ceil((prior.lease_until-now)/1000)+1)};
  const token=crypto.randomUUID();
  const job=await env.DB.prepare(`UPDATE whatsapp_booking_jobs SET state='processing',lease=?,lease_until=MIN(deadline_at,?),attempts=attempts+1
    WHERE id=? AND state IN ('pending','processing') AND attempts<3 AND next_attempt_at<=?
    AND (state='pending' OR lease_until<=?) RETURNING *`).bind(token,now+BOOKING_JOB_LIMITS.leaseMs,id,now,now).first();
  if(!job){
    if(prior.attempts>=3)await expireBookingJobs(env,clock);
    return {retry:true};
  }
  const options={jobId:job.id,jobLease:job.lease,jobAttempt:job.attempts};
  let running=false;const timer=setInterval(()=>{
    if(running)return;running=true;
    void heartbeat(env,job,clock).catch(()=>false).then(ok=>{if(!ok)clearInterval(timer);}).finally(()=>{running=false;});
  },BOOKING_JOB_LIMITS.heartbeatMs);
  try {
    const spec=fullBookingSpec(env);
    if(job.deadline_at<=clock()){await pauseJob(env,job,'expired','expired',clock);return {done:true};}
    if(!durableBookingConfigured(env)||job.grant_id!==spec?.grant_id||!await fullBookingCanProceed(env,clock)){
      await pauseJob(env,job,'uncertain','stopped',clock);return {done:true};
    }
    const committed=!!await env.DB.prepare('SELECT event_key FROM whatsapp_booking_events WHERE event_key=?').bind(id).first();
    const conversation=await env.DB.prepare('SELECT phase,checkout_started_at FROM whatsapp_booking_conversations WHERE id=?').bind(job.conversation_id).first();
    if(['handoff','closed'].includes(conversation?.phase) || (!committed && await hasAttemptedProvider(env,job))){
      await pauseJob(env,job,'uncertain','provider_uncertain',clock);return {done:true};
    }
    if(!await recoverDurableBookingLease(env,job.id,{...options,previousLease:prior.lease},clock())){
      const current=await readJob(env,id);
      if(terminal(current))return {done:true};
      // A prior different event still holds the conversation. Release only this
      // job's ownership; never steal that live lease or restart its deadline.
      await env.DB.prepare(`UPDATE whatsapp_booking_jobs SET state='pending',lease=NULL,lease_until=NULL,next_attempt_at=? WHERE id=? AND lease=? AND attempts=?`).bind(clock()+1000,id,job.lease,job.attempts).run();
      return {retry:true};
    }
    if(await hasAttemptedProvider(env,job,{committed})){
      // A completely recorded send is already handled, not an uncertain replay.
      const uncertain=committed?await env.DB.prepare(`SELECT r.id FROM whatsapp_booking_replies r WHERE substr(r.id,1,65)=? AND
        (r.state='sending' OR (r.state='pending' AND EXISTS(SELECT 1 FROM whatsapp_full_booking_operations o WHERE o.grant_id=? AND o.kind='outbound' AND o.operation_key=r.id))) LIMIT 1`).bind(id+':',job.grant_id).first():true;
      if(uncertain){await pauseJob(env,job,'uncertain','provider_uncertain',clock);return {done:true};}
    }
    if(!committed){
      let event;try{event=await decryptBookingJob(env,job);}catch{await pauseJob(env,job,'uncertain','invalid_payload',clock);return {done:true};}
      if(!await ownsJob(env,job,clock))return {retry:true};
      const result=await processBookingEvent(env,event,services,job.created_at,options);
      if(result.busy){
        await env.DB.prepare(`UPDATE whatsapp_booking_jobs SET state='pending',lease=NULL,lease_until=NULL,next_attempt_at=? WHERE id=? AND lease=? AND attempts=?`).bind(clock()+1000,id,job.lease,job.attempts).run();
        return {retry:true};
      }
      if(!await ownsJob(env,job,clock))return {done:terminal(await readJob(env,id)),retry:true};
      const saved=await env.DB.prepare('SELECT event_key FROM whatsapp_booking_events WHERE event_key=?').bind(id).first();
      if(!saved){await pauseJob(env,job,'uncertain','internal_failure',clock);return {done:true};}
    }
    if(!await ownsJob(env,job,clock))return {retry:true};
    await sendBookingReplies(env,fetchImpl,clock,options);
    if(!await ownsJob(env,job,clock))return {retry:true};
    const pending=await env.DB.prepare(`SELECT id FROM whatsapp_booking_replies WHERE substr(id,1,65)=? AND state IN ('pending','sending') LIMIT 1`).bind(id+':').first();
    if(pending){await pauseJob(env,job,'uncertain','provider_uncertain',clock);return {done:true};}
    await finishJob(env,job,'done','complete',clock);return {done:true};
  } catch {
    // No blind retry after an unexpected exception; a crash with no completion
    // is recovered separately under a new fenced lease and original deadline.
    try{await pauseJob(env,job,'uncertain','internal_failure',clock);}catch{}
    return {retry:true};
  } finally {clearInterval(timer);}
}

// Cleanup/recovery is bounded and safe even after flags are OFF/key is removed.
// It never decrypts or performs model/payment/send IO. A slow cron may find only
// expired work; it must hand off, never pretend the original30s window restarted.
export async function expireBookingJobs(env,clock=Date.now,{strict=false}={}) {
  if(!env.DB){if(strict)throw Error('booking_expiry_failed');return;}
  const now=clock();
  let rows;try { rows=await env.DB.prepare(`SELECT * FROM whatsapp_booking_jobs WHERE state IN ('pending','processing')
    AND (deadline_at<=? OR (attempts>=3 AND (state='pending' OR lease_until<=?)) OR grant_id IN (SELECT id FROM whatsapp_full_booking_grants WHERE stopped_reason IS NOT NULL)) LIMIT 100`).bind(now,now).all(); }catch{if(strict)throw Error('booking_expiry_failed');return;}
  let expired=0;
  for(const row of rows.results||[]){
    const lease=crypto.randomUUID();
    const claimed=await env.DB.prepare(`UPDATE whatsapp_booking_jobs SET state='processing',lease=?,lease_until=? WHERE id=? AND state IN ('pending','processing')
      AND (deadline_at<=? OR (attempts>=3 AND (state='pending' OR lease_until<=?)) OR grant_id IN (SELECT id FROM whatsapp_full_booking_grants WHERE stopped_reason IS NOT NULL)) RETURNING *`).bind(lease,now,row.id,now,now).first();
    if(claimed){await pauseJob(env,claimed,'expired',claimed.deadline_at<=now?'expired':'attempt_limit',clock);expired++;}
  }
  return expired;
}
export async function recoverBookingJobs(env,{clock=Date.now}={}) {
  if(!env.DB)return;
  await expireBookingJobs(env,clock);
  if(!durableBookingConfigured(env)||!await fullBookingCanProceed(env,clock))return;
  const now=clock();
  const jobs=await env.DB.prepare(`SELECT id FROM whatsapp_booking_jobs WHERE state IN ('pending','processing') AND deadline_at>? AND wakeups<3 AND next_wakeup_at<=?
    AND (state='pending' OR lease_until<=?) ORDER BY created_at LIMIT 100`).bind(now,now,now).all();
  for(const job of jobs.results||[])await publishBookingJob(env,job.id,clock);
}
export async function consumeBookingQueue(batch,env,services) {
  const spec=fullBookingSpec(env);
  if(!spec || batch.queue!==`edenmish-booking-full-${spec.environment}`)throw Error('booking_queue_identity');
  for(const message of batch.messages){
    const body=message.body;
    if(!body||Object.keys(body).sort().join(',')!=='id,version'||body.version!==1||!/^[a-f0-9]{64}$/.test(body.id||'')){message.ack();continue;}
    try{
      const result=await runBookingJob(env,body.id,services);
      if(result.done)message.ack();
      else if(Number(message.attempts)>=3){await publishBookingJob(env,body.id,Date.now,{delaySeconds:result.delaySeconds||1});message.ack();}
      else message.retry({delaySeconds:result.delaySeconds||1});
    }catch{if(Number(message.attempts)>=3)message.ack();else message.retry({delaySeconds:1});}
  }
}
