import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundle=await build({stdin:{contents:`
 import {prepareContinuation} from './tests/fixtures/continuation-env.js';
 import {issueContinuationGrant,reserveContinuation,finishContinuation} from './src/whatsapp-continuation.js';
 import {createOpenAIBookingModel} from './src/whatsapp-booking-openai.js';
 import {proposeBookingTurn} from './src/whatsapp-booking-model.js';
 import {processBookingEvent,sendBookingReplies} from './src/whatsapp-booking-store.js';
 export default {async fetch(request,bindings){
  let now=Date.parse('2026-10-09T12:00:00Z');
  const env=await prepareContinuation(bindings.DB,now);
  const notice=['/failure-notice','/proposal-rejection'].includes(new URL(request.url).pathname);
  if(notice)env.WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY='one-shot-v1';
  let issued=await issueContinuationGrant(env,now);
  const v3=new URL(request.url).pathname==='/retry';
  const v2=v3 || new URL(request.url).pathname==='/followon';
  const prior=await bindings.DB.prepare('SELECT * FROM whatsapp_continuation_grants').first();
  if(v2){now+=3600000;Object.assign(env,{WHATSAPP_BOOKING_CONTINUATION_VERSION:'2',WHATSAPP_BOOKING_CONTINUATION_FOLLOWON_SCHEMA_READY:'on',WHATSAPP_BOOKING_CONTINUATION_ID:env.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-2',WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+1800000).toISOString()});issued=await issueContinuationGrant(env,now);}
  Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
  if(notice){
   const service={order:async()=>null,resolveAddress:async()=>({error:'address_not_found'}),conversationModelForEvent:eventId=>createOpenAIBookingModel(env,{clock:()=>now,eventId})};
   for(const [i,text] of ['שלום','1','1','אבקש לבדוק אפשרות למשלוח מסמכים בהמשך השבוע'].entries()){
    now++;await processBookingEvent(env,{id:'synthetic-worker-'+i,phone:env.TWILIO_RECIPIENT_ALLOWLIST,at:now,text},service,now);
    await sendBookingReplies(env,globalThis.fetch,now);
   }
   await sendBookingReplies(env,globalThis.fetch,now);
   return Response.json({grant:await bindings.DB.prepare('SELECT * FROM whatsapp_continuation_grants').first(),replies:(await bindings.DB.prepare('SELECT state,kind,body FROM whatsapp_booking_replies').all()).results,
    ops:(await bindings.DB.prepare('SELECT kind,status,outcome FROM whatsapp_continuation_operations').all()).results});
  }
  if(v3){
   for(let i=0;i<4;i++)await reserveContinuation(env,'inbound','old-inbound-'+i,now);
   for(let i=0;i<3;i++){await reserveContinuation(env,'outbound','old-outbound-'+i,now);await finishContinuation(env,'outbound','old-outbound-'+i,{ok:true},now);}
   await reserveContinuation(env,'model','old-model',now);await finishContinuation(env,'model','old-model',{ok:false},now);
   now+=3600000;Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',WHATSAPP_BOOKING_CONTINUATION_VERSION:'3',WHATSAPP_BOOKING_CONTINUATION_RETRY_SCHEMA_READY:'on',WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY:'one-shot-v1',WHATSAPP_BOOKING_CONTINUATION_ID:env.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-3',WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+1800000).toISOString()});
   issued=await issueContinuationGrant(env,now);Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
  }
  const old=await bindings.DB.prepare('SELECT * FROM whatsapp_pilot_budgets').first();
  const rows=(await bindings.DB.prepare('SELECT * FROM whatsapp_pilot_model_attempts ORDER BY id').all()).results;
  const proposals=[];
  for(let n=0;n<7;n++){
   const eventId=n.toString(16).padStart(64,'0');
   const adapter=createOpenAIBookingModel(env,{clock:()=>now,eventId});
   proposals.push(await proposeBookingTurn(adapter,{phase:'collect',consent_at:1,data:{}},'מפתחות',now));
   proposals.push(await proposeBookingTurn(adapter,{phase:'collect',consent_at:1,data:{}},'מפתחות',now));
  }
  const sends=await Promise.all(Array.from({length:5},(_,n)=>reserveContinuation(env,'outbound','s'+n,now)));
  return Response.json({issued,proposals,sendReservations:sends.filter(Boolean).length,grant:await bindings.DB.prepare(v3?'SELECT * FROM whatsapp_continuation_retry_grants':v2?'SELECT * FROM whatsapp_continuation_followon_grants':'SELECT * FROM whatsapp_continuation_grants').first(),
   priorPreserved:JSON.stringify(prior)===JSON.stringify(await bindings.DB.prepare('SELECT * FROM whatsapp_continuation_grants').first()),
   historyPreserved:JSON.stringify(old)===JSON.stringify(await bindings.DB.prepare('SELECT * FROM whatsapp_pilot_budgets').first()) && JSON.stringify(rows)===JSON.stringify((await bindings.DB.prepare('SELECT * FROM whatsapp_pilot_model_attempts ORDER BY id').all()).results)});
 }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
for(const path of ['/check','/followon','/retry'])test(path+' real workerd/D1 grant preserves original hash/holds, enforces six calls, durable duplicates and atomic transport lock',async t=>{
 let counts=0,generations=0;
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'api.openai.com');
  if(request.url.endsWith('/input_tokens')){counts++;return Response.json({object:'response.input_tokens',input_tokens:1000});}
  generations++;return Response.json({model:'gpt-6-luna',service_tier:'default',status:'completed',usage:{input_tokens:1000,output_tokens:50,total_tokens:1050},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({version:2,intent:'update',fields:[{field:'size',quote:'מפתחות'}],topic:null,clarify_field:null})}]}]});
 }});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 for(const name of ['040_whatsapp_luna_pilot_budget.sql','041_whatsapp_continuation_grant.sql','042_whatsapp_continuation_followon.sql','043_whatsapp_continuation_retry.sql'])await db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 await db.exec('CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER);');
 const result=await (await mf.dispatchFetch('http://localhost'+path)).json();
 if(path!=='/check')assert.equal(result.priorPreserved,true);
 assert.equal(result.issued,true);assert.equal(result.historyPreserved,true);assert.equal(result.grant.model,path==='/retry'?5:6);assert.equal(result.grant.model_micros,path==='/retry'?150000:180000);assert.equal(result.sendReservations,1);
 const expected=path==='/retry'?5:6;assert.equal(result.proposals.filter(Boolean).length,expected);assert.equal(counts,expected);assert.equal(generations,expected);assert.equal(result.grant.historical_micros,path==='/retry'?405100:300000);
});


for(const path of ['/failure-notice','/proposal-rejection'])test(path+' real workerd/D1 records bounded diagnostics and sends one fixed failure notice with mocked providers',async t=>{
 let sends=0,count=0,generation=0;
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:async request=>{
  const host=new URL(request.url).hostname;
  if(host==='api.openai.com'){
   if(request.url.endsWith('/input_tokens')){count++;return Response.json({object:'response.input_tokens',input_tokens:1000});}
   generation++;
   if(path==='/proposal-rejection')return Response.json({model:'gpt-6-luna',service_tier:'default',status:'completed',usage:{input_tokens:1000,output_tokens:50,total_tokens:1050},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({version:2,intent:'update',fields:[{field:'notes',quote:'invented absent evidence'}],topic:null,clarify_field:null})}]}]});
   return new Response('',{status:503});
  }
  assert.equal(host,'api.twilio.com');sends++;
  if(sends===4)assert.equal(new URLSearchParams(await request.text()).get('Body'),'לא הצלחתי לעבד את הפרטים. האוטומציה נעצרה. אפשר לפנות לנציג להמשך.');
  return Response.json({sid:'SM'+String(sends).repeat(32)});
 }});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 const r=await(await mf.dispatchFetch('http://localhost'+path)).json();
 assert.equal(count,1);assert.equal(generation,1);assert.equal(sends,4);assert.equal(r.grant.stopped_reason,'model_uncertain');
 assert.equal(r.grant.spent_micros,116400);assert.equal(r.grant.historical_micros+r.grant.fee_cushion_micros+r.grant.spent_micros,916400);
 assert.equal(r.replies.filter(x=>x.kind==='model_failure_notice' && x.state==='sent' && x.body===null).length,1);
 assert.equal(r.ops.filter(x=>x.outcome==='notice_sent').length,1);
 if(path==='/proposal-rejection')assert.equal(JSON.parse(r.ops.find(x=>x.kind==='model').outcome).proposal_rejection,'quote_missing');
});
