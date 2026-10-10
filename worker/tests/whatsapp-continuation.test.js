import {prepareContinuation} from './fixtures/continuation-env.js';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {issueContinuationGrant,reserveContinuation,finishContinuation,continuationCanProceed,stopContinuation,CONTINUATION} from '../src/whatsapp-continuation.js';
import {createOpenAIBookingModel} from '../src/whatsapp-booking-openai.js';
import {proposeBookingTurn} from '../src/whatsapp-booking-model.js';
import {reservePilotOperation} from '../src/whatsapp-booking-pilot.js';
import {processBookingEvent,sendBookingReplies,pauseBooking} from '../src/whatsapp-booking-store.js';
const now=Date.parse('2026-10-09T12:00:00Z'),usage={input_tokens:1000,output_tokens:50,total_tokens:1050};
const databases=[];afterEach(()=>{for(const d of databases.splice(0))d.close();});
function database(){
 const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));let queue=Promise.resolve();
 return {sqlite,prepare(sql){const s=sqlite.prepare(sql);let v=[];return{bind(...x){v=x;return this;},async first(){return s.get(...v)||null;},async all(){return{results:s.all(...v)};},async run(){return{meta:{changes:Number(s.run(...v).changes)}};}};},batch(ss){const p=queue.then(async()=>{sqlite.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}});queue=p.catch(()=>{});return p;}};
}
const prepared=(DB=database())=>prepareContinuation(DB,now);
const enable=e=>({...e,WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
const grant=e=>e.DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_grants').get();
const historical=e=>JSON.stringify([e.DB.sqlite.prepare('SELECT * FROM whatsapp_pilot_budgets').all(),e.DB.sqlite.prepare('SELECT * FROM whatsapp_pilot_model_attempts ORDER BY id').all(),e.DB.sqlite.prepare('SELECT * FROM rate_limits').all()]);
async function active(){const e=await prepared();assert.equal(await issueContinuationGrant(e,now),true);return enable(e);}
const state={phase:'collect',consent_at:1,data:{},language:'he'};
const response=()=>Response.json({model:'gpt-6-luna',service_tier:'default',status:'completed',usage,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({version:2,intent:'update',fields:[{field:'size',quote:'מפתחות'}],topic:null,clarify_field:null})}]}]});
const eventId=n=>n.toString(16).padStart(64,'0');

test('grant issuance is explicit OFF-only, versioned and immutable; historical ledger/hash/counters stay unchanged',async()=>{
 const e=await prepared();e.DB.sqlite.exec("INSERT INTO rate_limits(key,count,window_start,last_at) VALUES('wa-pilot:older-run:inbound',29,1,1)");const old=historical(e);
 for(const patch of [{WHATSAPP_BOOKING_CONTINUATION_APPROVED:'off'},{WHATSAPP_BOOKING_CONTINUATION_VERSION:'2'}, {WHATSAPP_BOOKING_CONTINUATION_COST_REVIEW:undefined},{WHATSAPP_BOOKING_CONTINUATION_COSTS_UNKNOWN:undefined},{WHATSAPP_BOOKING_CONTINUATION_COSTS_UNKNOWN:'on'}, {WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+1800001).toISOString()}, {WHATSAPP_BOOKING_ENABLED:'on'}, {AUTO_DRIVER_DISPATCH:'on'}, {BOOKING_URL:'https://edenmish.com'}])assert.equal(await issueContinuationGrant({...e,...patch},now),false);
 assert.equal(await issueContinuationGrant(e,now),true);assert.equal(await issueContinuationGrant(e,now),false);
 assert.equal(await issueContinuationGrant({...e,WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_CONTINUATION_ID+'-new'},now),false);
 assert.equal(grant(e).fee_cushion_micros,500000);assert.equal(historical(e),old);
 for(const patch of [{TWILIO_RECIPIENT_ALLOWLIST:'+972541111111'}, {WHATSAPP_BOOKING_CONTINUATION_START:new Date(now-1).toISOString()}, {WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+1).toISOString()}])assert.equal(await continuationCanProceed({...enable(e),...patch},now),false);
});
test('six serialized interpretations retain all allowances; duplicate keys and seventh call cannot reserve',async()=>{
 const e=await active(),old=historical(e);
 for(let i=0;i<6;i++){
  const key=eventId(i),ids=await Promise.all(Array.from({length:5},()=>reserveContinuation(e,'model',key,now)));
  assert.equal(ids.filter(Boolean).length,1);assert.equal(await reserveContinuation(e,'model',eventId(99),now),null);
  await finishContinuation(e,'model',key,{ok:true,usage},now);await finishContinuation(e,'model',key,{ok:false},now);
  assert.equal(await reserveContinuation(e,'model',key,now),null);assert.equal(grant(e).stopped_reason,null);
 }
 assert.equal(grant(e).model,6);assert.equal(grant(e).model_micros,180000);assert.equal(grant(e).historical_micros+grant(e).model_micros,480000);
 assert.equal(await reserveContinuation(e,'model',eventId(7),now),null);assert.equal(historical(e),old);
});
test('transport quotas, duplicates, fixed cushion and cumulative run cap are enforced before IO',async()=>{
 const e=await active();
 for(const kind of ['inbound','outbound','address']){
  for(let i=0;i<CONTINUATION[kind];i++){
   assert.ok(await reserveContinuation(e,kind,'op'+i,now));
   if(kind!=='inbound')await finishContinuation(e,kind,'op'+i,{ok:true},now);
  }
  assert.equal(await reserveContinuation(e,kind,'overflow',now),null);assert.equal(await reserveContinuation(e,kind,'op0',now),null);
 }
 assert.equal(grant(e).spent_micros,312000);
 e.DB.sqlite.exec('UPDATE whatsapp_continuation_grants SET spent_micros=1190000');
 assert.equal(await reserveContinuation(e,'model',eventId(55),now),null);
 assert.throws(()=>e.DB.sqlite.exec('UPDATE whatsapp_continuation_grants SET spent_micros=1200001'));
});
test('unknown costs, changed history, expiry, operator stop and pending crash all fail closed',async()=>{
 for(const problem of ['cost','history','expiry','stop','crash']){
  const e=await active();
  if(problem==='cost')e.WHATSAPP_BOOKING_CONTINUATION_COSTS_UNKNOWN='on';
  if(problem==='history')e.DB.sqlite.exec('UPDATE whatsapp_pilot_budgets SET updated_at=updated_at+1');
  if(problem==='stop')await stopContinuation(e);
  if(problem==='crash')assert.ok(await reserveContinuation(e,'model',eventId(1),now));
  assert.equal(await reserveContinuation(e,'model',eventId(2),problem==='expiry'?now+1800000:now),null);
 }
});
test('uncertain outcomes keep reservation and permanent stop; late success cannot refund or unlock new work',async()=>{
 for(const kind of ['model','outbound','address']){
  const e=await active();assert.ok(await reserveContinuation(e,kind,'one',now));await finishContinuation(e,kind,'one',{ok:false},now);
  const snapshot=JSON.stringify(grant(e));await finishContinuation(e,kind,'one',{ok:true,usage},now+1);assert.equal(JSON.stringify(grant(e)),snapshot);
  assert.equal(await reserveContinuation(e,'model','two',now),null);assert.equal(grant(e).stopped_reason,'provider_uncertain');
 }
});
test('counted model transport uses six unique events, exact payload and caps, no history or customer diagnostics',async()=>{
 const e=await active();let count=0,generation=0;
 for(let n=0;n<6;n++){
  let counted;
  const adapter=createOpenAIBookingModel(e,{clock:()=>now,eventId:eventId(n),fetchImpl:async(url,init)=>{
   const payload=JSON.parse(init.body);assert.equal(init.redirect,'manual');
   if(url.endsWith('/input_tokens')){count++;counted=payload;return Response.json({object:'response.input_tokens',input_tokens:1000});}
   generation++;for(const key of Object.keys(counted))assert.deepEqual(payload[key],counted[key]);assert.equal(payload.max_output_tokens,512);assert.equal(payload.store,false);assert.equal(payload.service_tier,'default');assert.ok(new TextEncoder().encode(init.body).length<=8192);return response();
  }});
  assert.deepEqual((await proposeBookingTurn(adapter,state,'מפתחות',now)).entries,[['size','small'],['notes','מפתחות']]);
  assert.equal(await proposeBookingTurn(adapter,state,'מפתחות',now),null);
 }
 assert.equal(count,6);assert.equal(generation,6);assert.equal(grant(e).model_micros,180000);
});
for(const scenario of ['count_error','count_large','count_unknown','count_transport','expired_after_count','stop_after_count','generation_error','usage_mismatch','malformed','abort','late_response'])test('bounded model fails closed: '+scenario,async()=>{
 const e=await active();let calls=0,clock=now;
 const adapter=createOpenAIBookingModel(e,{clock:()=>clock,eventId:eventId(1),fetchImpl:async(url,init)=>{
  calls++;
  if(url.endsWith('/input_tokens')){
   if(scenario==='count_transport')throw new Error('private provider failure');
   if(scenario==='count_error')return new Response('',{status:503});
   if(scenario==='expired_after_count')clock=now+1800000;
   if(scenario==='stop_after_count')await stopContinuation(e);
   return Response.json({object:'response.input_tokens',input_tokens:scenario==='count_large'?4097:scenario==='count_unknown'?null:1000});
  }
  if(scenario==='generation_error')return new Response('',{status:429});
  if(scenario==='abort')throw new Error('uncertain transport');
  if(scenario==='late_response')clock=now+1800000;
  const result=await response().json();if(scenario==='usage_mismatch')result.usage.input_tokens=999;if(scenario==='malformed')delete result.output;
  return Response.json(result);
 }});
 assert.equal(await proposeBookingTurn(adapter,state,'מפתחות',now),null);assert.equal(grant(e).model_micros,30000);assert.ok(grant(e).stopped_reason);
 const total=calls;await proposeBookingTurn(adapter,state,'מפתחות',now);assert.equal(calls,total);
 assert.equal(calls,scenario.startsWith('count_')||scenario.endsWith('_after_count')?1:2);
});
test('old migration replay and data retention cannot reopen a grant or its operations',async()=>{
 const e=await active();assert.ok(await reserveContinuation(e,'model','crashed',now));
 e.DB.sqlite.exec(readFileSync(new URL('../migrations/041_whatsapp_continuation_grant.sql',import.meta.url),'utf8'));
 assert.equal(grant(e).model_micros,30000);assert.equal(await reserveContinuation(e,'model','crashed',now),null);
 assert.equal(await issueContinuationGrant({...e,WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off'},now),false);
});

test('pending transport crash serializes further IO, keeps its cost and never auto-retries',async()=>{
 const e=await active();const ids=await Promise.all(Array.from({length:8},(_,i)=>reserveContinuation(e,'outbound','send'+i,now)));
 assert.equal(ids.filter(Boolean).length,1);assert.equal(grant(e).outbound,1);assert.equal(grant(e).spent_micros,11300);
 assert.equal(await reserveContinuation(e,'address','lookup',now),null);assert.equal(await reserveContinuation(e,'model',eventId(1),now),null);
});
test('conversation event and reply replay are idempotent, operator Pause stops the grant, and no downstream writes occur',async()=>{
 const e=await active();const service={create:()=>assert.fail('order creation forbidden'),order:async()=>null};
 const event={id:'SM'+'a'.repeat(32),phone:e.TWILIO_RECIPIENT_ALLOWLIST,at:now,text:'שלום'};
 assert.equal((await processBookingEvent(e,event,service,now)).processed,true);
 assert.equal((await processBookingEvent(e,event,service,now)).duplicate,true);assert.equal(grant(e).inbound,1);
 let sends=0;await sendBookingReplies(e,async()=>{sends++;return Response.json({sid:'SM'+'b'.repeat(32)});},now);
 await sendBookingReplies(e,()=>assert.fail('duplicate send'),now);assert.equal(sends,1);assert.equal(grant(e).outbound,1);
 const row=e.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();assert.equal(JSON.parse(row.state_json).continuation_id,e.WHATSAPP_BOOKING_CONTINUATION_ID);
 assert.equal((await pauseBooking(e.DB,row.id,now,e)).status,200);assert.equal(grant(e).stopped_reason,'operator_stop');
 assert.equal((await processBookingEvent(e,{...event,id:'new-event',at:now+1},service,now+1)).disabled,true);
 for(const table of ['orders','payments','notifications','driver_assignments','driver_routes'])assert.equal(e.DB.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
test('model factory receives a server-owned event digest, and existing pilot replies cannot escape into continuation',async()=>{
 const e=await active();let key;
 const service={conversationModelForEvent:id=>{key=id;return undefined;},create:()=>assert.fail('order'),order:async()=>null};
 await processBookingEvent(e,{id:'SM'+'c'.repeat(32),phone:e.TWILIO_RECIPIENT_ALLOWLIST,at:now,text:'hello'},service,now);
 assert.match(key,/^[a-f0-9]{64}$/);assert.notEqual(key,'SM'+'c'.repeat(32));
 e.DB.sqlite.exec("UPDATE whatsapp_booking_conversations SET state_json=json_remove(state_json,'$.continuation_id')");
 await sendBookingReplies(e,()=>assert.fail('old unscoped draft send'),now);assert.equal(grant(e).outbound,0);
});
test('expired reservation after asynchronous count cannot generate or release its full allowance',async()=>{
 const e=await active(),id=eventId(88);let calls=0;
 const adapter=createOpenAIBookingModel(e,{clock:()=>now,eventId:id,fetchImpl:async()=>{calls++;await stopContinuation(e,'cost_unknown');return Response.json({object:'response.input_tokens',input_tokens:1000});}});
 assert.equal(await proposeBookingTurn(adapter,state,'מפתחות',now),null);assert.equal(calls,1);assert.equal(grant(e).model_micros,30000);assert.equal(grant(e).stopped_reason,'cost_unknown');
});

test('migration validator rejects partial or weakened constraints without repairing them',async()=>{
 const {continuationSchemaReady,CONTINUATION_SCHEMA_SQL}=await import('../scripts/validate-continuation-schema.mjs');
 const e=await prepared(),rows=e.DB.sqlite.prepare(CONTINUATION_SCHEMA_SQL).all();assert.equal(continuationSchemaReady(rows),true);
 assert.equal(continuationSchemaReady(rows.slice(1)),false);assert.equal(continuationSchemaReady([...rows,rows[0]]),false);
 assert.equal(continuationSchemaReady(rows.map(r=>({...r,sql:r.sql.replace('2000000','3000000')}))),false);
});

test('OFF-state operator page offers one explicit grant action, with no auto issuance or customer activation',async t=>{
 const {bookingPilotOpsPage}=await import('../src/whatsapp-booking-ops.js');
 t.mock.timers.enable({apis:['Date'],now});const e=await prepared();
 const html=await bookingPilotOpsPage(new Request('https://ops-staging.edenmish.com/pilot-ops'),e).text();
 assert.doesNotThrow(()=>new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
 assert.match(html,/id="issue-grant" disabled/);assert.match(html,/localStorage.setItem\('edenmish-grant:'/);
 assert.match(html,/grant_id:grantConfig.id,version:grantConfig.version/);assert.match(html,/const readinessConfig = null/);
 assert.equal(e.DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_grants').get().n,0);
 const disabled=await bookingPilotOpsPage(new Request('https://ops-staging.edenmish.com/pilot-ops'),{...e,WHATSAPP_BOOKING_CONTINUATION_APPROVED:'off'}).text();assert.match(disabled,/const grantConfig = null/);
});

test('abort during a count response that ignores the signal cannot generate or release the reservation',async()=>{
 const {BOOKING_MODEL_INSTRUCTIONS,BOOKING_PROPOSAL_SCHEMA}=await import('../src/whatsapp-booking-model.js');
 const e=await active(),controller=new AbortController();let calls=0;
 const adapter=createOpenAIBookingModel(e,{clock:()=>now,eventId:eventId(9),fetchImpl:async()=>{calls++;controller.abort();return Response.json({object:'response.input_tokens',input_tokens:1000});}});
 const result=await adapter.propose({customer_message:'מפתחות',context:{phase:'collect'},approved_facts:{},instructions:BOOKING_MODEL_INSTRUCTIONS,schema:BOOKING_PROPOSAL_SCHEMA},{signal:controller.signal});
 assert.equal(result,null);assert.equal(calls,1);assert.equal(grant(e).model_micros,30000);assert.equal(grant(e).stopped_reason,'provider_uncertain');
});
test('selected continuation cannot escape its gates by changing mode to full or dropping it',async()=>{
 const {bookingPilotReady}=await import('../src/whatsapp-booking-pilot.js');const e=await active();
 for(const mode of ['full',undefined,'unknown'])assert.equal(bookingPilotReady({...e,WHATSAPP_BOOKING_MODE:mode},now),false);
});
test('failed delivery receipt stops the grant permanently and preserves transport allowance',async()=>{
 const {reconcileTwilioBookingReceipts}=await import('../src/whatsapp-booking-twilio.js');const e=await active();
 await processBookingEvent(e,{id:'SM'+'d'.repeat(32),phone:e.TWILIO_RECIPIENT_ALLOWLIST,at:now,text:'שלום'},{order:async()=>null},now);
 const sid='SM'+'e'.repeat(32);await sendBookingReplies(e,async()=>Response.json({sid}),now);
 e.DB.sqlite.prepare('INSERT INTO whatsapp_booking_receipts(provider_ref,rank,applied_rank,created_at) VALUES(?,1,0,?)').run(sid,now);
 await reconcileTwilioBookingReceipts(e);assert.equal(grant(e).stopped_reason,'provider_uncertain');assert.equal(grant(e).outbound,1);
 e.DB.sqlite.prepare('UPDATE whatsapp_booking_receipts SET rank=3').run();await reconcileTwilioBookingReceipts(e);assert.equal(grant(e).stopped_reason,'provider_uncertain');
});

const later=now+3600000;
async function followonPrepared(){
 const e=await prepared();assert.equal(await issueContinuationGrant(e,now),true);
 return {...e,WHATSAPP_BOOKING_CONTINUATION_VERSION:'2',WHATSAPP_BOOKING_CONTINUATION_FOLLOWON_SCHEMA_READY:'on',
  WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-2',
  WHATSAPP_BOOKING_CONTINUATION_START:new Date(later).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(later+1800000).toISOString()};
}
const priorSnapshot=e=>JSON.stringify(e.DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_grants').all());
const followonGrant=e=>e.DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_followon_grants').get();
test('follow-on grants require an unused expired predecessor and exact separately approved version',async()=>{
 for(const problem of ['missing','active','spent','operation','stopped','lock','history','schema','id','version']){
  const e=await followonPrepared();
  if(problem==='missing')e.DB.sqlite.exec('DELETE FROM whatsapp_continuation_grants');
  if(problem==='active')e.DB.sqlite.exec('UPDATE whatsapp_continuation_grants SET starts_at=starts_at+3600000,expires_at=expires_at+3600000');
  if(problem==='spent')e.DB.sqlite.exec('UPDATE whatsapp_continuation_grants SET spent_micros=10300,inbound=1');
  if(problem==='operation')e.DB.sqlite.exec("INSERT INTO whatsapp_continuation_operations(id,grant_id,kind,status,reserved_micros,created_at) SELECT 'orphan',id,'inbound','settled',10300,1 FROM whatsapp_continuation_grants");
  if(problem==='stopped')e.DB.sqlite.exec("UPDATE whatsapp_continuation_grants SET stopped_reason='provider_uncertain'");
  if(problem==='lock')e.DB.sqlite.exec("UPDATE whatsapp_continuation_grants SET lock_id='pending'");
  if(problem==='history')e.DB.sqlite.exec("UPDATE whatsapp_continuation_grants SET history_hash='changed'");
  if(problem==='schema')e.WHATSAPP_BOOKING_CONTINUATION_FOLLOWON_SCHEMA_READY='off';
  if(problem==='id')e.WHATSAPP_BOOKING_CONTINUATION_ID+='-new';
  if(problem==='version')e.WHATSAPP_BOOKING_CONTINUATION_VERSION='3';
  assert.equal(await issueContinuationGrant(e,later),false,problem);
 }
});
test('follow-on issuance is one-shot; predecessor, history and original holds remain immutable',async()=>{
 const e=await followonPrepared(),before=priorSnapshot(e),old=historical(e);
 const issues=await Promise.all([issueContinuationGrant(e,later),issueContinuationGrant(e,later)]);assert.equal(issues.filter(Boolean).length,1);
 assert.equal(followonGrant(e).version,2);assert.equal(await issueContinuationGrant(e,later),false);
 assert.equal(await continuationCanProceed(enable(e),later),true);
 for(const sql of ['UPDATE whatsapp_continuation_grants SET spent_micros=1','DELETE FROM whatsapp_continuation_grants',"INSERT INTO whatsapp_continuation_operations(id,grant_id,kind,status,reserved_micros,created_at) SELECT 'race',id,'inbound','settled',1,1 FROM whatsapp_continuation_grants"])
  assert.throws(()=>e.DB.sqlite.exec(sql),/predecessor retained/);
 e.DB.sqlite.exec(readFileSync(new URL('../migrations/042_whatsapp_continuation_followon.sql',import.meta.url),'utf8'));
 assert.equal(priorSnapshot(e),before);assert.equal(historical(e),old);
 assert.equal(await continuationCanProceed({...enable(e),WHATSAPP_BOOKING_CONTINUATION_END:new Date(later+1800001).toISOString()},later),false);
 assert.equal(await continuationCanProceed(enable(e),later+1800000),false);
});
test('follow-on retains original cumulative envelope and all per-window quotas without retries',async()=>{
 const off=await followonPrepared(),before=priorSnapshot(off),old=historical(off);assert.equal(await issueContinuationGrant(off,later),true);const e=enable(off);
 for(const kind of ['inbound','outbound','address','model']){
  for(let i=0;i<CONTINUATION[kind];i++){
   const ids=await Promise.all(Array.from({length:4},()=>reserveContinuation(e,kind,'key'+i,later)));assert.equal(ids.filter(Boolean).length,1);
   if(kind!=='inbound')await finishContinuation(e,kind,'key'+i,{ok:true,usage},later);
   assert.equal(await reserveContinuation(e,kind,'key'+i,later),null);
  }
  assert.equal(await reserveContinuation(e,kind,'overflow',later),null);
 }
 const g=followonGrant(e);assert.equal(g.spent_micros,492000);assert.equal(g.model_micros+g.historical_micros,480000);
 assert.equal(g.spent_micros+g.historical_micros+g.fee_cushion_micros,1292000);
 assert.equal(priorSnapshot(e),before);assert.equal(historical(e),old);
});
test('follow-on provider uncertainty or operator stop cannot reopen or refund its grant',async()=>{
 for(const mode of ['uncertain','stop','expiry','history']){
  const off=await followonPrepared();assert.equal(await issueContinuationGrant(off,later),true);const e=enable(off);
  assert.ok(await reserveContinuation(e,'model','one',later));
  if(mode==='stop')await stopContinuation(e);
  if(mode==='history')e.DB.sqlite.exec('UPDATE whatsapp_pilot_budgets SET updated_at=updated_at+1');
  await finishContinuation(e,'model','one',{ok:mode!=='uncertain',usage},mode==='expiry'?later+1800000:later);
  assert.equal(followonGrant(e).model_micros,30000);assert.ok(followonGrant(e).stopped_reason);
  assert.equal(await reserveContinuation(e,'model','two',later),null);assert.equal(await issueContinuationGrant(off,later),false);
 }
});
test('follow-on schema validation includes every atomic predecessor guard and rejects weakened schemas',async()=>{
 const {followonSchemaReady,FOLLOWON_SCHEMA_SQL}=await import('../scripts/validate-continuation-followon-schema.mjs');
 const e=await prepared(),rows=e.DB.sqlite.prepare(FOLLOWON_SCHEMA_SQL).all();assert.equal(rows.length,7);assert.equal(followonSchemaReady(rows),true);
 assert.equal(followonSchemaReady(rows.filter(r=>!r.name.includes('unused_predecessor'))),false);
 assert.equal(followonSchemaReady(rows.map(r=>({...r,sql:r.sql.replace('p.spent_micros=0','p.spent_micros>=0')}))),false);
});
test('v2 Ops page supplies version two and stays OFF until separate activation',async t=>{
 const {bookingPilotOpsPage}=await import('../src/whatsapp-booking-ops.js');t.mock.timers.enable({apis:['Date'],now:later});const e=await followonPrepared();
 const html=await bookingPilotOpsPage(new Request('https://ops-staging.edenmish.com/pilot-ops'),e).text();
 assert.doesNotThrow(()=>new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
 assert.match(html,/"version":2/);assert.match(html,/version:grantConfig.version/);
 assert.equal(followonGrant(e),undefined);assert.equal(await continuationCanProceed(e,later),false);
});

// Synthetic exchange only: no customer transcript or external provider calls.
async function failedNoticeFixture(policy=true,version=1){
 const base=version===3?thirdTime:now;let e=version===3?await retryPrepared():await prepared();if(policy)e.WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY='one-shot-v1';
 assert.equal(await issueContinuationGrant(e,base),true);e=enable(e);
 let modelCalls=0,sends=0;
 const service={order:async()=>null,resolveAddress:async()=>({error:'address_not_found'}),create:()=>assert.fail('orders prohibited'),
  conversationModelForEvent:id=>createOpenAIBookingModel(e,{clock:()=>base,eventId:id,fetchImpl:async url=>{
   modelCalls++;return url.endsWith('/input_tokens')?Response.json({object:'response.input_tokens',input_tokens:1000}):new Response('',{status:503});
  }})};
 for(const [i,text] of ['שלום','1','1','אבקש לבדוק אפשרות למשלוח מסמכים בהמשך השבוע'].entries()){
  await processBookingEvent(e,{id:'synthetic-notice-'+i,phone:e.TWILIO_RECIPIENT_ALLOWLIST,at:base+i,text},service,base+i);
  if(i<3)await sendBookingReplies(e,async()=>{sends++;return Response.json({sid:'SM'+String(i+1).repeat(32)});},base+i);
 }
 assert.equal(modelCalls,2);assert.equal(sends,3);
 const reply=e.DB.sqlite.prepare("SELECT * FROM whatsapp_booking_replies WHERE state='pending'").get();assert.ok(reply);
 return {e,reply,service};
}
test('default remains fail-closed; policy cannot be retrofitted onto an issued grant',async()=>{
 const {e,reply}=await failedNoticeFixture(false);assert.equal(grant(e).stopped_reason,'provider_uncertain');
 assert.equal(await continuationCanProceed({...e,WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY:'one-shot-v1'},now),false);
 await sendBookingReplies(e,()=>assert.fail('legacy stopped send'),now+4);
 assert.equal(e.DB.sqlite.prepare('SELECT state FROM whatsapp_booking_replies WHERE id=?').get(reply.id).state,'cancelled');
});
test('model failure allows exactly one fixed budgeted notice, never restarts conversation or downstream work',async()=>{
 const {e,reply,service}=await failedNoticeFixture();const before=grant(e);assert.equal(before.stopped_reason,'model_uncertain');
 assert.equal(reply.kind,'model_failure_notice');let sends=0;
 await Promise.all(Array.from({length:4},()=>sendBookingReplies(e,async(url,init)=>{
  sends++;assert.equal(new URLSearchParams(init.body).get('Body'),'לא הצלחתי לעבד את הפרטים. האוטומציה נעצרה. אפשר לפנות לנציג להמשך.');
  return Response.json({sid:'SM'+'9'.repeat(32)});
 },now+4)));
 assert.equal(sends,1);assert.equal(grant(e).outbound,4);assert.equal(grant(e).spent_micros,before.spent_micros+11300);
 assert.equal(grant(e).stopped_reason,'model_uncertain');assert.equal(grant(e).lock_id,null);
 assert.equal(await continuationCanProceed(e,now+5),false);
 for(const kind of ['model','address','inbound','outbound'])assert.equal(await reserveContinuation(e,kind,'after-stop',now+5),null);
 await sendBookingReplies(e,()=>assert.fail('notice retry'),now+5);
 await processBookingEvent(e,{id:'after-failure',phone:e.TWILIO_RECIPIENT_ALLOWLIST,at:now+5,text:'1'},service,now+5);
 assert.equal(grant(e).inbound,4);
 const op=e.DB.sqlite.prepare("SELECT * FROM whatsapp_continuation_operations WHERE id LIKE '%:outbound:failure-notice'").get();assert.equal(op.outcome,'notice_sent');
 for(const table of ['orders','payments','notifications','driver_assignments','driver_routes'])assert.equal(e.DB.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
for(const problem of ['quota','budget','expired','late','off','operator','receipt','body','recipient','grant','model','policy','json'])test('failure notice rejects '+problem,async()=>{
 const {e,reply}=await failedNoticeFixture();let clock=now+4;
 if(problem==='quota')e.DB.sqlite.exec('UPDATE whatsapp_continuation_grants SET outbound=10');
 if(problem==='budget')e.DB.sqlite.exec('UPDATE whatsapp_continuation_grants SET spent_micros=1190000');
 if(problem==='expired')clock=now+1800000;
 if(problem==='late')clock=now+15001;
 if(problem==='off')e.WHATSAPP_BOOKING_SEND_ENABLED='off';
 if(problem==='operator')await stopContinuation(e);
 if(problem==='receipt')await stopContinuation(e,'provider_uncertain');
 if(problem==='body')e.DB.sqlite.prepare('UPDATE whatsapp_booking_replies SET body=? WHERE id=?').run('arbitrary content',reply.id);
 if(problem==='recipient')e.DB.sqlite.exec("UPDATE whatsapp_booking_conversations SET recipient='+972549999999'");
 if(problem==='grant')e.DB.sqlite.exec("UPDATE whatsapp_booking_conversations SET state_json=json_set(state_json,'$.continuation_id','other')");
 if(problem==='model')e.DB.sqlite.exec("UPDATE whatsapp_continuation_operations SET status='settled' WHERE kind='model'");
 if(problem==='policy')e.WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY='off';
 if(problem==='json')e.DB.sqlite.exec("UPDATE whatsapp_booking_conversations SET state_json='null'");
 const before=grant(e).spent_micros;
 await sendBookingReplies(e,()=>assert.fail('forbidden send '+problem),clock);
 assert.equal(grant(e).spent_micros,before);assert.ok(grant(e).stopped_reason);
});
test('notice transport uncertainty retains hold and is never retried',async()=>{
 const {e}=await failedNoticeFixture();const before=grant(e).spent_micros;let calls=0;
 await sendBookingReplies(e,async()=>{calls++;throw new Error('synthetic uncertain send');},now+4);
 await sendBookingReplies(e,()=>assert.fail('retry'),now+5);
 assert.equal(calls,1);assert.equal(grant(e).spent_micros,before+11300);assert.ok(grant(e).stopped_reason);
 assert.equal(e.DB.sqlite.prepare("SELECT outcome FROM whatsapp_continuation_operations WHERE id LIKE '%:outbound:failure-notice'").get().outcome,'notice_uncertain');
});
test('notice reservation crash, explicit stop and elapsed time cannot authorize a resend',async()=>{
 const {claimContinuationFailureNotice,continuationFailureNoticeCanSend,finishContinuationFailureNotice}=await import('../src/whatsapp-continuation.js');
 for(const problem of ['crash','stop','elapsed']){
  const {e,reply}=await failedNoticeFixture();e.DB.sqlite.prepare("UPDATE whatsapp_booking_replies SET state='sending' WHERE id=?").run(reply.id);
  assert.equal(await claimContinuationFailureNotice(e,reply.id,now+4),true);
  assert.equal(await claimContinuationFailureNotice(e,reply.id,now+4),false);
  if(problem==='stop')await stopContinuation(e);
  const clock=problem==='elapsed'?now+15004:now+5;
  assert.equal(await continuationFailureNoticeCanSend(e,reply.id,clock),problem==='crash');
  await sendBookingReplies(e,()=>assert.fail('crashed pending notice retry'),clock);
  await finishContinuationFailureNotice(e,reply.id,false,clock);
  await finishContinuationFailureNotice(e,reply.id,true,clock);
  assert.equal(await claimContinuationFailureNotice(e,reply.id,clock),false);
  assert.equal(e.DB.sqlite.prepare("SELECT outcome FROM whatsapp_continuation_operations WHERE id LIKE '%:outbound:failure-notice'").get().outcome,'notice_uncertain');
 }
});
test('continuation failure diagnostics persist only bounded categories and numbers',async()=>{
 const {e}=await failedNoticeFixture();const row=e.DB.sqlite.prepare("SELECT outcome FROM whatsapp_continuation_operations WHERE kind='model'").get();
 assert.deepEqual(JSON.parse(row.outcome),{category:'http_error',http_status:503,elapsed_ms:0,counted_input_tokens:1000,output_tokens:null});
 const f=await active();await reserveContinuation(f,'model','sanitizer',now);
 await finishContinuation(f,'model','sanitizer',{diagnostic:{category:'timeout',httpStatus:999,elapsedMs:-1,countedInput:'private input',outputTokens:Infinity,secret:'NEVER_PERSIST',body:'customer text'}},now);
 const value=f.DB.sqlite.prepare("SELECT outcome FROM whatsapp_continuation_operations WHERE kind='model'").get().outcome;
 assert.deepEqual(JSON.parse(value),{category:'timeout',http_status:null,elapsed_ms:null,counted_input_tokens:null,output_tokens:null});assert.doesNotMatch(value,/NEVER_PERSIST|customer text|private input/);
});

const thirdTime=later+3600000;
async function retryPrepared(){
 const e=await followonPrepared();assert.equal(await issueContinuationGrant(e,later),true);const on=enable(e);
 for(let i=0;i<4;i++)assert.ok(await reserveContinuation(on,'inbound','old-inbound-'+i,later));
 for(let i=0;i<3;i++){assert.ok(await reserveContinuation(on,'outbound','old-outbound-'+i,later));await finishContinuation(on,'outbound','old-outbound-'+i,{ok:true},later);}
 assert.ok(await reserveContinuation(on,'model','old-model',later));await finishContinuation(on,'model','old-model',{ok:false},later);
 return {...e,WHATSAPP_BOOKING_CONTINUATION_VERSION:'3',WHATSAPP_BOOKING_CONTINUATION_RETRY_SCHEMA_READY:'on',WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY:'one-shot-v1',
  WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-3',
  WHATSAPP_BOOKING_CONTINUATION_START:new Date(thirdTime).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(thirdTime+1800000).toISOString()};
}
const retryGrant=e=>e.DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_retry_grants').get();
const retryHistory=e=>JSON.stringify([historical(e),priorSnapshot(e),e.DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_followon_grants').all(),e.DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_followon_operations ORDER BY id').all()]);
test('third grant carries every old hold once and permits only five more interpretations',async()=>{
 const e=await retryPrepared(),before=retryHistory(e);assert.equal(await issueContinuationGrant(e,thirdTime),true);
 const on=enable(e);assert.equal(retryGrant(e).historical_micros,405100);assert.equal(retryGrant(e).historical_model_micros,330000);
 assert.equal(retryGrant(e).fee_cushion_micros,500000);assert.equal(await continuationCanProceed(on,thirdTime),true);
 for(let i=0;i<5;i++){assert.ok(await reserveContinuation(on,'model','new-'+i,thirdTime));await finishContinuation(on,'model','new-'+i,{ok:true,usage},thirdTime);}
 assert.equal(await reserveContinuation(on,'model','sixth',thirdTime),null);assert.equal(retryGrant(e).model_micros,150000);
 assert.equal(await issueContinuationGrant(e,thirdTime),false);assert.equal(retryHistory(e),before);
 assert.equal(await issueContinuationGrant({...e,WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_CONTINUATION_ID+'-again'},thirdTime),false);
 assert.equal(await continuationCanProceed({...on,WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY:'off'},thirdTime),false);
});
for(const problem of ['active','missing','lock','stop','spend','model_hold','count','operation','policy','schema','version'])test('third grant rejects altered predecessor or missing approval: '+problem,async()=>{
 const e=await retryPrepared();
 if(problem==='active')e.DB.sqlite.exec('UPDATE whatsapp_continuation_followon_grants SET starts_at=starts_at+3600000,expires_at=expires_at+3600000');
 if(problem==='missing')e.DB.sqlite.exec('DELETE FROM whatsapp_continuation_followon_operations; DELETE FROM whatsapp_continuation_followon_grants');
 if(problem==='lock')e.DB.sqlite.exec("UPDATE whatsapp_continuation_followon_grants SET lock_id='uncertain'");
 if(problem==='stop')e.DB.sqlite.exec("UPDATE whatsapp_continuation_followon_grants SET stopped_reason='operator_stop'");
 if(problem==='spend')e.DB.sqlite.exec('UPDATE whatsapp_continuation_followon_grants SET spent_micros=105101');
 if(problem==='model_hold')e.DB.sqlite.exec('UPDATE whatsapp_continuation_followon_grants SET model_micros=30001');
 if(problem==='count')e.DB.sqlite.exec('UPDATE whatsapp_continuation_followon_grants SET inbound=5');
 if(problem==='operation')e.DB.sqlite.exec("UPDATE whatsapp_continuation_followon_operations SET status='pending' WHERE kind='model'");
 if(problem==='policy')e.WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY='off';
 if(problem==='schema')e.WHATSAPP_BOOKING_CONTINUATION_RETRY_SCHEMA_READY='off';
 if(problem==='version')e.WHATSAPP_BOOKING_CONTINUATION_VERSION='4';
 assert.equal(await issueContinuationGrant(e,thirdTime),false);
});
test('third grant atomic issuance freezes predecessor grants and every operation mutation',async()=>{
 const e=await retryPrepared();const result=await Promise.all([issueContinuationGrant(e,thirdTime),issueContinuationGrant(e,thirdTime)]);assert.equal(result.filter(Boolean).length,1);
 for(const sql of ['UPDATE whatsapp_continuation_followon_grants SET spent_micros=0','DELETE FROM whatsapp_continuation_followon_grants',
  "UPDATE whatsapp_continuation_followon_operations SET outcome='refunded'",'DELETE FROM whatsapp_continuation_followon_operations',
  "INSERT INTO whatsapp_continuation_followon_operations(id,grant_id,kind,status,reserved_micros,created_at) SELECT 'race',id,'inbound','settled',10300,1 FROM whatsapp_continuation_followon_grants"])
  assert.throws(()=>e.DB.sqlite.exec(sql),/predecessor retained/);
 const before=retryHistory(e);e.DB.sqlite.exec(readFileSync(new URL('../migrations/043_whatsapp_continuation_retry.sql',import.meta.url),'utf8'));assert.equal(retryHistory(e),before);
 const {RETRY_SCHEMA_SQL,retrySchemaReady}=await import('../scripts/validate-continuation-retry-schema.mjs');
 const rows=e.DB.sqlite.prepare(RETRY_SCHEMA_SQL).all();assert.equal(retrySchemaReady(rows),true);assert.equal(retrySchemaReady(rows.slice(1)),false);
 assert.equal(retrySchemaReady(rows.map(r=>({...r,sql:r.sql.replace('405100','300000')}))),false);
});
test('third grant preserves $0.9051 baseline and refuses IO above original $2 cap',async()=>{
 const e=await retryPrepared();await issueContinuationGrant(e,thirdTime);const on=enable(e);
 e.DB.sqlite.exec('UPDATE whatsapp_continuation_retry_grants SET spent_micros=1084900');
 assert.equal(await reserveContinuation(on,'outbound','over',thirdTime),null);
 assert.throws(()=>e.DB.sqlite.exec('UPDATE whatsapp_continuation_retry_grants SET spent_micros=1094901'));
 assert.equal(await reserveContinuation(on,'inbound','expired',thirdTime+1800000),null);
});

test('third-window fixed notice spends only new allowance with prior holds unchanged',async()=>{
 const {e}=await failedNoticeFixture(true,3);const prior=retryHistory(e);let calls=0;
 await sendBookingReplies(e,async()=>{calls++;return Response.json({sid:'SM'+'8'.repeat(32)});},thirdTime+4);
 assert.equal(calls,1);const g=retryGrant(e);assert.equal(g.stopped_reason,'model_uncertain');assert.equal(g.spent_micros,116400);
 assert.equal(g.historical_micros+g.fee_cushion_micros+g.spent_micros,1021500);assert.equal(g.historical_model_micros+g.model_micros,360000);
 assert.equal(retryHistory(e),prior);await sendBookingReplies(e,()=>assert.fail('no retry'),thirdTime+5);
});

test('model proposal rejection persists one allowlisted reason, never the quote or provider body',async()=>{
 const e=await active();const adapter=createOpenAIBookingModel(e,{clock:()=>now,eventId:eventId(901),fetchImpl:async url=>{
  if(url.endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:1000});
  const r=await response().json();r.output[0].content[0].text=JSON.stringify({version:2,intent:'update',fields:[{field:'size',quote:'my'}],topic:null,clarify_field:null});return Response.json(r);
 }});
 assert.equal(await proposeBookingTurn(adapter,state,'send my keys',now),null);
 const outcome=e.DB.sqlite.prepare("SELECT outcome FROM whatsapp_continuation_operations WHERE kind='model'").get().outcome;
 assert.equal(JSON.parse(outcome).proposal_rejection,'size_unsupported');assert.doesNotMatch(outcome,/send my keys|"quote"|"my"/);
 const f=await active();await reserveContinuation(f,'model','untrusted-diagnostic',now);
 await finishContinuation(f,'model','untrusted-diagnostic',{diagnostic:{category:'proposal_schema',proposalRejection:'private raw provider text'}},now);
 assert.equal(JSON.parse(f.DB.sqlite.prepare("SELECT outcome FROM whatsapp_continuation_operations WHERE kind='model'").get().outcome).proposal_rejection,undefined);
});

const solTime=thirdTime+3600000;
async function solPrepared(){
 const e=await retryPrepared();assert.equal(await issueContinuationGrant(e,thirdTime),true);const on=enable(e);
 for(let i=0;i<3;i++){
  assert.ok(await reserveContinuation(on,'inbound','third-in-'+i,thirdTime));
  assert.ok(await reserveContinuation(on,'outbound','third-out-'+i,thirdTime));await finishContinuation(on,'outbound','third-out-'+i,{ok:true},thirdTime);
 }
 assert.ok(await reserveContinuation(on,'model','third-model',thirdTime));await finishContinuation(on,'model','third-model',{ok:false},thirdTime);
 return {...e,WHATSAPP_BOOKING_MODEL:'gpt-6.1-sol',WHATSAPP_BOOKING_REASONING_EFFORT:'low',WHATSAPP_BOOKING_CONTINUATION_VERSION:'4',WHATSAPP_BOOKING_CONTINUATION_SOL_SCHEMA_READY:'on',
  WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-4',WHATSAPP_BOOKING_CONTINUATION_START:new Date(solTime).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(solTime+900000).toISOString()};
}
const solGrant=e=>e.DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_sol_grants').get();
const solUsage={input_tokens:871,output_tokens:98,total_tokens:969,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}};
test('Sol fourth grant preserves stopped history, offline holds, model identity, expiry and all quotas',async()=>{
 const e=await solPrepared(),before=JSON.stringify(retryGrant(e));
 for(const patch of [{WHATSAPP_BOOKING_MODEL:'gpt-6-luna'},{WHATSAPP_BOOKING_REASONING_EFFORT:'medium'},{WHATSAPP_BOOKING_CONTINUATION_SOL_SCHEMA_READY:'off'},{WHATSAPP_BOOKING_CONTINUATION_END:new Date(solTime+900001).toISOString()}])
  assert.equal(await issueContinuationGrant({...e,...patch},solTime),false);
 assert.equal(await issueContinuationGrant(e,solTime),true);assert.equal(await issueContinuationGrant(e,solTime),false);
 assert.equal(solGrant(e).historical_micros,735124);assert.equal(solGrant(e).historical_model_micros,595224);
 assert.throws(()=>e.DB.sqlite.exec('UPDATE whatsapp_continuation_retry_grants SET spent_micros=0'),/predecessor/);
 const on=enable(e);assert.equal(await continuationCanProceed({...on,WHATSAPP_BOOKING_REASONING_EFFORT:'medium'},solTime),false);
 for(const [kind,max] of [['inbound',12],['outbound',12],['address',3],['model',4]]){
  for(let i=0;i<max;i++){
   const key=eventId(i);assert.ok(await reserveContinuation(on,kind,key,solTime));
   assert.equal(await reserveContinuation(on,kind,key,solTime),null);
   if(kind!=='inbound')await finishContinuation(on,kind,key,{ok:true,usage:solUsage},solTime);
  }
  assert.equal(await reserveContinuation(on,kind,'overflow',solTime),null);
 }
 assert.equal(solGrant(e).spent_micros,580480);assert.equal(solGrant(e).model_micros,225280);
 assert.equal(await continuationCanProceed(on,solTime+900000),false);assert.equal(JSON.stringify(retryGrant(e)),before);
});
test('Sol live adapter pins low, no counting, four serialized calls and retains item notes',async()=>{
 const e=await solPrepared();assert.equal(await issueContinuationGrant(e,solTime),true);const on=enable(e);let calls=0;
 for(let i=0;i<5;i++){
  const adapter=createOpenAIBookingModel(on,{clock:()=>solTime,eventId:eventId(i),fetchImpl:async(url,init)=>{
   calls++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(init.body);
   assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'low');assert.equal(body.max_output_tokens,1024);assert.equal(body.store,false);assert.equal(body.service_tier,'default');
   assert.equal(solGrant(e).model_micros,calls*56320);
   const result=await response().json();result.model='gpt-6.1-sol';result.usage=solUsage;return Response.json(result);
  }});
  const p=await proposeBookingTurn(adapter,state,'מפתחות',solTime);
  if(i<4)assert.deepEqual(p.entries,[['size','small'],['notes','מפתחות']]);else assert.equal(p,null);
 }
 assert.equal(calls,4);
});
test('Sol incomplete, unverified usage, wrong model and transport failure retain the hold and stop',async()=>{
 for(const kind of ['incomplete','usage','model','transport']){
  const e=await solPrepared();assert.equal(await issueContinuationGrant(e,solTime),true);let calls=0;
  const on=enable(e),adapter=createOpenAIBookingModel(on,{clock:()=>solTime,eventId:eventId(1),fetchImpl:async()=>{
   calls++;if(kind==='transport')throw new Error('synthetic');const r=await response().json();r.model=kind==='model'?'gpt-6-luna':'gpt-6.1-sol';r.usage=kind==='usage'?{...solUsage,input_tokens:17000}:solUsage;if(kind==='incomplete')r.status='incomplete';return Response.json(r);
  }});
  assert.equal(await proposeBookingTurn(adapter,state,'מפתחות',solTime),null);assert.equal(calls,1);assert.equal(solGrant(e).model_micros,56320);assert.equal(solGrant(e).stopped_reason,'model_uncertain');
  assert.equal(await reserveContinuation(on,'model','again',solTime),null);
 }
});
