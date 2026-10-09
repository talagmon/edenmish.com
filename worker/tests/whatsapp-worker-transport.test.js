import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Exercise actual Worker fetch semantics, not Node's more permissive Request.
// ALL outbound traffic is intercepted in-process; no provider/key/network access.
const bundle = await build({stdin:{contents:`import {runLunaPilotReadiness} from './whatsapp-pilot-readiness.js';
 export default {async fetch(request,env){return Response.json(await runLunaPilotReadiness(env,'small_item'));}};`,
 resolveDir:fileURLToPath(new URL('../src',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
async function runtime(t, redirectAt=null) {
 const seen=[];
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],
  bindings:{BOOKING_URL:'https://staging.edenmish.com',WHATSAPP_BOOKING_MODE:'conversation_only',
   WHATSAPP_BOOKING_PILOT_PROFILE:'luna-v1',WHATSAPP_BOOKING_PILOT_ID:'edenmish-luna-workerd-test',WHATSAPP_BOOKING_PILOT_BUDGET_READY:'on',
   WHATSAPP_BOOKING_PROVIDER:'twilio',WHATSAPP_BOOKING_MODEL:'gpt-6-luna',WHATSAPP_BOOKING_OPENAI_API_KEY:'sk-synthetic-test-only',
   WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',
   WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',AUTO_DRIVER_DISPATCH:'off',
   TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:'+972541234567',TWILIO_BOOKING_FROM:'whatsapp:+15551234567',TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),
   WHATSAPP_BOOKING_READINESS_CASE:'small_item',WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(Date.now()+600000).toISOString()},
  outboundService:async request=>{
   seen.push({url:request.url,redirect:request.redirect});
   const url=new URL(request.url);
   if(url.hostname!=='api.openai.com')return new Response('Redirect must never be followed',{status:400});
   if(url.pathname===redirectAt)return new Response('',{status:302,headers:{Location:'https://redirect.invalid/never-send'}});
   if(url.pathname==='/v1/responses/input_tokens')return Response.json({object:'response.input_tokens',input_tokens:1000});
   const proposal={version:1,intent:'update',fields:[{field:'size',start:17,end:21}],topic:null,clarify_field:null};
   return Response.json({model:'gpt-6-luna',service_tier:'default',status:'completed',usage:{input_tokens:1000,output_tokens:100,total_tokens:1100},
    output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(proposal)}]}]});
  }});
 t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');
 const migration=readFileSync(new URL('../migrations/040_whatsapp_luna_pilot_budget.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' ');
 await db.exec(migration);
 return {seen,db,invoke:async()=> (await mf.dispatchFetch('http://localhost/')).json()};
}
test('real workerd transport accepts bounded readiness request and durable replay sends nothing',async t=>{
 const r=await runtime(t);const first=await r.invoke();
 assert.equal(first.report.outcome,'valid_proposal');assert.equal(first.report.passed,true);
 assert.equal(r.seen.length,2);assert.ok(r.seen.every(x=>new URL(x.url).hostname==='api.openai.com'));
 const replay=await r.invoke();assert.equal(replay.report.replay,true);assert.equal(r.seen.length,2);
 const row=await r.db.prepare('SELECT attempts,charged_micros FROM whatsapp_pilot_budgets').first();
 assert.deepEqual(row,{attempts:1,charged_micros:100000});
});
test('real workerd never forwards authorization across a count or generation redirect',async t=>{
 for(const path of ['/v1/responses/input_tokens','/v1/responses']){
  const r=await runtime(t,path);const result=await r.invoke();
  assert.equal(result.report.passed,false);assert.equal(result.report.outcome,path.endsWith('input_tokens')?'input_token_count':'http_error');
  assert.equal(r.seen.length,path.endsWith('input_tokens')?1:2);assert.ok(r.seen.every(x=>new URL(x.url).hostname==='api.openai.com'));
  const row=await r.db.prepare('SELECT attempts,charged_micros,stopped_reason FROM whatsapp_pilot_budgets').first();
  assert.equal(row.attempts,1);assert.equal(row.charged_micros,100000);assert.ok(row.stopped_reason);
  await r.invoke();assert.equal(r.seen.length,path.endsWith('input_tokens')?1:2);
 }
});
