import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {FULL_BOOKING_PROFILE,FULL_BOOKING_COSTS,issueFullBookingGrant} from '../src/whatsapp-full-booking.js';
import {processBookingEvent,pauseBooking,sendBookingReplies,admitDurableBookingEvent,recoverDurableBookingLease,revokeDurableBookingJob} from '../src/whatsapp-booking-store.js';
import {createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
const NOW=Date.parse('2026-10-12T07:00:00Z'),phone='+972541234567';
async function fixture(t,{inbound=40}={}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
 const DB={sqlite,prepare(sql){const stmt=sqlite.prepare(sql);let args=[];return {sql,bind(...a){args=a;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:stmt.run(...args).changes}};}};},async batch(stmts){sqlite.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const spec={version:1,environment:'staging',budget_id:'synthetic-full-store-root',grant_id:'synthetic-full-store-grant',source_sha256:'a'.repeat(64),starts_at:NOW,expires_at:NOW+3600000,budget_micros:3000000,retained_micros:100000,allocation_micros:2000000,limits:{inbound,outbound:40,address:10,model:10},account_sid:'AC'+'1'.repeat(32),sender:'whatsapp:+15551234567',recipients:[phone],booking_url:'https://staging.edenmish.com',webhook_url:'https://ops-staging.edenmish.com/webhooks/twilio/booking',...FULL_BOOKING_PROFILE,costs:FULL_BOOKING_COSTS};
 const env={DB,WHATSAPP_BOOKING_DURABLE_READY:'on',WHATSAPP_BOOKING_QUEUE:{send:async()=>{}},WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify(spec),WHATSAPP_BOOKING_FULL_APPROVED:'on',WHATSAPP_BOOKING_FULL_SCHEMA_READY:'on',WHATSAPP_BOOKING_STORAGE_READY:'on',WHATSAPP_BOOKING_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODE:'full',WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_MODEL:'gpt-6.1-sol',WHATSAPP_BOOKING_REASONING_EFFORT:'low',WHATSAPP_BOOKING_PROVIDER:'twilio',TWILIO_ACCOUNT_SID:spec.account_sid,TWILIO_BOOKING_FROM:spec.sender,BOOKING_URL:spec.booking_url,TWILIO_BOOKING_WEBHOOK_URL:spec.webhook_url,TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:phone,WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',WHATSAPP_BOOKING_FULL_OPENAI_API_KEY:'sk-synthetic-test-key-only',TWILIO_AUTH_TOKEN:'synthetic',SESSION_SECRET:'synthetic'};
 assert.equal(await issueFullBookingGrant(env,{version:1,grant_id:spec.grant_id,budget_id:spec.budget_id,source_sha256:spec.source_sha256,approve:true},NOW),true);
 Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
 const services={multilingual:true,order:async()=>null,create:async()=>assert.fail('no checkout'),quote:async()=>({price:50,currency:'ILS',review:false}),resolveAddress:async()=>assert.fail('no Maps')};
 const event=(id,text,at=NOW)=>({id,phone,text,at});
 const row=()=>sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();
 const fence=()=>sqlite.prepare('SELECT * FROM whatsapp_booking_full_fences').get();
 const run=(e,svc=services)=>processBookingEvent(env,e,svc,Date.now());
 await run(event('start','מתחילים',NOW-10000));assert.equal(row().phase,'collect');
 return {env,DB,sqlite,services,event,row,fence,run};
}
function slowServices(f){let ready,resolve;const started=new Promise(r=>ready=r),answer=new Promise(r=>resolve=r);let calls=0;return {started,resolve,calls:()=>calls,services:{...f.services,forEvent:(_key,identity)=>({conversationModel:createOfflineBookingModel(async()=>{calls++;assert.equal(await identity.canProceed(),true);ready();return answer;})})}};}
const clarification={version:4,intent:'clarify',fields:[],topic:null,clarify_field:'size',reply_language:'he',reply_style:'friendly'};
const message='אני צריך עזרה לתכנן משהו לשליחה';
test('full duplicate and older ingress cannot revoke slow work; newer correction does and can resume once',async t=>{
 const f=await fixture(t),slow=slowServices(f),current=f.event('slow',message,NOW-5000);
 const pending=f.run(current,slow.services);await slow.started;const epoch=f.fence().epoch;
 assert.equal((await f.run(current,slow.services)).busy,true);assert.equal(f.fence().epoch,epoch);
 assert.equal((await f.run(f.event('older','בינוני',NOW-6000))).stale,true);assert.equal(f.fence().epoch,epoch);
 const correction=f.event('newer','קטן',NOW-4000);assert.equal((await f.run(correction)).busy,true);assert.equal(f.fence().epoch,epoch+1);
 slow.resolve(clarification);assert.equal((await pending).superseded,true);
 assert.equal(JSON.parse(f.row().state_json).data.size,undefined);
 await f.run(correction);assert.equal(JSON.parse(f.row().state_json).data.size,'small');assert.equal(slow.calls(),1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,4);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,1);
});
test('operator stop immediately revokes held full lease; late model cannot overwrite or send',async t=>{
 const f=await fixture(t),slow=slowServices(f),pending=f.run(f.event('slow',message,NOW-5000),slow.services);await slow.started;
 const lease=f.row().lock_id;assert.ok(lease);assert.equal((await pauseBooking(f.DB,f.row().id,NOW,f.env)).status,200);
 assert.equal(f.row().lock_id,lease);assert.equal(f.row().phase,'handoff');assert.equal(f.fence().stop_reason,'operator_stop');
 slow.resolve(clarification);assert.equal((await pending).superseded,true);assert.equal(f.row().phase,'handoff');assert.equal(f.row().lock_id,null);
 assert.deepEqual(JSON.parse(f.row().state_json).data,{service:'standard',customer_type:'private'});await sendBookingReplies(f.env,()=>assert.fail('no send after pause'),()=>NOW);
});
for(const kind of ['same-second','late-human'])test('full '+kind+' revokes slow work without losing stop',async t=>{
 const f=await fixture(t),slow=slowServices(f),pending=f.run(f.event('slow',message,NOW-5000),slow.services);await slow.started;
 await f.run(f.event('stop',kind==='late-human'?'נציג':'קטן',kind==='late-human'?NOW-9000:NOW-5000));
 assert.equal(f.fence().stop_reason,kind==='late-human'?'customer_takeover':'ambiguous_order');slow.resolve(clarification);await pending;
 assert.equal(f.row().phase,'handoff');assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,0);
});
test('full model fallback never persists guessed fallback fields or queues automated reply',async t=>{
 const f=await fixture(t);const before=JSON.parse(f.row().state_json).data;
 await f.run(f.event('failure',message,NOW-5000),{...f.services,forEvent:()=>({conversationModel:createOfflineBookingModel(()=>null)})});
 assert.equal(f.row().phase,'handoff');assert.equal(f.fence().stop_reason,'model_failure');assert.deepEqual(JSON.parse(f.row().state_json).data,before);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,0);
});
test('full audio offers typing only and never requests consent or calls transcription/model',async t=>{
 const f=await fixture(t);const before=JSON.parse(f.row().state_json).data;
 await f.run({...f.event('audio',null,NOW-5000),audio:{url:'https://example.invalid/audio'}},{...f.services,transcribeAudio:()=>assert.fail('no audio'),forEvent:()=>({conversationModel:createOfflineBookingModel(()=>assert.fail('no model'))})});
 const state=JSON.parse(f.row().state_json);assert.deepEqual(state.data,before);assert.equal(state.audio_consent_pending,undefined);
 const reply=f.sqlite.prepare("SELECT body FROM whatsapp_booking_replies WHERE state='pending'").get().body;assert.match(reply,/כתבו/);assert.doesNotMatch(reply,/מסכימ|OpenAI/);
});
test('full send reload and reservation guard suppress pause occurring before network',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let paused=false;
 f.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('INSERT INTO whatsapp_full_booking_operations')){const bind=s.bind.bind(s),first=s.first.bind(s);let kind;s.bind=(...args)=>{kind=args[1];return bind(...args);};s.first=async()=>{const r=await first();if(kind==='outbound'&&!paused){paused=true;await pauseBooking(f.DB,f.row().id,NOW,f.env);}return r;};}return s;};
 await sendBookingReplies(f.env,()=>assert.fail('no provider call'),()=>NOW);assert.equal(paused,true);assert.equal(f.row().phase,'handoff');
 const op=f.sqlite.prepare("SELECT status,reserved_micros FROM whatsapp_full_booking_operations WHERE kind='outbound'").get();assert.equal(op.status,'uncertain');assert.equal(op.reserved_micros,11300);
});
test('correction arriving after final read is fenced out of old state and outbox transaction',async t=>{
 const f=await fixture(t),batch=f.DB.batch.bind(f.DB);let injected=false;
 const correction=f.event('newer','בינוני',NOW-4000);
 f.DB.batch=async stmts=>{if(!injected && stmts[0].sql.startsWith('UPDATE whatsapp_booking_conversations SET state_json =')){injected=true;assert.equal((await f.run(correction)).busy,true);}return batch(stmts);};
 assert.equal((await f.run(f.event('old','קטן',NOW-5000))).superseded,true);
 assert.equal(JSON.parse(f.row().state_json).data.size,undefined);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,0);
 await f.run(correction);assert.equal(JSON.parse(f.row().state_json).data.size,'medium');
});
test('queued reply list is reloaded after lease; a correction before lease prevents stale send',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let injected=false,sends=0;
 f.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('SELECT r.*, c.recipient')){const all=s.all.bind(s);s.all=async()=>{const rows=await all();if(!injected){injected=true;await f.run(f.event('newer','קטן',NOW-5000));}return rows;};}return s;};
 const fetch=async()=>{sends++;return Response.json({sid:'SM'+'a'.repeat(32)});};
 await sendBookingReplies(f.env,fetch,()=>NOW);assert.equal(sends,0);
 await sendBookingReplies(f.env,fetch,()=>NOW);assert.equal(sends,1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().n,1);
});
test('new full grant cannot bypass an old conversation checkout tombstone',async t=>{
 const f=await fixture(t);f.sqlite.prepare("UPDATE whatsapp_booking_conversations SET phase='handoff',checkout_started_at=?").run(NOW);
 const spec=JSON.parse(f.env.WHATSAPP_BOOKING_FULL_CONFIG);spec.grant_id='second-full-grant';spec.allocation_micros=500000;
 f.env.WHATSAPP_BOOKING_FULL_CONFIG=JSON.stringify(spec);Object.assign(f.env,{WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off'});
 assert.equal(await issueFullBookingGrant(f.env,{version:1,grant_id:spec.grant_id,budget_id:spec.budget_id,source_sha256:spec.source_sha256,approve:true},NOW),true);
 Object.assign(f.env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
 assert.equal((await f.run(f.event('new-grant','מתחילים',NOW-1000))).phase,'handoff');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_conversations').get().n,1);assert.equal(f.row().checkout_started_at,NOW);
 assert.equal(f.fence().grant_id,'synthetic-full-store-grant');
});
test('expiry during final lease read suppresses model service binding',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let crossed=false;
 f.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('SELECT c.phase,c.lock_id')){const first=s.first.bind(s);s.first=async()=>{const r=await first();if(!crossed){crossed=true;t.mock.timers.setTime(NOW+3600000);}return r;};}return s;};
 const result=await f.run(f.event('expiry',message,NOW-5000),{...f.services,forEvent:()=>assert.fail('expired before service binding')});
 assert.equal(result.superseded,true);assert.equal(crossed,true);
});
test('failed old model cannot revoke newer correction admitted after its last guard read',async t=>{
 const f=await fixture(t),batch=f.DB.batch.bind(f.DB);let injected=false;const correction=f.event('newer','קטן',NOW-4000);
 f.DB.batch=async stmts=>{if(!injected&&stmts[0].sql.startsWith('UPDATE whatsapp_booking_full_fences SET epoch=epoch+1,stopped_at=')){injected=true;assert.equal((await f.run(correction)).busy,true);}return batch(stmts);};
 await f.run(f.event('old',message,NOW-5000),{...f.services,forEvent:()=>({conversationModel:createOfflineBookingModel(()=>null)})});
 assert.equal(injected,true);assert.equal(f.fence().stop_reason,null);assert.equal(f.row().phase,'collect');
 await f.run(correction);assert.equal(JSON.parse(f.row().state_json).data.size,'small');
});
for(const text of ['נציג','קטן'])test('exhausted inbound quota still revokes active work on '+text,async t=>{
 const f=await fixture(t,{inbound:2}),slow=slowServices(f),pending=f.run(f.event('slow',message,NOW-5000),slow.services);await slow.started;
 assert.equal((await f.run(f.event('denied',text,NOW-4000))).disabled,true);
 assert.equal(f.row().phase,'handoff');assert.equal(f.fence().stop_reason,text==='נציג'?'customer_takeover':'provider_failure');
 slow.resolve(clarification);await pending;assert.equal(f.row().phase,'handoff');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,2);
});
test('duplicate between inbound reservation and admission does not revoke original event',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB),current=f.event('racing','קטן',NOW-5000);let inserted=false;
 f.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('INSERT INTO whatsapp_full_booking_operations')){const first=s.first.bind(s);s.first=async()=>{const result=await first();if(!inserted){inserted=true;assert.equal((await f.run(current)).busy,true);}return result;};}return s;};
 await f.run(current);assert.equal(inserted,true);assert.equal(f.fence().stop_reason,null);assert.equal(JSON.parse(f.row().state_json).data.size,'small');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,2);
});
test('unconfirmed send settlement preserves accepted message reference and hold, pauses further automation',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let sends=0;
 f.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('UPDATE whatsapp_full_booking_operations SET status='))s.run=async()=>{throw Error('synthetic persistence uncertainty');};return s;};
 const fetch=async()=>{sends++;return Response.json({sid:'SM'+'b'.repeat(32)});};
 await sendBookingReplies(f.env,fetch,()=>NOW);assert.equal(sends,1);assert.equal(f.row().phase,'handoff');
 assert.equal(f.sqlite.prepare("SELECT status FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().status,'pending');
 const reply=f.sqlite.prepare("SELECT state,provider_ref FROM whatsapp_booking_replies WHERE provider_ref IS NOT NULL").get();assert.equal(reply.state,'sent');assert.equal(reply.provider_ref,'SM'+'b'.repeat(32));
 await sendBookingReplies(f.env,fetch,()=>NOW);assert.equal(sends,1);
});

test('failed admission after inbound settlement revokes older work and retains the hold without retry',async t=>{
 const f=await fixture(t),slow=slowServices(f),pending=f.run(f.event('slow',message,NOW-5000),slow.services);await slow.started;
 const batch=f.DB.batch.bind(f.DB);let failed=false;
 f.DB.batch=async stmts=>{if(!failed&&stmts[0].sql.startsWith('INSERT OR IGNORE INTO whatsapp_booking_full_ingress')){failed=true;throw Error('synthetic admission failure');}return batch(stmts);};
 const correction=f.event('uncertain-correction','קטן',NOW-4000);
 assert.equal((await f.run(correction)).disabled,true);assert.equal(failed,true);assert.equal(f.fence().stop_reason,'provider_failure');
 assert.equal((await f.run(correction)).busy,true);
 slow.resolve(clarification);await pending;assert.equal(f.row().phase,'handoff');assert.equal(JSON.parse(f.row().state_json).data.size,undefined);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,3);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_full_ingress").get().n,2);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,0);
});

test('admission cancels older pending replies using exact HMAC prefix without SQLite LIKE patterns',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);
 f.DB.prepare=sql=>{assert.doesNotMatch(sql,/\b(?:LIKE|GLOB)\b/i,'Workerd limits pattern complexity; fixed event prefixes need equality');return prepare(sql);};
 const current=f.event('new-prefix','קטן',NOW-5000);
 await f.run(current);
 assert.equal(f.fence().stop_reason,null);assert.equal(JSON.parse(f.row().state_json).data.size,'small');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='cancelled'").get().n,1);
 const reply=f.sqlite.prepare("SELECT id,body FROM whatsapp_booking_replies WHERE state='pending'").get();assert.ok(reply.body);assert.equal(reply.id.slice(0,65),f.fence().latest_event_key+':');
 assert.equal((await f.run(current)).duplicate,true);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,1);
});
for(const elapsed of [12000,30000])test('full turn '+elapsed+'ms preserves soft latency but rejects hard cutoff',async t=>{
 const f=await fixture(t);let scope;
 const services={...f.services,forEvent:(_key,identity)=>{scope=identity;return {conversationModel:createOfflineBookingModel(async()=>{t.mock.timers.setTime(NOW+elapsed);return clarification;})};}};
 await f.run(f.event('deadline',message,NOW-5000),services);
 assert.equal(scope.turnStartedAt,NOW);assert.equal(scope.deadlineAt,NOW+30000);
 assert.equal(f.row().phase,elapsed<30000?'collect':'handoff');
 assert.equal(f.fence().stop_reason,elapsed<30000?null:'provider_failure');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,elapsed<30000?1:0);
});
test('busy correction retry reuses first receipt deadline and cannot restart turn after cutoff',async t=>{
 const f=await fixture(t),slow=slowServices(f),pending=f.run(f.event('slow',message,NOW-5000),slow.services);await slow.started;
 t.mock.timers.setTime(NOW+1000);const correction=f.event('correction','קטן',NOW-4000);
 assert.equal((await f.run(correction)).busy,true);
 const ingress=f.sqlite.prepare('SELECT created_at,deadline_at FROM whatsapp_booking_full_ingress WHERE event_key=?').get(f.fence().latest_event_key);
 assert.equal(ingress.created_at,NOW+1000);assert.equal(ingress.deadline_at,NOW+31000);
 slow.resolve(clarification);await pending;
 t.mock.timers.setTime(NOW+31000);
 await f.run(correction,{...f.services,forEvent:()=>assert.fail('expired retry must not bind services')});
 assert.deepEqual(f.sqlite.prepare('SELECT created_at,deadline_at FROM whatsapp_booking_full_ingress WHERE event_key=?').get(f.fence().latest_event_key),ingress);
 assert.equal(f.row().phase,'handoff');assert.equal(JSON.parse(f.row().state_json).data.size,undefined);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,3);
});
test('queued full reply expires with original turn and makes no new outbound reservation',async t=>{
 const f=await fixture(t);t.mock.timers.setTime(NOW+30000);
 await sendBookingReplies(f.env,()=>assert.fail('expired reply must not send'),Date.now);
 assert.equal(f.row().phase,'handoff');assert.equal(f.fence().stop_reason,'provider_failure');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().n,0);
});
test('full expiry crossed during last reply read suppresses provider call and retains outbound hold',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let reads=0;
 f.DB.prepare=sql=>{const s=prepare(sql);if(sql==='SELECT state FROM whatsapp_booking_replies WHERE id=?'){const first=s.first.bind(s);s.first=async()=>{const r=await first();if(++reads===2)t.mock.timers.setTime(NOW+30000);return r;};}return s;};
 await sendBookingReplies(f.env,()=>assert.fail('no post-deadline provider call'),Date.now);
 assert.equal(reads,2);assert.equal(f.row().phase,'handoff');
 assert.equal(f.sqlite.prepare("SELECT status FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().status,'uncertain');
});
test('full outbound preserves accepted provider reference when response arrives after turn cutoff',async t=>{
 const f=await fixture(t);let signal;
 await sendBookingReplies(f.env,async(_url,options)=>{signal=options.signal;t.mock.timers.setTime(NOW+30000);return Response.json({sid:'SM'+'c'.repeat(32)});},Date.now);
 assert.ok(signal instanceof AbortSignal);assert.equal(f.row().phase,'handoff');
 assert.equal(f.sqlite.prepare("SELECT provider_ref FROM whatsapp_booking_replies WHERE state='sent'").get().provider_ref,'SM'+'c'.repeat(32));
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().n,1);
});
test('full ingress deadline clips to customer session and grant end',async t=>{
 const f=await fixture(t);const first=f.sqlite.prepare('SELECT deadline_at FROM whatsapp_booking_full_ingress').get();assert.equal(first.deadline_at,NOW+30000);
 // A delayed but still-valid event has only five seconds left in its 24h window.
 const event=f.event('near-session-end','קטן',NOW-24*3600000+5000);
 await f.run(event);const row=f.sqlite.prepare('SELECT deadline_at FROM whatsapp_booking_full_ingress WHERE event_at=?').get(event.at);assert.equal(row.deadline_at,NOW+5000);
 t.mock.timers.setTime(NOW+3600000-5000);const nearEnd=f.event('near-grant-end','קטן',NOW+3600000-5000);
 await f.run(nearEnd);assert.equal(f.sqlite.prepare('SELECT deadline_at FROM whatsapp_booking_full_ingress WHERE event_at=?').get(nearEnd.at).deadline_at,NOW+3600000);
});
test('operator stop after soft threshold remains authoritative when late model crosses hard deadline',async t=>{
 const f=await fixture(t),slow=slowServices(f),pending=f.run(f.event('slow-stop',message,NOW-5000),slow.services);await slow.started;
 t.mock.timers.setTime(NOW+12000);await pauseBooking(f.DB,f.row().id,Date.now(),f.env);
 t.mock.timers.setTime(NOW+30000);slow.resolve(clarification);await pending;
 assert.equal(f.fence().stop_reason,'operator_stop');assert.equal(f.row().phase,'handoff');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_replies WHERE state='pending'").get().n,0);
});
const claimJob=(f,id,lease='synthetic-owner',attempt=1)=>{
 f.sqlite.prepare("UPDATE whatsapp_booking_jobs SET state='processing',lease=?,lease_until=?,attempts=? WHERE id=?").run(lease,Date.now()+5000,attempt,id);
 return {jobId:id,jobLease:lease,jobAttempt:attempt};
};
test('durable admission atomically stores encrypted job, original deadline, one hold and correction fence',async t=>{
 const f=await fixture(t),e=f.event('durable','קטן',NOW-5000);let aad;
 const admitted=await admitDurableBookingEvent(f.env,e,NOW,{payloadCipher:scope=>{aad=scope;return 'synthetic-cipher';}});
 assert.equal(admitted.accepted,true);assert.equal(aad.eventKey,admitted.eventKey);assert.equal(aad.conversationId,f.row().id);assert.equal(aad.deadlineAt,NOW+30000);
 const job=f.sqlite.prepare('SELECT * FROM whatsapp_booking_jobs').get();assert.equal(job.state,'pending');assert.equal(job.lease,null);assert.equal(job.payload_cipher,'synthetic-cipher');
 const hold=f.sqlite.prepare("SELECT status FROM whatsapp_full_booking_operations WHERE kind='inbound' AND operation_key=?").get(admitted.eventKey);assert.equal(hold.status,'settled');
 t.mock.timers.setTime(NOW+1000);
 const duplicate=await admitDurableBookingEvent(f.env,e,Date.now(),{payloadCipher:()=>assert.fail('no re-encryption on duplicate')});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.deadlineAt,NOW+30000);
 const opts=claimJob(f,admitted.eventKey);await processBookingEvent(f.env,e,f.services,Date.now(),opts);
 assert.equal(JSON.parse(f.row().state_json).data.size,'small');assert.equal(f.row().lock_id,null);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,2);
 let sends=0;await sendBookingReplies(f.env,async()=>{sends++;return Response.json({sid:'SM'+'d'.repeat(32)});},Date.now,opts);assert.equal(sends,1);
});
test('durable funding failure rolls back job and ingress, retaining existing holds and suppressing old work',async t=>{
 const f=await fixture(t,{inbound:1}),e=f.event('no-funds','קטן',NOW-5000);
 const admitted=await admitDurableBookingEvent(f.env,e,NOW,{payloadCipher:'synthetic-cipher'});assert.equal(admitted.accepted,false);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_jobs').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_full_ingress').get().n,1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,1);
 assert.equal(f.row().phase,'handoff');
});
test('durable correction immediately supersedes an active job and prevents its late model commit',async t=>{
 const f=await fixture(t),e=f.event('old-job',message,NOW-5000),admitted=await admitDurableBookingEvent(f.env,e,NOW,{payloadCipher:'old-cipher'});
 const opts=claimJob(f,admitted.eventKey),slow=slowServices(f),pending=processBookingEvent(f.env,e,slow.services,NOW,opts);await slow.started;
 const next=await admitDurableBookingEvent(f.env,f.event('new-job','קטן',NOW-4000),NOW,{payloadCipher:'new-cipher'});assert.equal(next.accepted,true);
 const old=f.sqlite.prepare('SELECT * FROM whatsapp_booking_jobs WHERE id=?').get(admitted.eventKey);assert.equal(old.state,'superseded');assert.equal(old.payload_cipher,null);
 slow.resolve(clarification);await pending;assert.equal(JSON.parse(f.row().state_json).data.size,undefined);assert.equal(f.fence().latest_event_key,next.eventKey);
 assert.equal(await revokeDurableBookingJob(f.env,admitted.eventKey,opts,NOW),false);assert.equal(f.fence().stop_reason,null);
});
test('durable lease expiry suppresses slow result; fenced recovery releases only its known old lock',async t=>{
 const f=await fixture(t),e=f.event('recover',message,NOW-5000),admitted=await admitDurableBookingEvent(f.env,e,NOW,{payloadCipher:'cipher'});
 const opts=claimJob(f,admitted.eventKey),slow=slowServices(f),pending=processBookingEvent(f.env,e,slow.services,NOW,opts);await slow.started;assert.equal(f.row().lock_id,opts.jobLease);
 t.mock.timers.setTime(NOW+5000);const newer=claimJob(f,admitted.eventKey,'new-owner',2);
 assert.equal(await recoverDurableBookingLease(f.env,admitted.eventKey,{...newer,previousLease:'wrong-owner'},Date.now()),false);
 assert.equal(await recoverDurableBookingLease(f.env,admitted.eventKey,{...newer,previousLease:opts.jobLease},Date.now()),true);assert.equal(f.row().lock_id,null);
 slow.resolve(clarification);await pending;assert.equal(f.row().phase,'collect');assert.equal(f.fence().stop_reason,null);
 assert.equal(JSON.parse(f.row().state_json).data.size,undefined);
});
test('durable send requires current job owner and filters replies to that job',async t=>{
 const f=await fixture(t),e=f.event('send-owner','קטן',NOW-5000),admitted=await admitDurableBookingEvent(f.env,e,NOW,{payloadCipher:'cipher'}),opts=claimJob(f,admitted.eventKey);
 await processBookingEvent(f.env,e,f.services,NOW,opts);
 await sendBookingReplies(f.env,()=>assert.fail('wrong queue owner'),Date.now,{...opts,jobLease:'wrong'});
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().n,0);
 t.mock.timers.setTime(NOW+5000);await sendBookingReplies(f.env,()=>assert.fail('expired queue owner'),Date.now,opts);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().n,0);
});
test('durable backpressure atomically refuses job101 without a new hold and pauses older work',async t=>{
 const f=await fixture(t);
 const insert=f.sqlite.prepare("INSERT INTO whatsapp_booking_jobs(id,grant_id,conversation_id,event_at,created_at,deadline_at,payload_cipher,state,attempts,lease,lease_until,next_attempt_at) VALUES(?,'synthetic-full-store-grant',?,?,?,?,'cipher','pending',0,NULL,NULL,?)");
 for(let i=0;i<100;i++)insert.run(i.toString(16).padStart(64,'0'),f.row().id,NOW-5000,NOW,NOW+30000,NOW);
 const result=await admitDurableBookingEvent(f.env,f.event('overload','קטן',NOW-4000),NOW,{payloadCipher:'cipher'});
 assert.equal(result.accepted,false);assert.equal(result.backpressure,true);assert.equal(f.row().phase,'handoff');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_jobs').get().n,100);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,1);
});
test('durable encryption failure does not persist payload or allow an older slow result',async t=>{
 const f=await fixture(t),slow=slowServices(f),pending=f.run(f.event('old-encryption',message,NOW-5000),slow.services);await slow.started;
 const result=await admitDurableBookingEvent(f.env,f.event('cipher-failed','קטן',NOW-4000),NOW,{payloadCipher:()=>{throw Error('synthetic cipher error');}});
 assert.equal(result.accepted,false);assert.equal(f.row().phase,'handoff');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_jobs').get().n,0);
 slow.resolve(clarification);await pending;assert.equal(JSON.parse(f.row().state_json).data.size,undefined);
});
test('new durable correction can recover terminal old owner lock while preserving checkout tombstones',async t=>{
 const f=await fixture(t),oldEvent=f.event('crashed-old','קטן',NOW-5000),old=await admitDurableBookingEvent(f.env,oldEvent,NOW,{payloadCipher:'old'}),oldOpts=claimJob(f,old.eventKey,'crashed-owner');
 f.sqlite.prepare('UPDATE whatsapp_booking_conversations SET lock_id=?,lock_at=?').run(oldOpts.jobLease,NOW);
 const nextEvent=f.event('after-crash','בינוני',NOW-4000),next=await admitDurableBookingEvent(f.env,nextEvent,NOW,{payloadCipher:'new'}),opts=claimJob(f,next.eventKey,'new-owner');
 const oldJob=f.sqlite.prepare('SELECT state,lease,payload_cipher FROM whatsapp_booking_jobs WHERE id=?').get(old.eventKey);assert.equal(oldJob.state,'superseded');assert.equal(oldJob.lease,'crashed-owner');assert.equal(oldJob.payload_cipher,null);
 f.sqlite.prepare('UPDATE whatsapp_booking_conversations SET checkout_started_at=?').run(NOW);
 assert.equal(await recoverDurableBookingLease(f.env,next.eventKey,opts,NOW),false);assert.equal(f.row().checkout_started_at,NOW);
 f.sqlite.prepare('UPDATE whatsapp_booking_conversations SET checkout_started_at=NULL').run();
 assert.equal(await recoverDurableBookingLease(f.env,next.eventKey,opts,NOW),true);assert.equal(f.row().lock_id,null);
 await processBookingEvent(f.env,nextEvent,f.services,NOW,opts);assert.equal(JSON.parse(f.row().state_json).data.size,'medium');
});
test('operator pause purges durable payload immediately and prevents owner continuation',async t=>{
 const f=await fixture(t),e=f.event('pause-job','קטן',NOW-5000),admitted=await admitDurableBookingEvent(f.env,e,NOW,{payloadCipher:'cipher'}),opts=claimJob(f,admitted.eventKey);
 await pauseBooking(f.DB,f.row().id,NOW,f.env);
 const job=f.sqlite.prepare('SELECT state,payload_cipher,lease FROM whatsapp_booking_jobs').get();assert.equal(job.state,'uncertain');assert.equal(job.payload_cipher,null);assert.equal(job.lease,opts.jobLease);
 assert.equal((await processBookingEvent(f.env,e,f.services,NOW,opts)).disabled,true);assert.equal(JSON.parse(f.row().state_json).data.size,undefined);
});
test('owned durable job cleanup can revoke after full configuration and secrets are removed',async t=>{
 const f=await fixture(t),e=f.event('off-cleanup','קטן',NOW-5000),admitted=await admitDurableBookingEvent(f.env,e,NOW,{payloadCipher:'cipher'}),opts=claimJob(f,admitted.eventKey);
 assert.equal(await revokeDurableBookingJob({DB:f.DB},admitted.eventKey,opts,NOW),true);assert.equal(f.row().phase,'handoff');assert.equal(f.fence().stop_reason,'provider_failure');
});
test('failed old durable encryption cannot revoke a newer admitted correction',async t=>{
 const f=await fixture(t);let next;
 const old=await admitDurableBookingEvent(f.env,f.event('failed-old','קטן',NOW-5000),NOW,{payloadCipher:async()=>{
  next=await admitDurableBookingEvent(f.env,f.event('winner-new','בינוני',NOW-4000),NOW,{payloadCipher:'new-cipher'});
  throw Error('synthetic delayed encryption failure');
 }});
 assert.equal(old.accepted,false);assert.equal(next.accepted,true);assert.equal(f.fence().stop_reason,null);assert.equal(f.fence().latest_event_key,next.eventKey);
 assert.equal(f.sqlite.prepare('SELECT state FROM whatsapp_booking_jobs WHERE id=?').get(next.eventKey).state,'pending');
});
