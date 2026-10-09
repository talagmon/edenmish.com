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
 export default {async fetch(request,bindings){
  let now=Date.parse('2026-10-09T12:00:00Z');
  const env=await prepareContinuation(bindings.DB,now);let issued=await issueContinuationGrant(env,now);
  const v2=new URL(request.url).pathname==='/followon';
  const prior=await bindings.DB.prepare('SELECT * FROM whatsapp_continuation_grants').first();
  if(v2){now+=3600000;Object.assign(env,{WHATSAPP_BOOKING_CONTINUATION_VERSION:'2',WHATSAPP_BOOKING_CONTINUATION_FOLLOWON_SCHEMA_READY:'on',WHATSAPP_BOOKING_CONTINUATION_ID:env.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-2',WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+1800000).toISOString()});issued=await issueContinuationGrant(env,now);}
  Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
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
  return Response.json({issued,proposals,sendReservations:sends.filter(Boolean).length,grant:await bindings.DB.prepare(v2?'SELECT * FROM whatsapp_continuation_followon_grants':'SELECT * FROM whatsapp_continuation_grants').first(),
   priorPreserved:JSON.stringify(prior)===JSON.stringify(await bindings.DB.prepare('SELECT * FROM whatsapp_continuation_grants').first()),
   historyPreserved:JSON.stringify(old)===JSON.stringify(await bindings.DB.prepare('SELECT * FROM whatsapp_pilot_budgets').first()) && JSON.stringify(rows)===JSON.stringify((await bindings.DB.prepare('SELECT * FROM whatsapp_pilot_model_attempts ORDER BY id').all()).results)});
 }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
for(const path of ['/check','/followon'])test(path+' real workerd/D1 grant preserves original hash/holds, enforces six calls, durable duplicates and atomic transport lock',async t=>{
 let counts=0,generations=0;
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'api.openai.com');
  if(request.url.endsWith('/input_tokens')){counts++;return Response.json({object:'response.input_tokens',input_tokens:1000});}
  generations++;return Response.json({model:'gpt-6-luna',service_tier:'default',status:'completed',usage:{input_tokens:1000,output_tokens:50,total_tokens:1050},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({version:2,intent:'update',fields:[{field:'size',quote:'מפתחות'}],topic:null,clarify_field:null})}]}]});
 }});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 for(const name of ['040_whatsapp_luna_pilot_budget.sql','041_whatsapp_continuation_grant.sql','042_whatsapp_continuation_followon.sql'])await db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 await db.exec('CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER);');
 const result=await (await mf.dispatchFetch('http://localhost'+path)).json();
 if(path==='/followon')assert.equal(result.priorPreserved,true);
 assert.equal(result.issued,true);assert.equal(result.historyPreserved,true);assert.equal(result.grant.model,6);assert.equal(result.grant.model_micros,180000);assert.equal(result.sendReservations,1);
 assert.equal(result.proposals.filter(Boolean).length,6);assert.equal(counts,6);assert.equal(generations,6);assert.equal(result.grant.historical_micros,300000);
});
