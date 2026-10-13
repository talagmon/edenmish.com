import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { LUNA_PILOT_LIMITS, lunaPilotCanRun, reserveLunaPilotModel, finishLunaPilotModel,
  ensureLunaPilotBudget, lunaUsageUpperMicros } from '../src/whatsapp-pilot-budget.js';
import { reservePilotOperation, bookingPilotReady } from '../src/whatsapp-booking-pilot.js';
import { createOpenAIBookingModel } from '../src/whatsapp-booking-openai.js';
import { proposeBookingTurn } from '../src/whatsapp-booking-model.js';
import { runRetentionCleanup } from '../src/db.js';
const now=Date.parse('2026-10-09T06:00:00Z');
const databases=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function database() {
 const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
 sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 let queue=Promise.resolve();
 return {sqlite,prepare(sql){const s=sqlite.prepare(sql);let values=[];return {
  bind(...v){values=v;return this;},async first(){return s.get(...values)||null;},async all(){return {results:s.all(...values)};},async run(){return {meta:{changes:Number(s.run(...values).changes)}};}
 };},batch(statements){const operation=queue.then(async()=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}});queue=operation.catch(()=>{});return operation;}};
}
function env(DB=database()) {return {DB,BOOKING_URL:'https://staging.edenmish.com',WHATSAPP_BOOKING_MODE:'conversation_only',
 WHATSAPP_BOOKING_PILOT_PROFILE:'luna-v1',WHATSAPP_BOOKING_PILOT_BUDGET_READY:'on',
 WHATSAPP_BOOKING_PROVIDER:'twilio',AUTO_DRIVER_DISPATCH:'off',TWILIO_RECIPIENT_POLICY:'allowlist',
 TWILIO_RECIPIENT_ALLOWLIST:'+972541234567',TWILIO_BOOKING_FROM:'whatsapp:+15551234567',TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),
 WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on',
 WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',
 WHATSAPP_BOOKING_MODEL:'gpt-6-luna',WHATSAPP_BOOKING_OPENAI_API_KEY:'sk-synthetic-test-only',
 WHATSAPP_BOOKING_PILOT_ID:'edenmish-luna-synthetic-one',WHATSAPP_BOOKING_PILOT_STARTED_AT:new Date(now).toISOString(),
 WHATSAPP_BOOKING_PILOT_EXPIRES_AT:new Date(now+3600000).toISOString()};}
const state={phase:'collect',consent_at:1,data:{},language:'en'};
const text='keys';
const raw={version:2,intent:'update',fields:[{field:'size',quote:'keys'}],topic:null,clarify_field:null};
const usage={input_tokens:1000,output_tokens:100,total_tokens:1100};
const response=(changes={})=>Response.json({model:'gpt-6-luna',service_tier:'default',status:'completed',usage,
 output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(raw)}]}],...changes});
const row=e=>e.DB.sqlite.prepare('SELECT * FROM whatsapp_pilot_budgets').get();

test('Luna profile requires all gates and an at-most-one-hour window, not rolling expiry',()=>{
 const e=env();assert.equal(bookingPilotReady(e,now),true);
 for(const patch of [{WHATSAPP_BOOKING_PILOT_PROFILE:'unknown'},{WHATSAPP_BOOKING_PILOT_BUDGET_READY:'off'},
  {WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'off'},{WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'off'},
  {WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'off'},{AUTO_DRIVER_DISPATCH:'on'},{BOOKING_URL:'https://edenmish.com'},
  {WHATSAPP_BOOKING_OPENAI_API_KEY:undefined},{WHATSAPP_BOOKING_OPENAI_API_KEY:'invalid'},
  {TWILIO_RECIPIENT_ALLOWLIST:'+972541234567,+972541111111'},
  {WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined},{WHATSAPP_BOOKING_PILOT_ID:'synthetic-pilot-one'},
  {WHATSAPP_BOOKING_PILOT_EXPIRES_AT:new Date(now+3600001).toISOString()}]) assert.equal(bookingPilotReady({...e,...patch},now),false);
 assert.equal(bookingPilotReady(e,now-1),false);assert.equal(bookingPilotReady(e,now+3600000),false);
});
test('first use pins window and binding; redeployment cannot extend time, change recipient or reset counters',async()=>{
 const e=env();assert.ok(await ensureLunaPilotBudget(e,now));
 for(const patch of [{WHATSAPP_BOOKING_PILOT_STARTED_AT:new Date(now+1000).toISOString(),WHATSAPP_BOOKING_PILOT_EXPIRES_AT:new Date(now+3601000).toISOString()},
  {TWILIO_RECIPIENT_ALLOWLIST:'+972541111111'},{TWILIO_BOOKING_FROM:'whatsapp:+15559999999'}]) assert.equal(await ensureLunaPilotBudget({...e,...patch},now+1000),null);
 const choices=await Promise.all(Array.from({length:35},()=>reservePilotOperation(e,'inbound',now)));
 assert.equal(choices.filter(Boolean).length,24);
 for(let i=0;i<8;i++)assert.equal(await reservePilotOperation(e,'address',now),true);
 assert.equal(await reservePilotOperation(e,'address',now),false);
 assert.equal(await reservePilotOperation(e,'model',now),false);
 await runRetentionCleanup(e.DB,now+40*86400000);
 assert.equal(e.DB.sqlite.prepare("SELECT count FROM rate_limits WHERE key LIKE '%:inbound'").get().count,24);
 assert.ok(row(e));
});
test('concurrent model reservations serialize; valid usage settles once and all attempts count',async()=>{
 const e=env();const attempts=await Promise.all(Array.from({length:10},()=>reserveLunaPilotModel(e,now)));
 assert.equal(attempts.filter(Boolean).length,1);assert.equal(row(e).charged_micros,300000);
 const id=attempts.find(Boolean);await finishLunaPilotModel(e,id,{outcome:'valid_proposal',usage,elapsedMs:4000},now+1);
 assert.equal(row(e).charged_micros,lunaUsageUpperMicros(usage));
 await finishLunaPilotModel(e,id,{outcome:'timeout',elapsedMs:10000},now+2);
 assert.equal(row(e).stopped_reason,null);assert.equal(row(e).charged_micros,lunaUsageUpperMicros(usage));
 for(let i=1;i<20;i++){const next=await reserveLunaPilotModel(e,now+3);assert.ok(next);await finishLunaPilotModel(e,next,{outcome:'valid_proposal',usage,elapsedMs:1},now+4);}
 assert.equal(await reserveLunaPilotModel(e,now+5),null);assert.equal(row(e).attempts,20);
});
test('uncertain reservation survives restart, late completion and retention; no retry or refund',async()=>{
 const e=env(),id=await reserveLunaPilotModel(e,now);
 await finishLunaPilotModel(e,id,{outcome:'timeout',elapsedMs:10000},now+10000);
 assert.equal(row(e).charged_micros,300000);assert.equal(row(e).stopped_reason,'timeout');
 assert.equal(await reserveLunaPilotModel({...e},now+10001),null);
 await finishLunaPilotModel(e,id,{outcome:'valid_proposal',usage,elapsedMs:11000},now+11000);
 assert.equal(row(e).charged_micros,300000);
 assert.equal(await reservePilotOperation(e,'inbound',now+11000),false);
 assert.equal(await reservePilotOperation(e,'outbound',now+11000),true,'bounded handoff acknowledgement can still be sent');
 await runRetentionCleanup(e.DB,now+40*86400000);assert.equal(row(e).charged_micros,300000);
 const serialized=JSON.stringify(e.DB.sqlite.prepare('SELECT * FROM whatsapp_pilot_model_attempts').all());
 assert.doesNotMatch(serialized,/keys|sk-|customer_message|Authorization/);
});
test('readiness uses same budget before live hour; cannot be called under ordinary or enabled config',async()=>{
 const e=env();const ready={...e,WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
  WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
  WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
 assert.equal(lunaPilotCanRun(e,now,true),false);assert.equal(lunaPilotCanRun({...ready,WHATSAPP_BOOKING_READINESS_APPROVED:'off'},now,true),false);
 const id=await reserveLunaPilotModel(ready,now,true);assert.ok(id);assert.equal(row(e).started_at,null);
 await finishLunaPilotModel(ready,id,{outcome:'valid_proposal',usage,elapsedMs:4100},now+4100);
 const live={...e,WHATSAPP_BOOKING_PILOT_STARTED_AT:new Date(now+600000).toISOString(),WHATSAPP_BOOKING_PILOT_EXPIRES_AT:new Date(now+4200000).toISOString()};
 assert.ok(await reserveLunaPilotModel(live,now+600000));assert.equal(row(e).attempts,2);assert.equal(row(e).charged_micros,400000);
 assert.equal(await reserveLunaPilotModel(ready,now+600000,true),null,'readiness cannot reopen after live window pinned');
});
test('full context upper bound fits reservation; invalid usage and pool shortage fail closed',async()=>{
 assert.equal(lunaUsageUpperMicros({input_tokens:1050000,output_tokens:1024,total_tokens:1051024}),289595);
 for(const invalid of [null,{...usage,input_tokens:-1},{...usage,output_tokens:1025},{...usage,total_tokens:0},{...usage,input_tokens:1050001}])assert.equal(lunaUsageUpperMicros(invalid),null);
 const e=env();let id=await reserveLunaPilotModel(e,now);
 await finishLunaPilotModel(e,id,{outcome:'valid_proposal',usage:{input_tokens:1050000,output_tokens:1024,total_tokens:1051024},elapsedMs:1},now+1);
 assert.equal(await reserveLunaPilotModel(e,now+2),null,'remaining pool cannot cover another full hold');
});
test('model request pins tier, validates usage, ignores optional reasoning and records safe diagnostics',async()=>{
 const e=env(),diagnostics=[];let count=0;
 const adapter=createOpenAIBookingModel(e,{clock:()=>now, onDiagnostic:d=>diagnostics.push(d),fetchImpl:async(_url,init)=>{
  count++;const body=JSON.parse(init.body);assert.equal(body.service_tier,'default');assert.equal(body.max_output_tokens,1024);
  const r=await response().json();r.output.unshift({type:'reasoning',summary:[{text:'private reasoning must not be logged'}]});return Response.json(r);
 }});
 const answer=await proposeBookingTurn(adapter,state,text,now);assert.deepEqual(answer.entries,[['size','small'],['notes','keys']]);
 assert.equal(count,1);assert.equal(row(e).charged_micros,lunaUsageUpperMicros(usage));
 assert.equal(diagnostics[0].outcome,'valid_proposal');assert.doesNotMatch(JSON.stringify(diagnostics),/private|keys|sk-|reasoning/);
});
test('expired awaited reservation never reaches provider; failed usage never yields a proposal',async()=>{
 for(const expired of [true,false]){
  const e=env();let clock=now;let calls=0;const original=e.DB.batch.bind(e.DB);
  if(expired)e.DB.batch=async s=>{const result=await original(s);clock=now+3600000;return result;};
  const adapter=createOpenAIBookingModel(e,{clock:()=>clock,fetchImpl:async()=>{calls++;return response({usage:{...usage,total_tokens:0}});}});
  assert.equal(await proposeBookingTurn(adapter,state,text,now),null);assert.equal(calls,expired?0:1);
  assert.equal(row(e).charged_micros,300000);assert.equal(row(e).stopped_reason,expired?'expired':'usage_unverified');
 }
});
test('pilot accepts response after old 1.5s timeout; 10s abort retains the hold without retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const timeout of [false,true]){
  const e=env();let started;const waiting=new Promise(r=>{started=r;});let calls=0;
  const adapter=createOpenAIBookingModel(e,{clock:()=>now,fetchImpl:async(_url,{signal})=>{calls++;started();return new Promise((resolve,reject)=>{
   if(!timeout)setTimeout(()=>resolve(response()),4100);signal.addEventListener('abort',()=>reject(new Error('secret provider detail')),{once:true});
  });}});
  const pending=proposeBookingTurn(adapter,state,text,now);await waiting;t.mock.timers.tick(timeout?10000:4100);const result=await pending;
  if(timeout){assert.equal(result,null);for(let i=0;i<20;i++)await Promise.resolve();assert.equal(row(e).charged_micros,300000);}
  else assert.equal(result.intent,'update');
  assert.equal(calls,1);
 }
});

test('readiness replay is nonbillable, fixed synthetic-only and consumes the forthcoming live pool',async()=>{
 const {runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
 WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
 WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
 let calls=0;
 const options={clock:()=>now,fetchImpl:async(_url,init)=>{
  if(_url.endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:1000});
  calls++;const message=JSON.parse(JSON.parse(init.body).input[0].content).customer_message;
  assert.equal(message,'I need to send my keys');
  const data=await response().json();data.output[0].content[0].text=JSON.stringify({...raw,fields:[{field:'size',quote:'keys'}]});return Response.json(data);
 }};
 assert.equal((await runLunaPilotReadiness(e,'unknown',options)).status,404);
 const first=await runLunaPilotReadiness(e,'small_item',options);assert.equal(first.report.passed,true);
 const retry=await runLunaPilotReadiness(e,'small_item',options);assert.equal(retry.report.replay,true);assert.equal(calls,1);
 assert.equal(row(e).attempts,1);assert.equal(row(e).started_at,null);assert.equal(row(e).charged_micros,100000);
 assert.doesNotMatch(JSON.stringify(first.report),/I need to send|sk-/);
 assert.equal(retry.report.diagnostic,undefined,'D1 replay does not retain synthetic output');
});

test('readiness semantic mismatch stops the ledger and preserves full reservation',async()=>{
 const {runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
 WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
 WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
 let calls=0;
 const report=await runLunaPilotReadiness(e,'small_item',{clock:()=>now,fetchImpl:async url=>{
  if(url.endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:1000});
  calls++;const data=await response().json();data.output[0].content[0].text=JSON.stringify({...raw,intent:'greeting',fields:[]});return Response.json(data);
 }});
 assert.equal(report.report.outcome,'readiness_mismatch');assert.equal(row(e).charged_micros,100000);assert.equal(calls,1);
 assert.equal(await reserveLunaPilotModel(e,now,true),null);
});

test('migration 040 is additive and schema verification rejects missing or weakened definitions',async()=>{
 const {LUNA_SCHEMA_SQL,lunaPilotSchemaReady}=await import('../scripts/validate-luna-pilot-schema.mjs');
 const e=env();const rows=e.DB.sqlite.prepare(LUNA_SCHEMA_SQL).all();assert.equal(lunaPilotSchemaReady(rows),true);
 assert.equal(lunaPilotSchemaReady(rows.slice(1)),false);
 assert.equal(lunaPilotSchemaReady(rows.map(r=>({...r,sql:r.sql.replace('BETWEEN 0 AND 500000','BETWEEN 0 AND 999999')}))),false);
 const id=await reserveLunaPilotModel(e,now);
 e.DB.sqlite.exec(readFileSync(new URL('../migrations/040_whatsapp_luna_pilot_budget.sql',import.meta.url),'utf8'));
 assert.equal(row(e).charged_micros,300000);assert.equal(row(e).lock_id,id);
});

test('outbound quota is durable and old pilot counters are untouched by the new profile',async()=>{
 const e=env();e.DB.sqlite.prepare('INSERT INTO rate_limits (key,count,locked_until) VALUES (?,?,?)').run('wa-pilot:old-approved-pilot:outbound',29,9007199254740991);
 const all=await Promise.all(Array.from({length:30},()=>reservePilotOperation(e,'outbound',now)));
 assert.equal(all.filter(Boolean).length,24);assert.equal(await reservePilotOperation(e,'outbound',now+1),false);
 assert.equal(e.DB.sqlite.prepare("SELECT count FROM rate_limits WHERE key='wa-pilot:old-approved-pilot:outbound'").get().count,29);
 assert.equal(bookingPilotReady({...e,WHATSAPP_BOOKING_SEND_ENABLED:'off'},now),false);
});

test('provider ignoring abort cannot use a late answer or free a pending reservation for another request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const e=env();let started,complete;const waiting=new Promise(r=>{started=r;});let calls=0;
 const adapter=createOpenAIBookingModel(e,{clock:()=>now,fetchImpl:async()=>{
  calls++;started();return new Promise(resolve=>{complete=resolve;});
 }});
 const pending=proposeBookingTurn(adapter,state,text,now);await waiting;
 t.mock.timers.tick(10000);assert.equal(await pending,null);
 assert.equal(row(e).charged_micros,300000);assert.ok(row(e).lock_id);
 assert.equal(await reserveLunaPilotModel(e,now+10001),null);
 complete(response());
 for(let i=0;i<80;i++)await Promise.resolve();
 assert.equal(row(e).charged_micros,300000);assert.equal(row(e).stopped_reason,'timeout');
 assert.equal(await reserveLunaPilotModel(e,now+10002),null);assert.equal(calls,1);
});

test('one explicitly selected readiness case counts exact payload before bounded generation and keeps ten-cent allocation',async()=>{
 const {runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
 WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
 WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
 const calls=[];let counted;
 const options={clock:()=>now,fetchImpl:async(url,init)=>{
  calls.push(url);const body=JSON.parse(init.body);assert.ok(new TextEncoder().encode(init.body).byteLength<=8192);
  assert.equal(row(e).charged_micros,100000,'reserve precedes BOTH network operations');
  if(url.endsWith('/input_tokens')){
   counted=body;assert.deepEqual(Object.keys(body).sort(),['input','instructions','model','reasoning','text']);
   return Response.json({object:'response.input_tokens',input_tokens:1000});
  }
  assert.equal(body.max_output_tokens,512);assert.equal(body.service_tier,'default');assert.equal(body.store,false);
  for(const key of Object.keys(counted))assert.deepEqual(body[key],counted[key]);
  const message=JSON.parse(body.input[0].content).customer_message;
  const result=await response().json();result.output[0].content[0].text=JSON.stringify({...raw,fields:[{field:'size',quote:'keys'}]});return Response.json(result);
 }};
 assert.equal((await runLunaPilotReadiness(e,'relative_time',options)).status,404);assert.equal(calls.length,0);
 const result=await runLunaPilotReadiness(e,'small_item',options);assert.equal(result.report.passed,true);
 assert.equal(result.report.diagnostic.synthetic.schema_valid,true);
 assert.equal(result.report.diagnostic.synthetic.counted_input_tokens,1000);
 assert.equal(JSON.parse(result.report.diagnostic.synthetic.synthetic_output).intent,'update');
 assert.deepEqual(calls,['https://api.openai.com/v1/responses/input_tokens','https://api.openai.com/v1/responses']);
 assert.equal(row(e).charged_micros,100000,'no refund of counting/fee margin even on success');
 await runLunaPilotReadiness(e,'small_item',options);assert.equal(calls.length,2,'replay calls neither endpoint');
});

test('readiness token counting rejects missing, excessive and failed counts without generating or retrying',async()=>{
 const {runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 for(const count of [null,0,4097,'1000','http_error']){
  const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
   WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
   WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
  let calls=0;
  const options={clock:()=>now,fetchImpl:async url=>{calls++;assert.ok(url.endsWith('/input_tokens'));
   return count==='http_error'?new Response('private provider detail',{status:403}):Response.json({object:'response.input_tokens',input_tokens:count});}};
  const result=await runLunaPilotReadiness(e,'small_item',options);assert.equal(result.report.passed,false);
  assert.equal(result.report.outcome,count===4097?'input_limit':'input_token_count');
  assert.equal(row(e).charged_micros,100000);assert.ok(row(e).stopped_reason);
  await runLunaPilotReadiness(e,'small_item',options);assert.equal(calls,1);
 }
});

test('readiness fails closed when actual input differs from count or output exceeds requested cap',async()=>{
 const {runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 for(const badUsage of [{input_tokens:1001,output_tokens:100,total_tokens:1101},{input_tokens:1000,output_tokens:513,total_tokens:1513}]){
  const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
   WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
   WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
  const r=await runLunaPilotReadiness(e,'small_item',{clock:()=>now,fetchImpl:async url=>url.endsWith('/input_tokens')
   ?Response.json({object:'response.input_tokens',input_tokens:1000}):response({usage:badUsage})});
  assert.equal(r.report.outcome,'usage_unverified');assert.equal(row(e).charged_micros,100000);assert.ok(row(e).stopped_reason);
 }
});

test('fictional readiness reports structural/schema failures usefully without exposing provider error text or headers',async()=>{
 const {runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 for(const failure of ['envelope','schema','http']){
  const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
   WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
   WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
  const r=await runLunaPilotReadiness(e,'small_item',{clock:()=>now,fetchImpl:async url=>{
   if(url.endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:1000});
   if(failure==='http')return Response.json({error:{code:'invalid_api_key',message:'sk-private-test-error'}},{status:401,headers:{'X-Private':'sk-private-header'}});
   const body=await response().json();
   if(failure==='envelope')delete body.output[0].status;
   else body.output[0].content[0].text=JSON.stringify({...raw,price:1});
   return Response.json(body);
  }});
  const diag=r.report.diagnostic.synthetic;
  assert.equal(r.report.passed,false);assert.equal(diag.schema_valid,false);
  if(failure==='http'){assert.equal(diag.provider_error_code,'invalid_api_key');assert.equal(r.report.diagnostic.httpStatus,401);}
  else {assert.equal(diag.response_status,'completed');assert.ok(diag.synthetic_output);assert.ok(diag.output_structure.length);}
  assert.doesNotMatch(JSON.stringify(r.report),/sk-private|X-Private|Authorization/);
  assert.equal(row(e).charged_micros,100000);
 }
});

test('only explicit follow-up approval reserves a second allowance without resetting stopped ledger',async()=>{
 const {readinessAttemptId}=await import('../src/whatsapp-pilot-budget.js');
 const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
 WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
 WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
 const first=await reserveLunaPilotModel(e,now,true,'small_item');await finishLunaPilotModel(e,first,{outcome:'transport_failure',elapsedMs:150},now+150);
 const evidence=e.DB.sqlite.prepare('SELECT * FROM whatsapp_pilot_model_attempts WHERE id=?').get(first);
 for(const patch of [{WHATSAPP_BOOKING_READINESS_ATTEMPT:'2'}, {WHATSAPP_BOOKING_READINESS_ATTEMPT:'3',WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED:'on'}])
  assert.equal(await reserveLunaPilotModel({...e,...patch},now+200,true,'small_item'),null);
 const secondEnv={...e,WHATSAPP_BOOKING_READINESS_ATTEMPT:'2',WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED:'on'};
 assert.equal(readinessAttemptId(secondEnv,'small_item'),first+':2');
 const ids=await Promise.all(Array.from({length:4},()=>reserveLunaPilotModel(secondEnv,now+200,true,'small_item')));
 assert.equal(ids.filter(Boolean).length,1);assert.equal(row(e).charged_micros,200000);
 await finishLunaPilotModel(secondEnv,ids.find(Boolean),{outcome:'valid_proposal',usage,elapsedMs:10},now+300);
 assert.equal(row(e).charged_micros,200000);assert.equal(row(e).stopped_reason,'transport_failure');assert.equal(row(e).attempts,2);
 assert.deepEqual(e.DB.sqlite.prepare('SELECT * FROM whatsapp_pilot_model_attempts WHERE id=?').get(first),evidence);
 assert.equal(await reserveLunaPilotModel(secondEnv,now+400,true,'small_item'),null);
 assert.equal(await reserveLunaPilotModel(secondEnv,now+400,true,'relative_time'),null);
});
test('follow-up cannot be used before a first failed transport attempt or with stale browser identity',async()=>{
 const {validReadinessRequest}=await import('../src/whatsapp-pilot-readiness.js');
 const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
 WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,WHATSAPP_BOOKING_READINESS_APPROVED:'on',
 WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString(),
 WHATSAPP_BOOKING_READINESS_ATTEMPT:'2',WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED:'on'};
 assert.equal(await reserveLunaPilotModel(e,now,true,'small_item'),null);
 const id=e.WHATSAPP_BOOKING_PILOT_ID+':readiness:small_item:2';
 assert.equal(validReadinessRequest(e,{case_id:'small_item'}),false);
 assert.equal(validReadinessRequest(e,{case_id:'small_item',attempt_id:id.slice(0,-2)}),false);
 assert.equal(validReadinessRequest(e,{case_id:'small_item',attempt_id:id}),true);
 assert.equal(validReadinessRequest(e,{case_id:'small_item',attempt_id:id,extra:true}),false);
});

test('observed offset payload and quoted pronoun fail closed; exact keys quote passes the unchanged readiness gate',async()=>{
 const {runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 const {validateBookingProposal}=await import('../src/whatsapp-booking-model.js');
 const message='I need to send my keys';
 assert.equal(message.length,22);assert.equal(new TextEncoder().encode(message).length,22);assert.equal([...message].length,22);
 assert.equal(message.slice(14,18),' my ');assert.equal(message.slice(18,22),'keys');
 const legacy={version:1,intent:'update',fields:[{field:'size',start:14,end:18}],topic:null,clarify_field:null};
 for(const [observed,passes] of [[legacy,false],[{...legacy,version:2,fields:[{field:'size',quote:'my'}]},false],
  [{...legacy,version:2,fields:[{field:'size',quote:'keys'}]},true]]){
  const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
   WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
   WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
  const validated=validateBookingProposal(observed,message,now);
  if(passes)assert.deepEqual(validated.entries,[['size','small'],['notes','keys']]);else assert.equal(validated,null);
  let calls=0;
  const options={clock:()=>now,fetchImpl:async url=>{
   calls++;
   if(url.endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:714});
   const r=await response().json();r.usage={input_tokens:714,output_tokens:44,total_tokens:758};
   r.output[0].content[0].text=JSON.stringify(observed);return Response.json(r);
  }};
  const result=await runLunaPilotReadiness(e,'small_item',options);
  assert.equal(result.report.passed,passes);assert.equal(result.report.diagnostic.synthetic.schema_valid,passes);
  assert.equal(result.report.outcome,passes?'valid_proposal':'proposal_schema');assert.equal(calls,2);
  assert.equal(row(e).charged_micros,100000);assert.equal(row(e).started_at,null);
  assert.equal(row(e).stopped_reason,passes?null:'proposal_schema');
  await runLunaPilotReadiness(e,'small_item',options);assert.equal(calls,2,'no replay can retry the provider');
 }
});

test('quote-v2 check is one separately approved third attempt preserving both uncertain records',async()=>{
 const {validReadinessRequest,runLunaPilotReadiness}=await import('../src/whatsapp-pilot-readiness.js');
 const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
  WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
  WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
 const first=await reserveLunaPilotModel(e,now,true,'small_item');
 await finishLunaPilotModel(e,first,{outcome:'transport_failure'},now);
 const secondEnv={...e,WHATSAPP_BOOKING_READINESS_ATTEMPT:'2',WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED:'on'};
 const second=await reserveLunaPilotModel(secondEnv,now,true,'small_item');
 await finishLunaPilotModel(e,second,{outcome:'readiness_mismatch'},now);
 const prior=()=>e.DB.sqlite.prepare('SELECT * FROM whatsapp_pilot_model_attempts WHERE id IN (?,?) ORDER BY id').all(first,second);
 const evidence=prior();
 const third={...e,WHATSAPP_BOOKING_READINESS_ATTEMPT:'3',WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED:'on'};
 for(const patch of [{WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED:'off'},{WHATSAPP_BOOKING_READINESS_ATTEMPT:'4'},
  {WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now).toISOString()},{WHATSAPP_BOOKING_ENABLED:'on'},
  {WHATSAPP_BOOKING_SEND_ENABLED:'on'},{WHATSAPP_BOOKING_MODEL_ENABLED:'on'},{AUTO_DRIVER_DISPATCH:'on'},
  {WHATSAPP_BOOKING_PILOT_STARTED_AT:new Date(now).toISOString()}])
  assert.equal(await reserveLunaPilotModel({...third,...patch},now,true,'small_item'),null);
 const id=first+':3';
 assert.equal(validReadinessRequest(third,{case_id:'small_item',attempt_id:id}),true);
 for(const stale of [undefined,first,second])assert.equal(validReadinessRequest(third,{case_id:'small_item',attempt_id:stale}),false);
 assert.equal(await reserveLunaPilotModel(third,now,true,'relative_time'),null);
 const ids=await Promise.all(Array.from({length:4},()=>reserveLunaPilotModel(third,now,true,'small_item')));
 assert.deepEqual(ids.filter(Boolean),[id]);assert.equal(row(e).attempts,3);assert.equal(row(e).charged_micros,300000);
 await finishLunaPilotModel(third,id,{outcome:'valid_proposal',usage,elapsedMs:1},now);
 assert.deepEqual(prior(),evidence);assert.equal(row(e).stopped_reason,'transport_failure');
 assert.equal(row(e).started_at,null);assert.equal(row(e).expires_at,null);assert.equal(row(e).charged_micros,300000);
 const replay=await runLunaPilotReadiness(third,'small_item',{clock:()=>now,fetchImpl:()=>assert.fail('replay must not call provider')});
 assert.equal(replay.report.replay,true);assert.equal(replay.report.passed,true);
 assert.equal(await reserveLunaPilotModel(third,now,true,'small_item'),null);
});
test('quote-v2 approval cannot bypass missing, modified or successful prior attempt evidence',async()=>{
 for(const tamper of ['missing_first','missing_second','first_outcome','second_outcome','first_amount','second_amount','total','attempts','lock','live_window']){
  const e={...env(),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
   WHATSAPP_BOOKING_PILOT_STARTED_AT:undefined,WHATSAPP_BOOKING_PILOT_EXPIRES_AT:undefined,
   WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(now+3600000).toISOString()};
  const first=await reserveLunaPilotModel(e,now,true,'small_item');await finishLunaPilotModel(e,first,{outcome:'transport_failure'},now);
  const second=await reserveLunaPilotModel({...e,WHATSAPP_BOOKING_READINESS_ATTEMPT:'2',WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED:'on'},now,true,'small_item');
  await finishLunaPilotModel(e,second,{outcome:'readiness_mismatch'},now);
  const db=e.DB.sqlite;
  if(tamper.startsWith('missing_'))db.prepare('DELETE FROM whatsapp_pilot_model_attempts WHERE id=?').run(tamper==='missing_first'?first:second);
  if(tamper.endsWith('_outcome'))db.prepare("UPDATE whatsapp_pilot_model_attempts SET outcome='valid_proposal',status='settled' WHERE id=?").run(tamper==='first_outcome'?first:second);
  if(tamper.endsWith('_amount'))db.prepare('UPDATE whatsapp_pilot_model_attempts SET charged_micros=1 WHERE id=?').run(tamper==='first_amount'?first:second);
  if(tamper==='total')db.exec('UPDATE whatsapp_pilot_budgets SET charged_micros=100000');
  if(tamper==='attempts')db.exec('UPDATE whatsapp_pilot_budgets SET attempts=1');
  if(tamper==='lock')db.exec("UPDATE whatsapp_pilot_budgets SET lock_id='other'");
  if(tamper==='live_window')db.exec('UPDATE whatsapp_pilot_budgets SET started_at=1,expires_at=2');
  assert.equal(await reserveLunaPilotModel({...e,WHATSAPP_BOOKING_READINESS_ATTEMPT:'3',WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED:'on'},now,true,'small_item'),null,tamper);
 }
});
