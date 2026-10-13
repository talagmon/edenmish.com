import { BOOKING_DEADLINES } from './whatsapp-booking-deadlines.js';
import { fullBookingSelected, fullBookingSpec, fullBookingReady, fullBookingCanProceed, reserveFullBookingOperation, finishFullBookingOperation } from './whatsapp-full-booking.js';
import { localCopy, multilingualConsent } from './whatsapp-booking-i18n.js';
import { selectBookingLanguage } from './whatsapp-booking-language.js';
import { continuationSelected, continuationCanProceed, finishContinuation, stopContinuation, continuationFailureNoticePolicy, failureNoticeText, claimContinuationFailureNotice, continuationFailureNoticeCanSend, finishContinuationFailureNotice } from './whatsapp-continuation.js';
import { lunaPilot } from './whatsapp-pilot-budget.js';
import { proposeBookingTurn } from './whatsapp-booking-model.js';
import { HANDOFF_EN, bookingSay } from './whatsapp-booking-copy.js';
import { sendTwilioBookingReply, reconcileTwilioBookingReceipts } from './whatsapp-booking-twilio.js';
import { advanceBooking, withBookingMenu, resetBookingSchedule, bookingEnabled, newBooking, isBookingHandoff, HANDOFF, SESSION_WINDOW } from './whatsapp-booking.js';
import { normalizeIlPhone } from './validate.js';
import { WHATSAPP_GRAPH_API_VERSION } from './whatsapp.js';
import { conversationOnlyPilot, reservePilotOperation, pilotComplete } from './whatsapp-booking-pilot.js';

const LOCK_TIMEOUT = 2 * 60 * 1000;
const changes = (result) => Number(result?.meta?.changes || 0);
// Twilio Body is bounded to 1,600 characters. Preserve all summary fields,
// splitting on lines with room for part labels; never truncate a payment URL.
export function splitBookingReply(text) {
  const chunks = []; let current = '';
  for (const line of String(text).split('\n')) {
    if (line.length > 1500) return null;
    if (current.length + line.length + 1 > 1500) { chunks.push(current); current = ''; }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks.map((part, index) => chunks.length === 1 ? part : `${index + 1}/${chunks.length}\n${part}`);
}
async function digest(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Full-profile ingress is metadata only. Admission precedes the conversation
// lease so a new correction can invalidate slow work without storing chat text.
async function admitFullEvent(DB, row, spec, event, eventKey, now) {
  await DB.prepare(`INSERT OR IGNORE INTO whatsapp_booking_full_fences
    (conversation_id,grant_id) VALUES (?,?)`).bind(row.id,spec.grant_id).run();
  const takeover=event.echo?'manual_takeover':isBookingHandoff(event.text||'')?'customer_takeover':null;
  await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO whatsapp_booking_full_ingress(event_key,conversation_id,event_at,created_at,deadline_at) VALUES(?,?,?,?,?)`).bind(eventKey,row.id,event.at,now,Math.min(now+BOOKING_DEADLINES.customerMs,spec.expires_at,event.at+SESSION_WINDOW)),
    DB.prepare(`UPDATE whatsapp_booking_full_fences SET epoch=epoch+1,
      latest_event_key=CASE WHEN ?>latest_event_at THEN ? ELSE latest_event_key END,
      stopped_at=CASE WHEN ? IS NOT NULL OR (?=latest_event_at AND latest_event_key IS NOT NULL AND latest_event_key!=?) THEN ? ELSE stopped_at END,
      stop_reason=CASE WHEN ? IS NOT NULL THEN ? WHEN ?=latest_event_at AND latest_event_key IS NOT NULL AND latest_event_key!=? THEN 'ambiguous_order' ELSE stop_reason END,
      latest_event_at=MAX(latest_event_at,?)
      WHERE conversation_id=? AND grant_id=? AND stop_reason IS NULL AND changes()=1
      AND (?>latest_event_at OR ? IS NOT NULL OR (?=latest_event_at AND latest_event_key!=?))`)
      .bind(event.at,eventKey,takeover,event.at,eventKey,now,takeover,takeover,event.at,eventKey,event.at,row.id,spec.grant_id,event.at,takeover,event.at,eventKey),
    DB.prepare(`UPDATE whatsapp_booking_replies SET state='cancelled',body=NULL WHERE conversation_id=? AND state='pending'
      AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences WHERE conversation_id=? AND grant_id=? AND (latest_event_key=? OR stop_reason IS NOT NULL))
      AND substr(id,1,65) != ?`).bind(row.id,row.id,spec.grant_id,eventKey,eventKey+':'),
    DB.prepare(`UPDATE whatsapp_booking_conversations SET phase='handoff',state_json=json_set(state_json,'$.phase','handoff') WHERE id=?
      AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences WHERE conversation_id=? AND stop_reason IS NOT NULL)`).bind(row.id,row.id),
  ]);
  return DB.prepare('SELECT * FROM whatsapp_booking_full_fences WHERE conversation_id=?').bind(row.id).first();
}
async function revokeFullConversation(DB,id,reason,now,expected=null) {
  // Revocation never releases the active lease or uncertain checkout tombstone.
  // A failed old task must not revoke a newer admitted correction between reads.
  const leaseGuard=expected?.lease!==undefined?` AND EXISTS(SELECT 1 FROM whatsapp_booking_conversations c WHERE c.id=conversation_id AND c.lock_id IS ?)`:'';
  const guard=expected?` AND grant_id=? AND epoch=? AND latest_event_key=?${leaseGuard}${jobCondition(expected.job)}`:'';
  const args=expected?[expected.grantId,expected.epoch,expected.eventKey,...(expected.lease!==undefined?[expected.lease]:[]),...jobArguments(expected.job)]:[];
  await DB.batch([
    DB.prepare(`UPDATE whatsapp_booking_full_fences SET epoch=epoch+1,stopped_at=?,stop_reason=? WHERE conversation_id=? AND stop_reason IS NULL${guard}`).bind(now,reason,id,...args),
    DB.prepare(`UPDATE whatsapp_booking_conversations SET phase='handoff',state_json=json_set(state_json,'$.phase','handoff') WHERE id=? AND changes()=1`).bind(id),
    DB.prepare(`UPDATE whatsapp_booking_replies SET state='cancelled',body=NULL WHERE conversation_id=? AND state='pending' AND changes()=1`).bind(id),
    DB.prepare(`UPDATE whatsapp_booking_jobs SET state='uncertain',payload_cipher=NULL,finished_at=?,reason='stopped'
      WHERE conversation_id=? AND state IN ('pending','processing') AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences WHERE conversation_id=? AND stop_reason IS NOT NULL)`).bind(now,id,id),
  ]);
}
async function fullLeaseCurrent(DB,id,lease,grantId,epoch,eventKey,{sending=false}={}) {
  const row=await DB.prepare(`SELECT c.phase,c.lock_id,c.checkout_started_at,f.grant_id,f.epoch,f.latest_event_key,f.stop_reason
    FROM whatsapp_booking_conversations c JOIN whatsapp_booking_full_fences f ON f.conversation_id=c.id WHERE c.id=?`).bind(id).first();
  return !!row && row.lock_id===lease && row.grant_id===grantId && row.epoch===epoch
    && row.latest_event_key===eventKey && !row.stop_reason && !['handoff','closed'].includes(row.phase)
    && (!sending || row.phase!=='creating');
}

const durableOptions = options => options?.jobId ? options : null;
const jobCondition = job => job ? ` AND EXISTS(SELECT 1 FROM whatsapp_booking_jobs j WHERE j.id=? AND j.state='processing' AND j.lease=? AND j.attempts=?)` : '';
const jobArguments = job => job ? [job.jobId,job.jobLease,job.jobAttempt] : [];
async function jobCurrent(DB,job,clock=Date.now) {
  if(!job)return true;
  const row=await DB.prepare("SELECT deadline_at,lease_until FROM whatsapp_booking_jobs WHERE id=? AND state='processing' AND lease=? AND attempts=?").bind(...jobArguments(job)).first();
  const now=clock();return !!row && now<row.deadline_at && now<row.lease_until;
}

// Recovery must claim/fence the durable job before touching a crashed owner.
export async function recoverDurableBookingLease(env,jobId,{jobLease,jobAttempt,previousLease}={},now=Date.now()) {
  const DB=env.DB,job={jobId,jobLease,jobAttempt};
  if(!fullBookingSelected(env)||!await jobCurrent(DB,job,Date.now))return false;
  const prior=typeof previousLease==='string'?previousLease:null;
  const releasable=`(c.lock_id IS NULL OR c.lock_id=? OR EXISTS(SELECT 1 FROM whatsapp_booking_jobs old WHERE old.conversation_id=c.id AND old.id!=? AND old.lease=c.lock_id AND old.state IN ('done','uncertain','expired','superseded')))`;
  const result=await DB.batch([
    DB.prepare(`UPDATE whatsapp_booking_full_fences SET epoch=epoch+1 WHERE latest_event_key=? AND stop_reason IS NULL
      ${jobCondition(job)} AND EXISTS(SELECT 1 FROM whatsapp_booking_jobs j JOIN whatsapp_booking_conversations c ON c.id=j.conversation_id
        WHERE j.id=? AND j.conversation_id=whatsapp_booking_full_fences.conversation_id AND (c.checkout_started_at IS NULL OR EXISTS(SELECT 1 FROM whatsapp_booking_events committed WHERE committed.event_key=j.id AND committed.conversation_id=c.id)) AND ${releasable})`).bind(jobId,...jobArguments(job),jobId,prior,jobId),
    DB.prepare(`UPDATE whatsapp_booking_conversations SET lock_id=NULL,lock_at=NULL WHERE id=(SELECT conversation_id FROM whatsapp_booking_jobs WHERE id=?)
      AND changes()=1`).bind(jobId),
  ]);
  return !!changes(result[0]);
}
export async function revokeDurableBookingJob(env,jobId,{jobLease,jobAttempt}={},now=Date.now()) {
  const DB=env.DB,job={jobId,jobLease,jobAttempt};
  const result=await DB.batch([
    DB.prepare(`UPDATE whatsapp_booking_full_fences SET epoch=epoch+1,stopped_at=?,stop_reason='provider_failure'
      WHERE latest_event_key=? AND stop_reason IS NULL ${jobCondition(job)}`).bind(now,jobId,...jobArguments(job)),
    DB.prepare(`UPDATE whatsapp_booking_conversations SET phase='handoff',state_json=json_set(state_json,'$.phase','handoff')
      WHERE id=(SELECT conversation_id FROM whatsapp_booking_jobs WHERE id=?) AND changes()=1`).bind(jobId),
    DB.prepare(`UPDATE whatsapp_booking_replies SET state='cancelled',body=NULL WHERE conversation_id=(SELECT conversation_id FROM whatsapp_booking_jobs WHERE id=?) AND state='pending' AND changes()=1`).bind(jobId),
  ]);
  return !!changes(result[0]);
}

// Admission commits its hold, revision fence and encrypted recovery work together.
// The pending nonce exists only inside this transaction and identifies its winner.
export async function admitDurableBookingEvent(env,event,now=Date.now(),{payloadCipher}={}) {
  const spec=fullBookingSpec(env),DB=env.DB;
  if(!spec || !bookingEnabled(env,now) || !await fullBookingCanProceed(env,Date.now))return {accepted:false};
  const eventKey=await digest(env.SESSION_SECRET,'wa-event:'+env.WHATSAPP_BOOKING_PROVIDER+':'+event.id);
  const existing=await DB.prepare('SELECT id,conversation_id,deadline_at FROM whatsapp_booking_jobs WHERE id=?').bind(eventKey).first();
  if(existing)return {accepted:true,duplicate:true,eventKey,conversationId:existing.conversation_id,deadlineAt:existing.deadline_at};
  const senderKey=await digest(env.SESSION_SECRET,'wa-sender:'+env.WHATSAPP_BOOKING_PROVIDER+':'+event.phone+':full');
  const initial={...newBooking(),full_grant_id:spec.grant_id};
  await DB.prepare(`INSERT OR IGNORE INTO whatsapp_booking_conversations
    (id,sender_key,recipient,state_json,phase,order_token,created_at,updated_at,provider) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(),senderKey,event.phone,JSON.stringify(initial),initial.phase,crypto.randomUUID().replace(/-/g,'').slice(0,22),now,now,env.WHATSAPP_BOOKING_PROVIDER).run();
  const row=await DB.prepare('SELECT * FROM whatsapp_booking_conversations WHERE sender_key=?').bind(senderKey).first();
  const deadlineAt=Math.min(now+BOOKING_DEADLINES.customerMs,spec.expires_at,event.at+SESSION_WINDOW);
  const scope={eventKey,conversationId:row.id,grantId:spec.grant_id,turnStartedAt:now,deadlineAt};
  const takeover=event.echo?'manual_takeover':isBookingHandoff(event.text||'')?'customer_takeover':null;
  const previousFence=await DB.prepare('SELECT * FROM whatsapp_booking_full_fences WHERE conversation_id=?').bind(row.id).first();
  const failAdmission=async()=>{
    if(takeover)await revokeFullConversation(DB,row.id,takeover,Date.now());
    else if(previousFence)await revokeFullConversation(DB,row.id,'provider_failure',Date.now(),{grantId:previousFence.grant_id,epoch:previousFence.epoch,eventKey:previousFence.latest_event_key});
  };
  let cipher;
  try { cipher=typeof payloadCipher==='function'?await payloadCipher(scope):payloadCipher; } catch {}
  if(typeof cipher!=='string'||!cipher||cipher.length>16000||Date.now()>=deadlineAt){
    await failAdmission();return {accepted:false};
  }
  const nonce=crypto.randomUUID();
  const owns=`EXISTS(SELECT 1 FROM whatsapp_booking_jobs WHERE id=? AND state='pending' AND lease=?)`;
  try {
    await DB.batch([
      DB.prepare(`INSERT INTO whatsapp_booking_jobs(id,grant_id,conversation_id,event_at,created_at,deadline_at,payload_cipher,state,attempts,lease,lease_until,next_attempt_at)
        SELECT ?,?,?,?,?,?,?,'pending',0,?,0,? WHERE NOT EXISTS(SELECT 1 FROM whatsapp_booking_jobs WHERE id=?)
        AND (SELECT COUNT(*) FROM whatsapp_booking_jobs WHERE state IN ('pending','processing'))<100`)
        .bind(eventKey,spec.grant_id,row.id,event.at,now,deadlineAt,cipher,nonce,now,eventKey),
      DB.prepare(`INSERT INTO whatsapp_full_booking_operations(grant_id,kind,operation_key,reserved_micros,status,created_at)
        SELECT ?,'inbound',?,10300,'pending',? WHERE ${owns} AND NOT EXISTS(SELECT 1 FROM whatsapp_full_booking_operations WHERE grant_id=? AND kind='inbound' AND operation_key=?)`)
        .bind(spec.grant_id,eventKey,Date.now(),eventKey,nonce,spec.grant_id,eventKey),
      DB.prepare(`UPDATE whatsapp_full_booking_operations SET status='settled',diagnostics_json='{}',finished_at=?
        WHERE grant_id=? AND kind='inbound' AND operation_key=? AND status='pending' AND ${owns}`).bind(Date.now(),spec.grant_id,eventKey,eventKey,nonce),
      DB.prepare(`INSERT OR IGNORE INTO whatsapp_booking_full_fences(conversation_id,grant_id) SELECT ?,? WHERE ${owns}`).bind(row.id,spec.grant_id,eventKey,nonce),
      DB.prepare(`INSERT OR IGNORE INTO whatsapp_booking_full_ingress(event_key,conversation_id,event_at,created_at,deadline_at) SELECT ?,?,?,?,? WHERE ${owns}`).bind(eventKey,row.id,event.at,now,deadlineAt,eventKey,nonce),
      DB.prepare(`UPDATE whatsapp_booking_full_fences SET epoch=epoch+1,
        latest_event_key=CASE WHEN ?>latest_event_at THEN ? ELSE latest_event_key END,
        stopped_at=CASE WHEN ? IS NOT NULL OR (?=latest_event_at AND latest_event_key IS NOT NULL AND latest_event_key!=?) THEN ? ELSE stopped_at END,
        stop_reason=CASE WHEN ? IS NOT NULL THEN ? WHEN ?=latest_event_at AND latest_event_key IS NOT NULL AND latest_event_key!=? THEN 'ambiguous_order' ELSE stop_reason END,
        latest_event_at=MAX(latest_event_at,?) WHERE conversation_id=? AND grant_id=? AND stop_reason IS NULL AND ${owns}
        AND (?>latest_event_at OR ? IS NOT NULL OR (?=latest_event_at AND latest_event_key!=?))`)
        .bind(event.at,eventKey,takeover,event.at,eventKey,now,takeover,takeover,event.at,eventKey,event.at,row.id,spec.grant_id,eventKey,nonce,event.at,takeover,event.at,eventKey),
      DB.prepare(`UPDATE whatsapp_booking_replies SET state='cancelled',body=NULL WHERE conversation_id=? AND state='pending' AND substr(id,1,65)!=?
        AND ${owns} AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences WHERE conversation_id=? AND (latest_event_key=? OR stop_reason IS NOT NULL))`).bind(row.id,eventKey+':',eventKey,nonce,row.id,eventKey),
      DB.prepare(`UPDATE whatsapp_booking_jobs SET state='superseded',payload_cipher=NULL,finished_at=?,reason='superseded'
        WHERE conversation_id=? AND id!=? AND state IN ('pending','processing') AND ${owns}
        AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences WHERE conversation_id=? AND (latest_event_key=? OR stop_reason IS NOT NULL))`).bind(now,row.id,eventKey,eventKey,nonce,row.id,eventKey),
      DB.prepare(`UPDATE whatsapp_booking_conversations SET phase='handoff',state_json=json_set(state_json,'$.phase','handoff') WHERE id=? AND ${owns}
        AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences WHERE conversation_id=? AND stop_reason IS NOT NULL)`).bind(row.id,eventKey,nonce,row.id),
      DB.prepare(`UPDATE whatsapp_booking_jobs SET state='superseded',payload_cipher=NULL,finished_at=?,reason='superseded'
        WHERE id=? AND lease=? AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences WHERE conversation_id=? AND (grant_id!=? OR latest_event_key!=? OR stop_reason IS NOT NULL))`).bind(now,eventKey,nonce,row.id,spec.grant_id,eventKey),
      DB.prepare('UPDATE whatsapp_booking_jobs SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?').bind(eventKey,nonce),
    ]);
  } catch {
    // Failed admission cannot leave older work running through a lost correction.
    await failAdmission();
    return {accepted:false};
  }
  const saved=await DB.prepare('SELECT id,conversation_id,deadline_at FROM whatsapp_booking_jobs WHERE id=?').bind(eventKey).first();
  if(!saved){await failAdmission();return {accepted:false,backpressure:true};}
  return {accepted:true,eventKey,conversationId:saved.conversation_id,deadlineAt:saved.deadline_at};
}

// Only messages from the configured business number's signed webhook envelope.
// History sync and unsupported content (including location/media) are never stored.
export function extractBookingEvents(payload, phoneId, now = Date.now()) {
  const events = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
    const value = change.value;
    if (String(value?.metadata?.phone_number_id || '') !== String(phoneId)) continue;
    const echo = change.field === 'smb_message_echoes';
    if (!echo && change.field !== 'messages') continue;
    const messages = value.messages || value.message_echoes;
    for (const m of Array.isArray(messages) ? messages : []) {
      const phone = normalizeIlPhone(echo ? m.to : m.from);
      const at = Number(m.timestamp) * 1000;
      if (!phone || !/^[A-Za-z0-9._:=/-]{1,200}$/.test(String(m.id || '')) || !Number.isSafeInteger(at) || at <= now - SESSION_WINDOW || at > now + 60_000) continue;
      const text = m.type === 'text' ? m.text?.body : m.type === 'interactive' ? (m.interactive?.button_reply?.id || m.interactive?.list_reply?.id) : null;
      events.push({ id: m.id, phone, at, echo, text: typeof text === 'string' && text.length <= 2000 ? text : null, ...(m.type==='location'?{unsupported:'location'}:{}) });
    }
  }
  return events.sort((a, b) => a.at - b.at || Number(b.echo) - Number(a.echo));
}

export async function processBookingEvent(env, event, services, now = Date.now(), options = {}) {
  if (!bookingEnabled(env, now)) return { disabled: true };
  const DB = env.DB;
  const full=fullBookingSelected(env),spec=full?fullBookingSpec(env):null;
  const job=full?durableOptions(options):null;
  if(full && (!spec || !await fullBookingCanProceed(env,Date.now)))return {disabled:true};
  const pilotScope = lunaPilot(env) ? ':' + (continuationSelected(env) ? env.WHATSAPP_BOOKING_CONTINUATION_ID : env.WHATSAPP_BOOKING_PILOT_ID) : '';
  const fullScope=full?':full':'';
  const senderKey = await digest(env.SESSION_SECRET, 'wa-sender:' + env.WHATSAPP_BOOKING_PROVIDER + ':' + event.phone + pilotScope + fullScope);
  const eventKey = await digest(env.SESSION_SECRET, 'wa-event:' + env.WHATSAPP_BOOKING_PROVIDER + ':' + event.id);
  if(job){
    if(job.jobId!==eventKey || !await jobCurrent(DB,job,Date.now))return {disabled:true};
    const record=await DB.prepare('SELECT grant_id,event_at,created_at FROM whatsapp_booking_jobs WHERE id=?').bind(eventKey).first();
    if(record?.grant_id!==spec.grant_id || record.event_at!==event.at)return {disabled:true};
    now=record.created_at;
  }
  if (await DB.prepare('SELECT event_key FROM whatsapp_booking_events WHERE event_key = ?').bind(eventKey).first()) return { duplicate: true };
  if (continuationSelected(env) && !await continuationCanProceed(env,now)) return { disabled:true };
  if (!full && services.conversationModelForEvent) services = { ...services, conversationModel: services.conversationModelForEvent(eventKey) };
  const initial = newBooking();
  if(full)initial.full_grant_id=spec.grant_id;
  if (lunaPilot(env)) initial.pilot_id = env.WHATSAPP_BOOKING_PILOT_ID;
  if (continuationSelected(env)) initial.continuation_id = env.WHATSAPP_BOOKING_CONTINUATION_ID;
  await DB.prepare(`INSERT OR IGNORE INTO whatsapp_booking_conversations
    (id, sender_key, recipient, state_json, phase, order_token, created_at, updated_at, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), senderKey, event.phone, JSON.stringify(initial), initial.phase, crypto.randomUUID().replace(/-/g, '').slice(0, 22), now, now, env.WHATSAPP_BOOKING_PROVIDER).run();
  let row = await DB.prepare('SELECT * FROM whatsapp_booking_conversations WHERE sender_key = ?').bind(senderKey).first();
  let fence=null,turnStartedAt=null,deadlineAt=null;
  if(full){
    // Count each unique admitted inbound once, including busy/stale/takeover
    // arrivals. A reservation with no durable ingress is uncertain, never retried.
    const admitted=await DB.prepare('SELECT event_key FROM whatsapp_booking_full_ingress WHERE event_key=?').bind(eventKey).first();
    if(job && !admitted)return {disabled:true};
    if(!admitted){
      if(!await reserveFullBookingOperation(env,'inbound',eventKey,Date.now)){
        // A concurrent duplicate reservation is not a new correction. A true
        // quota denial must nevertheless suppress the older active work.
        const prior=await DB.prepare(`SELECT status FROM whatsapp_full_booking_operations WHERE grant_id=? AND kind='inbound' AND operation_key=?`).bind(spec.grant_id,eventKey).first();
        if(prior)return {busy:true};
        await revokeFullConversation(DB,row.id,event.echo?'manual_takeover':isBookingHandoff(event.text||'')?'customer_takeover':'provider_failure',Date.now());
        return {disabled:true};
      }
      if(!await finishFullBookingOperation(env,'inbound',eventKey,true,{},Date.now)){
        await revokeFullConversation(DB,row.id,'provider_failure',Date.now());return {disabled:true};
      }
    }
    try {
      fence=job?await DB.prepare('SELECT * FROM whatsapp_booking_full_fences WHERE conversation_id=?').bind(row.id).first():await admitFullEvent(DB,row,spec,event,eventKey,now);
    } catch {
      // The inbound hold is retained even when durable admission is uncertain.
      // Do not let older work survive a correction that we failed to admit.
      await revokeFullConversation(DB,row.id,'provider_failure',Date.now());
      return {disabled:true};
    }
    if(!fence || fence.grant_id!==spec.grant_id || fence.stop_reason)return {processed:true,phase:'handoff'};
    if(fence.latest_event_key!==eventKey)return {processed:true,stale:true};
    const ingress=await DB.prepare('SELECT created_at,deadline_at FROM whatsapp_booking_full_ingress WHERE event_key=? AND conversation_id=?').bind(eventKey,row.id).first();
    // Read back the immutable first receipt; a webhook retry cannot restart it.
    turnStartedAt=ingress?.created_at;deadlineAt=ingress?.deadline_at;
    if(!Number.isSafeInteger(turnStartedAt)||!Number.isSafeInteger(deadlineAt)){
      await revokeFullConversation(DB,row.id,'provider_failure',Date.now());return {disabled:true};
    }
  }
  // A crashed lease is never replayed through checkout. An operator must reconcile
  // the reserved order token, including a provider-accepted but unpersisted charge.
  if (row.lock_id && row.lock_at < now - LOCK_TIMEOUT) {
    await DB.batch([
      DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = ?, lock_id = NULL, lock_at = NULL WHERE id = ? AND lock_id = ?`).bind(JSON.stringify({ ...JSON.parse(row.state_json), phase: 'handoff' }), row.id, row.lock_id),
      DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'cancelled', body = NULL WHERE conversation_id = ? AND state IN ('pending', 'sending')`).bind(row.id),
    ]);
  }
  const lease = job?.jobLease || crypto.randomUUID();
  if (!changes(await DB.prepare(`UPDATE whatsapp_booking_conversations SET lock_id = ?, lock_at = ? WHERE id = ? AND lock_id IS NULL${jobCondition(job)}`).bind(lease, now, row.id,...jobArguments(job)).run())) return { busy: true };
  row = await DB.prepare('SELECT * FROM whatsapp_booking_conversations WHERE id = ?').bind(row.id).first();
  const fenceSql=full?` AND EXISTS(SELECT 1 FROM whatsapp_booking_full_fences f WHERE f.conversation_id=whatsapp_booking_conversations.id AND f.grant_id=? AND f.epoch=? AND f.latest_event_key=? AND f.stop_reason IS NULL)${jobCondition(job)}`:'';
  const fenceArgs=full?[spec.grant_id,fence.epoch,eventKey,...jobArguments(job)]:[];
  const expectedFence=full?{grantId:spec.grant_id,epoch:fence.epoch,eventKey,lease,job}:null;
  const leaseCurrent=()=>fullLeaseCurrent(DB,row.id,lease,spec.grant_id,fence.epoch,eventKey);
  const canProceed=async()=>!full || (Date.now()<deadlineAt && await jobCurrent(DB,job,Date.now) && await fullBookingCanProceed(env,Date.now) && await leaseCurrent() && fullBookingReady(env,Date.now()) && await jobCurrent(DB,job,Date.now) && Date.now()<deadlineAt);
  try {
    if(full){
      if(!await canProceed())return {processed:true,superseded:true};
      if(services.forEvent)services={...services,...await services.forEvent(eventKey,{conversationId:row.id,lease,canProceed,turnStartedAt,deadlineAt})};
    }
    // Check again after acquiring the conversation lease.
    if (await DB.prepare('SELECT event_key FROM whatsapp_booking_events WHERE event_key = ?').bind(eventKey).first()) return { duplicate: true };
    if (env.WHATSAPP_BOOKING_PROVIDER === 'twilio') {
      await reconcileTwilioBookingReceipts(env, null, { id: row.id, token: lease });
      row = await DB.prepare('SELECT * FROM whatsapp_booking_conversations WHERE id = ?').bind(row.id).first();
    }
    let state = JSON.parse(row.state_json);
    if (conversationOnlyPilot(env)) state.conversation_only = true;
    if(services.multilingual){state.multilingual=true;if(event.text)selectBookingLanguage(state,event.text);}
    let reply = null;
    let outcome = 'processed';
    let orderId = row.order_id;
    const continuationInbound = !continuationSelected(env) || event.echo || await reservePilotOperation(env,'inbound',now,eventKey);
    // A manual reply is a takeover even if delivered late. Never resume from chat.
    if (!continuationInbound) {
      state.phase='handoff'; outcome='pilot_limit';
    } else if (event.echo) {
      state.phase = 'handoff'; outcome = 'manual_takeover';
    } else if (state.phase === 'handoff') {
      outcome = 'paused';
    } else if (isBookingHandoff(event.text || '')) {
      state.phase = 'handoff'; reply = bookingSay(state,HANDOFF,HANDOFF_EN); outcome = 'customer_takeover';
    } else if (event.at < row.last_event_at) {
      outcome = 'stale';
      // Late field changes remain ignored. A distinct late message asking for
      // a person must still pause; only that intent is actionable here.
      const proposal = await proposeBookingTurn(services.conversationModel, state, event.text || '', now);
      if (proposal?.intent === 'handoff') {
        state.phase = 'handoff'; reply = bookingSay(state,HANDOFF,HANDOFF_EN); outcome = 'customer_takeover';
      }
    } else if (event.at === row.last_event_at && row.last_event_at > 0) {
      state.phase = 'handoff'; reply = bookingSay(state,HANDOFF,HANDOFF_EN); outcome = 'ambiguous_order';
    } else if (!full && !continuationSelected(env) && !await reservePilotOperation(env, 'inbound', now)) {
      state.phase = 'handoff'; outcome = 'pilot_limit';
    } else {
      const count = await DB.prepare('SELECT COUNT(*) AS n FROM whatsapp_booking_events WHERE conversation_id = ? AND created_at > ?').bind(row.id, now - SESSION_WINDOW).first();
      if (Number(count?.n) >= 100 || now - row.created_at > 2 * SESSION_WINDOW) {
        state.phase = 'handoff'; reply = bookingSay(state,HANDOFF,HANDOFF_EN); outcome = 'limit';
      } else {
        let text=event.text;
        if(event.audio && !text) {
          if(full){
            reply=bookingSay(state,'הודעות קוליות אינן זמינות כאן כרגע. כתבו את הפרטים או בקשו נציג.','Voice messages are unavailable here. Please type the details or ask for a person.');
          }else if(!state.audio_consent_at || !['collect','address_review','review','address_choice'].includes(state.phase)) {
            reply=bookingSay(state,'כדי לשלוח הודעות קוליות, יש להסכים קודם בתפריט הטקסט. ההקלטה תישלח ל-OpenAI לתמלול.','For voice messages, first agree using the text menu. Audio will be sent to OpenAI for transcription.');
            if(state.phase!=='consent'){state.audio_consent_pending=true;reply+='\n'+bookingSay(state,'1. מסכימ/ה לתמלול ההקלטות','1. I agree to audio transcription');}
            if(state.phase==='consent'){state.audio_disclosure_shown=true;reply=withBookingMenu({state,reply:multilingualConsent(state.language)+'\n'+reply},now).reply;}
          } else {
            const transcription=services.transcribeAudio ? await services.transcribeAudio(event,eventKey) : null;
            text=transcription?.text;
            if(!text){outcome='voice_failed';reply=bookingSay(state,'עיבוד הודעות קוליות אינו זמין בבדיקה הזו. כתבו את ההודעה או בקשו נציג.','Voice processing is unavailable for this test. Please type your message or ask for a person.');}
          }
        }
        if(!text && !reply)reply=event.unsupported==='location'
          ? bookingSay(state,'אין כרגע תמיכה בסיכת מיקום. כתבו רחוב, מספר בית ועיר, או בקשו נציג.','Location pins are not supported. Type the street, house number and city, or ask for a person.')
          : env.WHATSAPP_BOOKING_VOICE_ENABLED==='on'
            ? bookingSay(state,'שלחו הודעה קולית OGG/Opus, קובץ MP3 או WAV, או כתבו הודעת טקסט.','Please send a supported voice note (OGG/Opus), MP3 or WAV file, or type your message.')
            : bookingSay(state,'כתבו את ההודעה בטקסט, או בקשו נציג.','Please type your message, or ask for a person.');
        if(text) {
        const result = await advanceBooking(state, text, {
          ...services,
          order: () => services.order(row.order_token),
        }, { phone: event.phone, now, conversationOnly: conversationOnlyPilot(env), inputKind:event.audio?'voice':'text' });
        if(full && !await leaseCurrent())return {processed:true,superseded:true};
        if(full && (result.interpretation==='model_fallback' || !await canProceed() || result.state.phase==='handoff')){
          await revokeFullConversation(DB,row.id,result.interpretation==='model_fallback'?'model_failure':Date.now()>=deadlineAt?'provider_failure':'customer_takeover',Date.now(),expectedFence);
          return {processed:true,phase:'handoff'};
        }
        state = result.state; reply = result.reply;
        if (['model_proposal', 'model_fallback'].includes(result.interpretation)) outcome = result.interpretation;
        if (lunaPilot(env) && result.interpretation === 'model_fallback') {
          state.phase = 'handoff'; reply = continuationSelected(env) && continuationFailureNoticePolicy(env) ? failureNoticeText(state.language,env) : bookingSay(state,HANDOFF,HANDOFF_EN);
        }
        if (result.create && (conversationOnlyPilot(env) || state.conversation_only)) {
          state.phase = 'handoff'; reply = pilotComplete(state.language); outcome = 'pilot_complete';
        } else if (result.create) {
          if (env.WHATSAPP_BOOKING_PROVIDER === 'twilio') await reconcileTwilioBookingReceipts(env, null, { id: row.id, token: lease });
          const active = await DB.prepare('SELECT phase FROM whatsapp_booking_conversations WHERE id = ? AND lock_id = ?').bind(row.id, lease).first();
          if (!active || active.phase === 'handoff' || (full && !await canProceed())) return { processed: true, phase: 'handoff' };
          // Durable intent precedes the only side-effecting canonical order call.
          const intent = await DB.prepare(`UPDATE whatsapp_booking_conversations SET state_json = ?, phase = 'creating', checkout_started_at = ?, updated_at = ? WHERE id = ? AND lock_id = ?${fenceSql}`).bind(JSON.stringify(state), now, now, row.id, lease,...fenceArgs).run();
          if (!changes(intent)) return { processed: true, phase: 'handoff' };
          let resultOrder;
          try {
            resultOrder = await services.create(result.create, { token: row.order_token, conversationId: row.id, ...(full?{canProceed}:{}) });
          } catch {
            // Do not retry an ambiguous payment boundary, even with a new event ID.
            resultOrder = { error: 'checkout_ambiguous' };
          }
          const canonical = await services.order(row.order_token);
          if(full && !await leaseCurrent())return {processed:true,superseded:true};
          orderId = canonical?.id || resultOrder.order_id || null;
          if (resultOrder.error === 'whatsapp_schedule_changed' && !canonical) {
            // The canonical route guarantees this rejection precedes all order
            // and checkout effects, so choosing and confirming a new time is safe.
            await DB.prepare(`UPDATE whatsapp_booking_conversations SET checkout_started_at = NULL WHERE id = ? AND lock_id = ?${jobCondition(job)}`).bind(row.id, lease,...jobArguments(job)).run();
            reply = withBookingMenu(resetBookingSchedule(state), Date.now()).reply;
          } else if (resultOrder.error === 'whatsapp_quote_changed' && !canonical) {
            await DB.prepare(`UPDATE whatsapp_booking_conversations SET checkout_started_at = NULL WHERE id = ? AND lock_id = ?${jobCondition(job)}`).bind(row.id, lease,...jobArguments(job)).run();
            state.phase = 'collect'; state.quote = null; delete state.terms_accepted_at;
            // Preserve the data; an explicit address review triggers a fresh quote.
            state.phase = 'address_review'; state.revision++;
            reply = withBookingMenu({ state, reply: bookingSay(state,'המחיר השתנה לפני יצירת ההזמנה. לא נוצר חיוב. אשרו שוב את הכתובות לקבלת הצעה חדשה.','The price changed before order creation. No charge was created. Confirm the addresses again to get a fresh quote.') }, now).reply;
          } else if (!resultOrder.error && canonical?.payment_status === 'link_sent' && canonical.payment_url) {
            state.phase = 'booked';
            reply = state.language && state.language !== 'he' ? `${localCopy(state.language,'Your order is awaiting payment through this secure link:')}\n${canonical.payment_url}\n${localCopy(state.language,'Tracking details will be sent by email after payment verification; never send card details in chat.')}` : `ההזמנה נוצרה וממתינה לתשלום. תשלום רק בקישור המאובטח:\n${canonical.payment_url}\nפרטי המעקב יישלחו באימייל לאחר אימות התשלום. אין לשלוח פרטי כרטיס בצ׳אט.`;
          } else {
            state.phase = 'handoff'; reply = bookingSay(state,HANDOFF,HANDOFF_EN); outcome = 'checkout_requires_review';
          }
        }
      }
    }
    }
    if(full && !await canProceed())return {processed:true,superseded:true};
    let parts = reply ? splitBookingReply(reply) : [];
    if (!parts) { state.phase = 'handoff'; parts = [bookingSay(state,HANDOFF,HANDOFF_EN)]; }
    const statements = [
      DB.prepare(`UPDATE whatsapp_booking_conversations SET state_json = ?, phase = ?, order_id = ?, last_event_at = MAX(last_event_at, ?), last_customer_at = MAX(last_customer_at, ?), consent_at = COALESCE(consent_at, ?), confirmed_at = COALESCE(confirmed_at, ?), confirmed_revision = COALESCE(confirmed_revision, ?), confirmed_price = COALESCE(confirmed_price, ?), updated_at = ? WHERE id = ? AND lock_id = ?${fenceSql}`).bind(JSON.stringify(state), state.phase, orderId, event.at, event.echo ? 0 : event.at, state.consent_at || null, orderId ? state.terms_accepted_at || null : null, orderId && state.terms_accepted_at ? state.revision : null, orderId && state.terms_accepted_at ? state.quote?.price ?? null : null, now, row.id, lease,...fenceArgs),
      DB.prepare(`INSERT INTO whatsapp_booking_events (event_key, conversation_id, outcome, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM whatsapp_booking_conversations WHERE id = ? AND lock_id = ?${fenceSql})`).bind(eventKey, row.id, outcome, now, row.id, lease,...fenceArgs),
    ];
    // Every new response supersedes unsent older prompts. Handoffs suppress all
    // automation, including queued replies; the acknowledgement is returned only
    // for the human-requesting event, then sent once by the same serialized owner.
    if (parts.length || state.phase === 'handoff') statements.push(DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'cancelled', body = NULL WHERE conversation_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM whatsapp_booking_conversations WHERE id = ? AND lock_id = ?${fenceSql})`).bind(row.id, row.id, lease,...fenceArgs));
    parts.forEach((part, index) => statements.push(DB.prepare(`INSERT INTO whatsapp_booking_replies (id, conversation_id, body, kind, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM whatsapp_booking_conversations WHERE id = ? AND lock_id = ?${fenceSql})`).bind(`${eventKey}:${index}`, row.id, part, state.phase === 'handoff' ? outcome==='model_fallback' && continuationSelected(env) && continuationFailureNoticePolicy(env) ? 'model_failure_notice' : 'handoff_ack' : 'prompt', now, row.id, lease,...fenceArgs)));
    const saved = await DB.batch(statements);
    if (!changes(saved[0])) return full?{processed:true,superseded:true}:{processed:true,phase:'handoff'};
    return { processed: true, phase: state.phase, conversationId: row.id };
  } catch {
    if(full){if(await leaseCurrent())await revokeFullConversation(DB,row.id,'provider_failure',Date.now(),expectedFence);return {processed:true,phase:'handoff'};}
    await DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = ? WHERE id = ? AND lock_id = ?`).bind(JSON.stringify({ phase: 'handoff', data: {} }), row.id, lease).run();
    return { processed: true, phase: 'handoff' };
  } finally {
    try {
      if(full && Date.now()>=deadlineAt)await revokeFullConversation(DB,row.id,'provider_failure',Date.now(),expectedFence);
    } finally {
      await DB.prepare('UPDATE whatsapp_booking_conversations SET lock_id = NULL, lock_at = NULL WHERE id = ? AND lock_id = ?').bind(row.id, lease).run();
    }
  }
}

export async function sendBookingReplies(env, fetchImpl = globalThis.fetch, clock = Date.now, options = {}) {
  // Numeric timestamps remain supported by deterministic callers. Production
  // reads the live clock again after every awaited reservation/database call.
  const readTime = typeof clock === 'function' ? clock : () => clock;
  const now = readTime();
  if (!bookingEnabled(env, now) || env.WHATSAPP_BOOKING_SEND_ENABLED !== 'on') return;
  const DB = env.DB;
  const full=fullBookingSelected(env),spec=full?fullBookingSpec(env):null;
  const job=full?durableOptions(options):null;
  if(full && (!spec || !await fullBookingCanProceed(env,readTime) || !await jobCurrent(DB,job,readTime)))return;
  if (env.WHATSAPP_BOOKING_PROVIDER === 'twilio') await reconcileTwilioBookingReceipts(env);
  const rows = await DB.prepare(`SELECT r.*, c.recipient, c.last_customer_at, c.state_json FROM whatsapp_booking_replies r JOIN whatsapp_booking_conversations c ON c.id = r.conversation_id WHERE c.provider = ? AND r.state = 'pending' AND c.phase != 'creating' AND (c.phase != 'handoff' OR r.kind IN ('handoff_ack','model_failure_notice')) AND c.lock_id IS NULL ${job?' AND substr(r.id,1,65)=?':''} ORDER BY r.created_at, r.id LIMIT 20`).bind(env.WHATSAPP_BOOKING_PROVIDER,...(job?[job.jobId+':']:[])).all();
  for (let row of rows.results || []) {
    const lease = job?.jobLease || crypto.randomUUID();
    if (!changes(await DB.prepare(`UPDATE whatsapp_booking_conversations SET lock_id = ?, lock_at = ? WHERE id = ? AND lock_id IS NULL AND phase != 'creating' AND (phase != 'handoff' OR ? IN ('handoff_ack','model_failure_notice'))${jobCondition(job)}`).bind(lease, now, row.conversation_id, row.kind,...jobArguments(job)).run())) continue;
    const failureNotice = row.kind==='model_failure_notice';
    let noticeClaimed=false,fullFence=null,fullReserved=false,providerStarted=false,deadlineAt=null;
    const fullSendCurrent=async()=>{
      if(!full)return true;
      if(!await jobCurrent(DB,job,readTime) || !fullFence || !Number.isSafeInteger(deadlineAt) || readTime()>=deadlineAt || !await fullBookingCanProceed(env,readTime))return false;
      if(!await fullLeaseCurrent(DB,row.conversation_id,lease,spec.grant_id,fullFence.epoch,fullFence.latest_event_key,{sending:true}))return false;
      const reply=await DB.prepare('SELECT state FROM whatsapp_booking_replies WHERE id=?').bind(row.id).first();
      return reply?.state==='sending' && await jobCurrent(DB,job,readTime) && readTime()<deadlineAt;
    };
    const sendFetch = async (...args) => {
      if(full && !await fullSendCurrent())throw new Error('full_booking_stopped');
      if(continuationSelected(env) && !(failureNotice && noticeClaimed
        ? await continuationFailureNoticeCanSend(env,row.id,readTime()) : await continuationCanProceed(env,readTime())))throw new Error('continuation_stopped');
      if(!bookingEnabled(env,readTime()) || env.WHATSAPP_BOOKING_SEND_ENABLED!=='on')throw new Error('booking_send_disabled');
      if(full){
        const remaining=deadlineAt-readTime();if(remaining<=0)throw new Error('full_booking_expired');
        const options={...args[1]};const deadlineSignal=AbortSignal.timeout(remaining);
        options.signal=options.signal?AbortSignal.any([options.signal,deadlineSignal]):deadlineSignal;
        args[1]=options;
      }
      providerStarted=true;return fetchImpl(...args);
    };
    try {
      if (env.WHATSAPP_BOOKING_PROVIDER === 'twilio') await reconcileTwilioBookingReceipts(env, null, { id: row.conversation_id, token: lease });
      if(full){
        const fresh=await DB.prepare(`SELECT r.*,c.recipient,c.last_customer_at,c.state_json FROM whatsapp_booking_replies r
          JOIN whatsapp_booking_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.lock_id=?`).bind(row.id,lease).first();
        fullFence=await DB.prepare('SELECT * FROM whatsapp_booking_full_fences WHERE conversation_id=?').bind(row.conversation_id).first();
        if(!fresh || fresh.state!=='pending' || !fullFence || fullFence.grant_id!==spec.grant_id || fullFence.stop_reason
          || !fresh.id.startsWith(fullFence.latest_event_key+':') || JSON.parse(fresh.state_json).full_grant_id!==spec.grant_id){
          await DB.prepare("UPDATE whatsapp_booking_replies SET state='cancelled',body=NULL WHERE id=? AND state='pending'").bind(row.id).run();continue;
        }
        row=fresh;
        const ingress=await DB.prepare('SELECT deadline_at FROM whatsapp_booking_full_ingress WHERE event_key=? AND conversation_id=?').bind(fullFence.latest_event_key,row.conversation_id).first();
        deadlineAt=ingress?.deadline_at;
        if(!Number.isSafeInteger(deadlineAt)||readTime()>=deadlineAt){
          await revokeFullConversation(DB,row.conversation_id,'provider_failure',readTime(),{grantId:spec.grant_id,epoch:fullFence.epoch,eventKey:fullFence.latest_event_key,lease,job});continue;
        }
      }
      if (readTime() - row.last_customer_at >= SESSION_WINDOW || !row.recipient) {
        await DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'expired', body = NULL WHERE id = ?`).bind(row.id).run();
        continue;
      }
      if (!changes(await DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'sending' WHERE id = ? AND state = 'pending'${jobCondition(job)}`).bind(row.id,...jobArguments(job)).run())) continue;
      if(full){
        if(!await fullSendCurrent() || !(fullReserved=await reserveFullBookingOperation(env,'outbound',row.id,readTime))){
          await DB.prepare("UPDATE whatsapp_booking_replies SET state='cancelled',body=NULL WHERE id=? AND state='sending'").bind(row.id).run();continue;
        }
      }
      let scopeState;
      try { scopeState=JSON.parse(row.state_json); } catch { scopeState=null; }
      const scopeMatches=scopeState?.conversation_only
        && (!lunaPilot(env) || scopeState.pilot_id===env.WHATSAPP_BOOKING_PILOT_ID)
        && (!continuationSelected(env) || scopeState.continuation_id===env.WHATSAPP_BOOKING_CONTINUATION_ID);
      if ((failureNotice && (!conversationOnlyPilot(env) || !continuationSelected(env)))
        || (conversationOnlyPilot(env) && (!scopeMatches
          || !(failureNotice ? (noticeClaimed=await claimContinuationFailureNotice(env,row.id,readTime()))
            : await reservePilotOperation(env,'outbound',readTime(),row.id))))) {
        await DB.batch([
          DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'cancelled', body = NULL WHERE id = ?`).bind(row.id),
          DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = json_set(state_json, '$.phase', 'handoff') WHERE id = ? AND lock_id = ?`).bind(row.conversation_id, lease),
        ]);
        continue;
      }
      let providerRef = null;
      try {
        if (env.WHATSAPP_BOOKING_PROVIDER === 'twilio') {
          providerRef = await sendTwilioBookingReply(env, row.recipient, row.body, sendFetch);
        } else if (env.WHATSAPP_TOKEN) {
          const response = await sendFetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_ID}/messages`, {
            method: 'POST', signal: AbortSignal.timeout(10_000),
            headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: row.recipient.replace(/^\+/, ''), type: 'text', text: { preview_url: false, body: row.body } }),
          });
          const data = await response.json();
          if (response.ok && /^[A-Za-z0-9._:=/-]{1,200}$/.test(data?.messages?.[0]?.id || '')) providerRef = data.messages[0].id;
        }
      } catch {}
      const fullSettled=!fullReserved || await finishFullBookingOperation(env,'outbound',row.id,!!providerRef,{},readTime);
      if (continuationSelected(env)) {
        if(failureNotice)await finishContinuationFailureNotice(env,row.id,!!providerRef,readTime());
        else await finishContinuation(env,'outbound',row.id,{ok:!!providerRef},readTime());
      }
      await DB.prepare('UPDATE whatsapp_booking_replies SET state = ?, provider_ref = ?, body = NULL WHERE id = ?').bind(providerRef ? 'sent' : 'failed', providerRef, row.id).run();
      if(full && ((!providerRef && providerStarted) || !fullSettled))await revokeFullConversation(DB,row.conversation_id,'provider_failure',readTime(),{grantId:spec.grant_id,epoch:fullFence.epoch,eventKey:fullFence.latest_event_key,lease,job});
      if (!providerRef && !full) await DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = json_set(state_json, '$.phase', 'handoff') WHERE id = ? AND lock_id = ?`).bind(row.conversation_id, lease).run();
    } finally {
      // Apply a callback that beat the POST response while still holding the
      // lease. No dispatcher or Confirm can enter the release/reconcile gap.
      try {
        if(full && fullFence && Number.isSafeInteger(deadlineAt) && readTime()>=deadlineAt)await revokeFullConversation(DB,row.conversation_id,'provider_failure',readTime(),{grantId:spec.grant_id,epoch:fullFence.epoch,eventKey:fullFence.latest_event_key,lease,job});
        if (env.WHATSAPP_BOOKING_PROVIDER === 'twilio') await reconcileTwilioBookingReceipts(env, null, { id: row.conversation_id, token: lease });
      } finally {
        await DB.prepare('UPDATE whatsapp_booking_conversations SET lock_id = NULL, lock_at = NULL WHERE id = ? AND lock_id = ?').bind(row.conversation_id, lease).run();
      }
    }
  }
}

export async function pauseBooking(DB, id, now = Date.now(), env = null) {
  const row = await DB.prepare('SELECT * FROM whatsapp_booking_conversations WHERE id = ?').bind(id).first();
  if (!row) return { status: 404 };
  const fullFence=JSON.parse(row.state_json).full_grant_id;
  if(fullFence){
    await revokeFullConversation(DB,id,'operator_stop',now);
    return {status:200};
  }
  // An in-flight provider send/order call cannot be recalled. Return busy until
  // it finishes; expired uncertain work is frozen, never retried automatically.
  if (row.lock_id && row.lock_at >= now - LOCK_TIMEOUT) return { status: 409 };
  const result = await DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = json_set(state_json, '$.phase', 'handoff'), lock_id = NULL, lock_at = NULL WHERE id = ? AND (lock_id IS NULL OR lock_at < ?)`).bind(id, now - LOCK_TIMEOUT).run();
  if (!changes(result)) return { status: 409 };
  await DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'cancelled', body = NULL WHERE conversation_id = ? AND state IN ('pending', 'sending')`).bind(id).run();
  if (env && continuationSelected(env) && JSON.parse(row.state_json).continuation_id===env.WHATSAPP_BOOKING_CONTINUATION_ID) await stopContinuation(env);
  return { status: 200 };
}

export async function cleanupBookings(env, now = Date.now()) {
  // Retention keeps running when booking or sends are disabled.
  if (env.WHATSAPP_BOOKING_STORAGE_READY !== 'on') return;
  const DB = env.DB;
  await DB.batch([
    DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = json_set(state_json, '$.phase', 'handoff'), lock_id = NULL, lock_at = NULL WHERE lock_at < ?`).bind(now - LOCK_TIMEOUT),
    DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'failed', body = NULL WHERE state = 'sending' AND conversation_id IN (SELECT id FROM whatsapp_booking_conversations WHERE phase = 'handoff')`),
    DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'handoff', state_json = '{"phase":"handoff","data":{}}', recipient = NULL WHERE created_at < ? AND phase != 'closed'`).bind(now - 2 * SESSION_WINDOW),
    DB.prepare('UPDATE whatsapp_booking_replies SET body = NULL, state = CASE WHEN state = \'pending\' THEN \'expired\' ELSE state END WHERE created_at < ?').bind(now - SESSION_WINDOW),
    DB.prepare('DELETE FROM whatsapp_booking_replies WHERE created_at < ?').bind(now - 7 * SESSION_WINDOW),
    DB.prepare('DELETE FROM whatsapp_booking_receipts WHERE created_at < ?').bind(now - 7 * SESSION_WINDOW),
    DB.prepare('DELETE FROM whatsapp_booking_events WHERE created_at < ?').bind(now - 8 * SESSION_WINDOW),
    DB.prepare(`DELETE FROM whatsapp_booking_conversations WHERE created_at < ? AND (checkout_started_at IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.token = whatsapp_booking_conversations.order_token AND o.payment_status = 'paid')) AND NOT EXISTS (SELECT 1 FROM whatsapp_booking_replies r WHERE r.conversation_id = whatsapp_booking_conversations.id)`).bind(now - 30 * SESSION_WINDOW),
  ]);
  if (env.WHATSAPP_BOOKING_PROVIDER === 'twilio') await reconcileTwilioBookingReceipts(env);
}

// Closing is an authenticated operator action, never a chat command. An unpaid
// checkout remains blocked unless canonically paid. D1 cancellation does NOT
// prove an external invoice was voided; even an attempt with no D1 order blocks.
export async function closeBooking(DB, id, now = Date.now()) {
  const row = await DB.prepare('SELECT * FROM whatsapp_booking_conversations WHERE id = ?').bind(id).first();
  if (!row) return { status: 404 };
  if (row.phase !== 'handoff' || row.lock_id) return { status: 409 };
  const order = await DB.prepare('SELECT payment_status, status FROM orders WHERE token = ?').bind(row.order_token).first();
  if ((order || row.checkout_started_at) && order?.payment_status !== 'paid') return { status: 409 };
  const result = await DB.prepare(`UPDATE whatsapp_booking_conversations SET phase = 'closed', state_json = '{"phase":"closed","data":{}}', recipient = NULL, sender_key = sender_key || ':' || id, updated_at = ? WHERE id = ? AND phase = 'handoff' AND lock_id IS NULL`).bind(now, id).run();
  if (!changes(result)) return { status: 409 };
  await DB.prepare(`UPDATE whatsapp_booking_replies SET state = 'cancelled', body = NULL WHERE conversation_id = ? AND state = 'pending'`).bind(id).run();
  return { status: 200 };
}
