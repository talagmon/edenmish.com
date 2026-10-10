import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('real workerd/D1 Sol grant routes notes, suppresses duplicates and creates no orders',async t=>{
 const bundle=await build({stdin:{contents:`
 import {prepareSolSession} from './tests/fixtures/sol-session-env.js';
 import {issueContinuationGrant,continuationCanProceed} from './src/whatsapp-continuation.js';
 import {createOpenAIBookingModel} from './src/whatsapp-booking-openai.js';
 import {processBookingEvent,sendBookingReplies} from './src/whatsapp-booking-store.js';
 export default {async fetch(request,bindings){
  let now=Date.parse('2026-10-10T09:00:00Z');const env=await prepareSolSession(bindings.DB,now);
  const issued=await issueContinuationGrant(env,now);
  Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
  const services={order:async()=>{throw new Error('no order');},conversationModelForEvent:eventId=>createOpenAIBookingModel(env,{clock:()=>now,eventId})};
  for(const [i,text] of ['שלום','1','1','אבקש משלוח של מפתחות בבקשה'].entries()){
   now++;const event={id:'sol-message-'+i,phone:env.TWILIO_RECIPIENT_ALLOWLIST,at:now,text};
   await processBookingEvent(env,event,services,now);await processBookingEvent(env,event,services,now);await sendBookingReplies(env,globalThis.fetch,now);
  }
  return Response.json({issued,active:await continuationCanProceed(env,now),expired:await continuationCanProceed(env,now+900000),
    grant:await bindings.DB.prepare('SELECT * FROM whatsapp_continuation_sol_grants').first(),
    state:JSON.parse((await bindings.DB.prepare('SELECT state_json FROM whatsapp_booking_conversations').first()).state_json),orders:await bindings.DB.prepare('SELECT COUNT(*) n FROM orders').first()});
 }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
 let models=0,sends=0;
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:async req=>{
  if(new URL(req.url).hostname==='api.openai.com'){
   models++;assert.equal(req.url,'https://api.openai.com/v1/responses');const p=await req.json();assert.equal(p.model,'gpt-6.1-sol');assert.equal(p.reasoning.effort,'low');assert.equal(p.max_output_tokens,1024);
   return Response.json({model:p.model,service_tier:'default',status:'completed',usage:{input_tokens:871,output_tokens:98,total_tokens:969,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({version:2,intent:'update',fields:[{field:'size',quote:'מפתחות'}],topic:null,clarify_field:null})}]}]});
  }
  assert.equal(new URL(req.url).hostname,'api.twilio.com');sends++;return Response.json({sid:'SM'+String(sends).repeat(32)});
 }});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 const r=await(await mf.dispatchFetch('http://localhost/check')).json();
 assert.equal(r.issued,true);assert.equal(r.active,true);assert.equal(r.expired,false);assert.equal(models,1);assert.equal(sends,4);
 assert.equal(r.grant.model_micros,56320);assert.equal(r.grant.inbound,4);assert.equal(r.grant.outbound,4);assert.equal(r.state.data.notes,'מפתחות');assert.equal(r.orders.n,0);
});
