import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {FULL_BOOKING_PROFILE,FULL_BOOKING_COSTS,issueFullBookingGrant,reserveFullBookingOperation,finishFullBookingOperation,stopFullBookingGrant} from '../src/whatsapp-full-booking.js';
import {acceptDurableBookingEvent,runBookingJob,decryptBookingJob,consumeBookingQueue,expireBookingJobs,recoverBookingJobs} from '../src/whatsapp-booking-jobs.js';
import {processBookingEvent,pauseBooking} from '../src/whatsapp-booking-store.js';
const NOW=Date.parse('2026-10-08T08:00:00Z'),phone='+972541234567';
const databases=[];afterEach(()=>{while(databases.length)databases.pop().close();});
function database(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));databases.push(sqlite);return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);let args=[];return{bind(...v){args=v;return this;},async first(){return statement.get(...args)||null;},async all(){return{results:statement.all(...args)};},async run(){return{meta:{changes:Number(statement.run(...args).changes)}};}};},async batch(statements){sqlite.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}
async function fixture(t){t.mock.timers.enable({apis:['Date'],now:NOW});const DB=database(),queued=[];
 const spec={version:1,environment:'staging',budget_id:'jobs-budget',grant_id:'jobs-grant',source_sha256:'a'.repeat(64),starts_at:NOW-1000,expires_at:NOW+1800000,budget_micros:10000000,retained_micros:0,allocation_micros:9000000,limits:{inbound:200,outbound:200,address:20,model:20},account_sid:'AC'+'1'.repeat(32),sender:'whatsapp:+15551234567',recipients:[phone],booking_url:'https://staging.edenmish.com',webhook_url:'https://ops-staging.edenmish.com/webhooks/twilio/booking',...FULL_BOOKING_PROFILE,costs:FULL_BOOKING_COSTS};
 const env={DB,SESSION_SECRET:'synthetic-job-secret',WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify(spec),WHATSAPP_BOOKING_FULL_APPROVED:'on',WHATSAPP_BOOKING_FULL_SCHEMA_READY:'on',WHATSAPP_BOOKING_DURABLE_READY:'on',WHATSAPP_BOOKING_QUEUE:{send:async(body,options)=>queued.push({body,options})},WHATSAPP_BOOKING_STORAGE_READY:'on',WHATSAPP_BOOKING_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODE:'full',WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_MODEL:'gpt-6.1-sol',WHATSAPP_BOOKING_REASONING_EFFORT:'low',WHATSAPP_BOOKING_PROVIDER:'twilio',TWILIO_ACCOUNT_SID:spec.account_sid,TWILIO_AUTH_TOKEN:'synthetic',TWILIO_BOOKING_FROM:spec.sender,TWILIO_BOOKING_WEBHOOK_URL:spec.webhook_url,TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:phone,BOOKING_URL:spec.booking_url,WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',WHATSAPP_BOOKING_FULL_OPENAI_API_KEY:'sk-synthetic-only-key'};
 assert.equal(await issueFullBookingGrant(env,{version:1,grant_id:spec.grant_id,budget_id:spec.budget_id,source_sha256:spec.source_sha256,approve:true},NOW-1),true);
 Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
 let sends=0,models=0,sequence=0;
 const services={multilingual:true,order:async()=>null,quote:async()=>{throw Error('unexpected quote');},resolveAddress:async()=>{throw Error('unexpected Maps');}};
 const fetchImpl=async()=>{sends++;return Response.json({sid:'SM'+String(sends).padStart(32,'0')});};
 const job=id=>DB.sqlite.prepare('SELECT * FROM whatsapp_booking_jobs WHERE id=?').get(id);
 const admit=async(text='היי',id)=>{sequence++;const event={id:id||`SM${sequence.toString(16).padStart(32,'0')}`,phone,text,echo:false,at:NOW+sequence};const result=await acceptDurableBookingEvent(env,event,Date.now());const row=DB.sqlite.prepare('SELECT * FROM whatsapp_booking_jobs WHERE event_at=?').get(event.at);return{event,result,row};};
 const crash=row=>{DB.sqlite.prepare("UPDATE whatsapp_booking_jobs SET state='processing',attempts=1,lease='crashed-owner',lease_until=? WHERE id=?").run(Date.now()+5000,row.id);DB.sqlite.prepare("UPDATE whatsapp_booking_conversations SET lock_id='crashed-owner',lock_at=? WHERE id=?").run(Date.now(),row.conversation_id);};
 return{env,DB,queued,services,fetchImpl,job,admit,crash,counts:()=>({sends,models})};
}

test('durable ACK stores encrypted event and ID-only wakeup; duplicate does not republish or reserve',async t=>{
 const f=await fixture(t);const {row,event,result}=await f.admit();assert.equal(result.status,200);assert.deepEqual(f.counts(),{sends:0,models:0});
 assert.equal(f.queued.length,1);assert.deepEqual(Object.keys(f.queued[0].body).sort(),['id','version']);assert.doesNotMatch(row.payload_cipher,/היי|972541234567/);
 assert.deepEqual(await decryptBookingJob(f.env,row),event);
 assert.equal((await acceptDurableBookingEvent(f.env,event,NOW+100)).status,200);assert.equal(f.queued.length,1);assert.equal(f.job(row.id).created_at,NOW);
 assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,1);
 await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});assert.equal(f.counts().sends,1);assert.equal(f.job(row.id).state,'done');assert.equal(f.job(row.id).payload_cipher,null);
 await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});assert.equal(f.counts().sends,1);
});

test('cipher binds event/grant/conversation/times and strips sensitive pasted text before storage',async t=>{
 const f=await fixture(t),{row}=await f.admit('4111 1111 1111 1111');assert.equal((await decryptBookingJob(f.env,row)).text,null);
 for(const change of [{id:'f'.repeat(64)},{grant_id:'other'},{conversation_id:'other'},{created_at:NOW+1},{deadline_at:NOW+29999}])await assert.rejects(()=>decryptBookingJob(f.env,{...row,...change}));
 await assert.rejects(()=>decryptBookingJob({...f.env,SESSION_SECRET:'different'},row));
});

test('restart before provider work reclaims expired lease and completes once within original deadline',async t=>{
 const f=await fixture(t),{row}=await f.admit();f.crash(row);t.mock.timers.setTime(NOW+5001);
 assert.equal((await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl})).done,true);
 assert.equal(f.counts().sends,1);assert.equal(f.job(row.id).attempts,2);assert.equal(f.job(row.id).deadline_at,NOW+30000);
 assert.equal(f.DB.sqlite.prepare('SELECT lock_id FROM whatsapp_booking_conversations').get().lock_id,null);
});

for(const kind of ['model','address','outbound'])for(const accepted of [false,true])test(`crash ${accepted?'after':'before'} ${kind} acceptance never repeats a held provider operation`,async t=>{
 const f=await fixture(t),{row}=await f.admit();f.crash(row);const key=kind==='model'?row.id:row.id+':'+(kind==='address'?'address:0':'0');
 assert.equal(await reserveFullBookingOperation(f.env,kind,key),true);if(accepted)await finishFullBookingOperation(f.env,kind,key,true);
 t.mock.timers.setTime(NOW+5001);await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});
 assert.equal(f.counts().sends,0);assert.equal(f.job(row.id).state,'uncertain');assert.equal(f.job(row.id).payload_cipher,null);
 assert.equal(f.DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase,'handoff');
 assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind=?').get(kind).n,1);
});

async function commitWithoutSend(f,row){f.DB.sqlite.prepare("UPDATE whatsapp_booking_jobs SET state='processing',lease='crashed-owner',attempts=1,lease_until=? WHERE id=?").run(NOW+5000,row.id);const event=await decryptBookingJob(f.env,f.job(row.id));await processBookingEvent(f.env,event,f.services,row.created_at,{jobId:row.id,jobLease:'crashed-owner',jobAttempt:1});}
test('crash after atomic draft/outbox commit resumes never-attempted send without rerunning the turn',async t=>{
 const f=await fixture(t),{row}=await f.admit();await commitWithoutSend(f,row);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_events').get().n,1);
 assert.equal(await reserveFullBookingOperation(f.env,'model',row.id),true);await finishFullBookingOperation(f.env,'model',row.id,true);
 t.mock.timers.setTime(NOW+5001);await runBookingJob(f.env,row.id,{...f.services,forEvent(){throw Error('must not replay committed turn');}},{fetchImpl:f.fetchImpl});
 assert.equal(f.counts().sends,1);assert.equal(f.job(row.id).state,'done');
});

test('crash after outbound reservation/acceptance before local recording remains uncertain and does not resend',async t=>{
 const f=await fixture(t),{row}=await f.admit();await commitWithoutSend(f,row);const reply=f.DB.sqlite.prepare('SELECT id FROM whatsapp_booking_replies').get();
 await reserveFullBookingOperation(f.env,'outbound',reply.id);f.DB.sqlite.prepare("UPDATE whatsapp_booking_replies SET state='sending' WHERE id=?").run(reply.id);
 t.mock.timers.setTime(NOW+5001);await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});
 assert.equal(f.counts().sends,0);assert.equal(f.job(row.id).state,'uncertain');assert.equal(f.DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase,'handoff');
});

test('crash after recorded outbound success only finalizes job; no duplicate send',async t=>{
 const f=await fixture(t),{row}=await f.admit();await commitWithoutSend(f,row);const reply=f.DB.sqlite.prepare('SELECT id FROM whatsapp_booking_replies').get();
 await reserveFullBookingOperation(f.env,'outbound',reply.id);await finishFullBookingOperation(f.env,'outbound',reply.id,true);
 f.DB.sqlite.prepare("UPDATE whatsapp_booking_replies SET state='sent',provider_ref=?,body=NULL WHERE id=?").run('SM'+'9'.repeat(32),reply.id);
 t.mock.timers.setTime(NOW+5001);await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});assert.equal(f.counts().sends,0);assert.equal(f.job(row.id).state,'done');
});

test('crashed older owner cannot block newer correction or revive after its lease is replaced',async t=>{
 const f=await fixture(t),first=await f.admit();f.crash(first.row);const correction=await f.admit('שלום');
 assert.equal(f.job(first.row.id).state,'superseded');assert.equal(f.job(first.row.id).payload_cipher,null);
 await runBookingJob(f.env,correction.row.id,f.services,{fetchImpl:f.fetchImpl});assert.equal(f.counts().sends,1);assert.equal(f.job(correction.row.id).state,'done');
 const stale=await processBookingEvent(f.env,first.event,f.services,NOW,{jobId:first.row.id,jobLease:'crashed-owner',jobAttempt:1});assert.equal(stale.disabled,true);
});

test('expired work and all-flags-OFF cleanup purge ciphertext without provider/key access or deadline reset',async t=>{
 const f=await fixture(t),{row}=await f.admit();f.crash(row);t.mock.timers.setTime(NOW+30001);
 for(const key of Object.keys(f.env))if(key.startsWith('WHATSAPP_'))delete f.env[key];delete f.env.SESSION_SECRET;
 await expireBookingJobs(f.env);assert.equal(f.job(row.id).state,'expired');assert.equal(f.job(row.id).payload_cipher,null);assert.equal(f.counts().sends,0);
 assert.equal(f.DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase,'handoff');
});

test('operator stop purges queued payload and blocks all subsequent queue work',async t=>{
 const f=await fixture(t),{row}=await f.admit();await pauseBooking(f.DB,row.conversation_id,NOW+1,f.env);
 assert.equal(f.job(row.id).payload_cipher,null);await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});assert.equal(f.counts().sends,0);
});

test('grant stop cleanup purges pending ciphertext while keeping inbound holds',async t=>{
 const f=await fixture(t),{row}=await f.admit();await stopFullBookingGrant(f.env);await recoverBookingJobs(f.env);
 assert.equal(f.job(row.id).payload_cipher,null);assert.equal(f.counts().sends,0);assert.equal(f.DB.sqlite.prepare('SELECT held_micros FROM whatsapp_full_booking_budgets').get().held_micros,10300);
});

test('queue delay respects crashed lease; last allowed delivery schedules a bounded durable wake',async t=>{
 const f=await fixture(t),{row}=await f.admit();f.crash(row);let retry,acks=0;
 const message={body:{version:1,id:row.id},attempts:1,ack(){acks++;},retry(options){retry=options;}};
 await consumeBookingQueue({queue:'edenmish-booking-full-staging',messages:[message]},f.env,f.services);assert.equal(retry.delaySeconds,6);assert.equal(acks,0);
 t.mock.timers.setTime(NOW+1001);message.attempts=3;await consumeBookingQueue({queue:'edenmish-booking-full-staging',messages:[message]},f.env,f.services);
 assert.equal(acks,1);assert.equal(f.queued.length,2);assert.ok(f.queued[1].options.delaySeconds>=4);assert.equal(f.counts().sends,0);
 t.mock.timers.setTime(NOW+6001);await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});assert.equal(f.counts().sends,1);
});

test('uncertain queue publication retains one durable job and bounded wake attempts',async t=>{
 const f=await fixture(t);f.env.WHATSAPP_BOOKING_QUEUE.send=async()=>{throw Error('queue unavailable');};const {row,result,event}=await f.admit();assert.equal(result.status,503);assert.equal((await acceptDurableBookingEvent(f.env,event,Date.now())).status,503);assert.equal(f.job(row.id).published_at,null);
 for(let i=1;i<=5;i++){t.mock.timers.setTime(NOW+i*1001);await acceptDurableBookingEvent(f.env,event,Date.now());}
 assert.equal(f.job(row.id).wakeups,3);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_booking_jobs').get().n,1);
 assert.equal(f.DB.sqlite.prepare('SELECT held_micros FROM whatsapp_full_booking_budgets').get().held_micros,10300);assert.equal(f.counts().sends,0);
});

test('multipart outbox recovery sends only a segment without a prior hold; recorded first segment is not repeated',async t=>{
 const f=await fixture(t),{row}=await f.admit();await commitWithoutSend(f,row);const first=f.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_replies').get();
 await reserveFullBookingOperation(f.env,'outbound',first.id);await finishFullBookingOperation(f.env,'outbound',first.id,true);
 f.DB.sqlite.prepare("UPDATE whatsapp_booking_replies SET state='sent',provider_ref=?,body=NULL WHERE id=?").run('SM'+'7'.repeat(32),first.id);
 f.DB.sqlite.prepare("INSERT INTO whatsapp_booking_replies(id,conversation_id,body,kind,created_at) VALUES(?,?,?,'prompt',?)").run(row.id+':1',row.conversation_id,'Synthetic second segment',NOW);
 t.mock.timers.setTime(NOW+5001);await runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl});
 assert.equal(f.counts().sends,1);assert.equal(f.job(row.id).state,'done');assert.deepEqual(f.DB.sqlite.prepare('SELECT state FROM whatsapp_booking_replies ORDER BY id').all().map(r=>r.state),['sent','sent']);
 assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='outbound'").get().n,2);
});

test('publication accepted but receipt recording fails: redelivery resumes one job and one send',async t=>{
 const f=await fixture(t),prepare=f.DB.prepare.bind(f.DB);let fail=true;
 f.DB.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith('UPDATE whatsapp_booking_jobs SET published_at=')){const run=stmt.run;stmt.run=async()=>{if(fail)throw Error('simulated publication receipt crash');return run.call(stmt);};}return stmt;};
 const {row,event,result}=await f.admit();assert.equal(result.status,503);assert.equal(f.queued.length,1);assert.equal(f.job(row.id).published_at,null);
 assert.equal((await acceptDurableBookingEvent(f.env,event)).status,503);
 fail=false;t.mock.timers.setTime(NOW+1001);assert.equal((await acceptDurableBookingEvent(f.env,event)).status,200);assert.equal(f.queued.length,2);
 const outcomes=await Promise.all([runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl}),runBookingJob(f.env,row.id,f.services,{fetchImpl:f.fetchImpl})]);
 assert.ok(outcomes.some(result=>result.done));assert.equal(f.counts().sends,1);assert.equal(f.job(row.id).state,'done');
 assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_full_booking_operations WHERE kind='inbound'").get().n,1);
});
