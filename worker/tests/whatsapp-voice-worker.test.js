import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const cases=JSON.parse(readFileSync(new URL('./fixtures/whatsapp-multilingual.json',import.meta.url)));
const sizeContextCases=JSON.parse(readFileSync(new URL('./fixtures/whatsapp-size-context.json',import.meta.url)));
const reviewContextCases=JSON.parse(readFileSync(new URL('./fixtures/whatsapp-size-context-review.json',import.meta.url)));
const reviewVoiceCases=reviewContextCases.map(c=>({...c,greeting:'hello',quotes:{size:c.quote}}));
const syntheticHebrew={language:'he',greeting:'hello',text:'אפשר להמשיך בעברית? בבקשה לשלוח מעטפה קטנה.',quotes:{size:'מעטפה קטנה'}};
const mp3=readFileSync(new URL('./fixtures/audio/tone.mp3',import.meta.url));
const tone=readFileSync(new URL('./fixtures/audio/tone.ogg',import.meta.url));
const script=(await build({stdin:{contents:`
 import {prepareSolSession} from './tests/fixtures/sol-session-env.js';
 import {issueContinuationGrant} from './src/whatsapp-continuation.js';
 import {createOpenAIBookingModel} from './src/whatsapp-booking-openai.js';
 import {processBookingEvent} from './src/whatsapp-booking-store.js';
 import {readTwilioBookingEvent} from './src/whatsapp-booking-twilio.js';
 import {voiceBinding,transcribeBookingAudio} from './src/whatsapp-booking-audio.js';
 import cases from './tests/fixtures/whatsapp-multilingual.json';
 export default {async fetch(request,bindings){
  const q=new URL(request.url).searchParams,mode=q.get('mode')||'ok',c=mode==='reviewContext'?${JSON.stringify(reviewVoiceCases)}[Number(q.get('case')||0)]:mode==='sizeContext'?{...${JSON.stringify(syntheticHebrew)},text:${JSON.stringify(sizeContextCases)}[Number(q.get('case')||0)].text}:mode==='syntheticHebrew'?${JSON.stringify(syntheticHebrew)}:cases[Number(q.get('case')||0)];
  let now=Date.parse('2026-10-10T09:00:00Z');
  const env=await prepareSolSession(bindings.DB,now);if(!await issueContinuationGrant(env,now))throw Error('grant fixture');
  Object.assign(env,{TWILIO_BOOKING_WEBHOOK_URL:'https://local.example/webhooks/twilio/booking',WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on',WHATSAPP_BOOKING_VOICE_ENABLED:'on',WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_VOICE_APPROVED:'on',WHATSAPP_BOOKING_VOICE_GRANT_ID:'voice-local-fixture'});
  await env.DB.prepare('INSERT INTO whatsapp_voice_grants(id,binding_hash,starts_at,expires_at,max_calls,approved_micros) VALUES(?,?,?,?,?,?)').bind(env.WHATSAPP_BOOKING_VOICE_GRANT_ID,await voiceBinding(env),now,now+900000,6,30000).run();
  const services={multilingual:true,order:async()=>{throw Error('no order');},quote:async()=>({price:50,review:false}),resolveAddress:async value=>({address:value,city:'תל אביב',lat:32,lng:34}),
    transcribeAudio:(event,key)=>transcribeBookingAudio(env,event,key,{clock:()=>now}),conversationModelForEvent:eventId=>createOpenAIBookingModel(env,{eventId,clock:()=>now})};
  if(mode!=='preconsent')for(const [i,text] of [c.greeting,'1'].entries()){now++;await processBookingEvent(env,{id:'SM'+String(i+1).repeat(32),phone:env.TWILIO_RECIPIENT_ALLOWLIST,at:now,text},services,now);}
  const id='MM'+'3'.repeat(32);now++;
  const form=new URLSearchParams({MessageSid:id,AccountSid:env.TWILIO_ACCOUNT_SID,From:'whatsapp:'+env.TWILIO_RECIPIENT_ALLOWLIST,To:env.TWILIO_BOOKING_FROM,NumMedia:'1',MediaUrl0:'https://api.twilio.com/2010-04-01/Accounts/'+env.TWILIO_ACCOUNT_SID+'/Messages/'+id+'/Media/ME'+'4'.repeat(32),MediaContentType0:mode==='syntheticHebrew'?'audio/mpeg':'audio/ogg'});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TWILIO_AUTH_TOKEN),{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const signed=env.TWILIO_BOOKING_WEBHOOK_URL+[...form.keys()].sort().map(k=>k+form.get(k)).join('');
  const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(signed)))));
  const parsed=await readTwilioBookingEvent(new Request(env.TWILIO_BOOKING_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},body:form}),env,async()=>Response.json({sid:id,account_sid:env.TWILIO_ACCOUNT_SID,from:form.get('From'),to:form.get('To'),direction:'inbound',date_created:new Date(now).toISOString()}),now);
  if(parsed.status!==200||!parsed.event?.audio)throw Error('signed MM audio did not reach the pipeline');
  const event=parsed.event;
  if(mode==='expired')now+=900001;
  if(mode==='off')env.WHATSAPP_BOOKING_VOICE_ENABLED='off';
  if(mode==='binding')env.WHATSAPP_BOOKING_VOICE_GRANT_ID='different-voice-grant';
  const result=await processBookingEvent(env,event,services,now),replay=await processBookingEvent(env,event,services,now);
  return Response.json({result,replay,modelGrant:await env.DB.prepare('SELECT stopped_reason FROM whatsapp_continuation_sol_grants').first(),modelOperations:(await env.DB.prepare("SELECT status,outcome FROM whatsapp_continuation_sol_operations WHERE kind='model'").all()).results,voice:await env.DB.prepare('SELECT * FROM whatsapp_voice_grants').first(),attempts:(await env.DB.prepare('SELECT * FROM whatsapp_voice_attempts').all()).results,state:JSON.parse((await env.DB.prepare('SELECT state_json FROM whatsapp_booking_conversations').first()).state_json),replies:(await env.DB.prepare('SELECT body FROM whatsapp_booking_replies ORDER BY created_at').all()).results,orders:await env.DB.prepare('SELECT COUNT(*) n FROM orders').first()});
 }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text;
async function run(t,{mode='ok',index=0}={}) {
 const c=mode==='reviewContext'?reviewVoiceCases[index]:mode==='sizeContext'?{...syntheticHebrew,text:sizeContextCases[index].text}:mode==='syntheticHebrew'?syntheticHebrew:cases[index],seen=[];
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script,d1Databases:['DB'],outboundService:async req=>{
  seen.push({url:req.url,auth:req.headers.get('authorization')});const url=new URL(req.url);
  if(url.hostname==='api.twilio.com'){
   if(mode==='evilRedirect')return new Response(null,{status:302,headers:{location:'https://evil.example/private'}});
   if(mode==='cdn')return new Response(null,{status:302,headers:{location:'https://mms.twiliocdn.com/v1/Media/synthetic'}});
   if(mode==='downloadFailure')return new Response(null,{status:503});
   return new Response(mode==='syntheticHebrew'?mp3:tone,{headers:{'Content-Type':mode==='syntheticHebrew'?'audio/mpeg':'audio/ogg'}});
  }
  if(url.hostname==='mms.twiliocdn.com'){assert.equal(req.headers.get('authorization'),null);return new Response(tone);}
  assert.equal(url.hostname,'api.openai.com');
  if(url.pathname==='/v1/audio/transcriptions'){
   const form=await req.formData();assert.equal(form.get('model'),'gpt-transcribe');assert.deepEqual(form.getAll('languages[]'),['he','ar','ru','fr','en']);const audio=form.get('file');assert.equal(audio.type,mode==='syntheticHebrew'?'audio/mpeg':'audio/webm');assert.ok(audio.size<30000);
   if(mode==='apiFailure')return new Response(null,{status:429});
   return Response.json({text:mode==='empty'?'':mode==='sensitive'?'4111 1111 1111 1111':mode==='overlong'?'a'.repeat(2001):c.text,languages:mode==='unknownLanguage'?[]:[{code:c.language}],...(mode==='missingUsage'?{}:{usage:{type:'duration',seconds:1.02}})});
  }
  assert.equal(url.pathname,'/v1/responses');const p=await req.json();assert.equal(p.model,'gpt-6.1-sol');assert.equal(p.reasoning.effort,'low');assert.equal(p.text.format.schema.properties.version.enum[0],4);assert.equal(p.max_output_tokens,1024);assert.ok(new TextEncoder().encode(JSON.stringify(p)).byteLength<=8192);assert.deepEqual(p.text.format.schema.properties.reply_style.enum,['friendly','brief','guided']);
  assert.equal(JSON.parse(p.input[0].content).customer_message,c.text);
  return Response.json({model:p.model,service_tier:'default',status:'completed',usage:{input_tokens:1300,output_tokens:200,total_tokens:1500,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({version:4,reply_style:'friendly',reply_language:c.language,intent:'update',fields:Object.entries(c.quotes).map(([field,quote])=>({field,quote})),topic:null,clarify_field:null})}]}]});
 }});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 const response=await mf.dispatchFetch('http://localhost/run?mode='+mode+'&case='+index);assert.equal(response.status,200,response.status===200?'':await response.text());return {r:await response.json(),seen,db};
}
for(const [index,c] of cases.entries())test(`real Worker voice + Sol + D1: ${c.id}, duplicate suppressed, no order`,async t=>{
 const {r,seen}=await run(t,{index});assert.equal(r.state.language,c.language);assert.equal(r.state.data.notes,c.quotes.size,JSON.stringify({state:r.state,result:r.result,voice:r.voice,replies:r.replies,seen:seen.map(x=>x.url)}));assert.equal(r.state.menu.kind,'schedule');assert.equal(r.replay.duplicate,true);assert.equal(r.voice.used_calls,1);assert.equal(r.voice.reserved_micros,5000);assert.equal(r.attempts[0].outcome,'ok');assert.equal(r.orders.n,0);assert.equal(seen.length,3);assert.ok(!JSON.stringify(r.attempts).includes(c.text));
});
for(const mode of ['preconsent','expired','off','binding'])test(`real Worker voice ${mode}: no media or model request`,async t=>{const {r,seen}=await run(t,{mode});assert.equal(seen.length,0);assert.equal(r.voice.used_calls,0);assert.equal(r.orders.n,0);});
for(const mode of ['evilRedirect','downloadFailure','apiFailure','missingUsage','unknownLanguage','empty','sensitive','overlong'])test(`real Worker voice ${mode}: bounded failure, retained hold, no retry or booking mutation`,async t=>{const {r,seen}=await run(t,{mode});assert.equal(r.state.data.size,undefined);assert.equal(r.voice.used_calls,1);assert.equal(r.voice.reserved_micros,5000);assert.equal(r.voice.stopped,1);assert.equal(r.replay.duplicate,true);assert.equal(r.orders.n,0);assert.ok(seen.length<=2);assert.ok(seen.every(s=>!s.url.includes('evil.example')));});
test('real Worker signed media CDN redirect strips Twilio credential',async t=>{const {r,seen}=await run(t,{mode:'cdn',index:3});assert.equal(r.state.language,'fr');assert.equal(seen.length,4);assert.equal(seen[1].auth,null);});
test('D1 enforces audio budget and immutable holds under concurrent reservations',async t=>{
 const {db}=await run(t,{mode:'off'});const inputs=Array.from({length:10},(_,i)=>db.prepare('INSERT INTO whatsapp_voice_attempts(event_key,grant_id,created_at) VALUES(?,?,?)').bind('x'+i,'voice-local-fixture',Date.parse('2026-10-10T09:00:00Z')).run());
 const results=await Promise.allSettled(inputs);assert.equal(results.filter(r=>r.status==='fulfilled').length,6);
 const row=await db.prepare('SELECT used_calls,reserved_micros FROM whatsapp_voice_grants').first();assert.deepEqual(row,{used_calls:6,reserved_micros:30000});
 await assert.rejects(()=>db.prepare('UPDATE whatsapp_voice_grants SET reserved_micros=0').run());await assert.rejects(()=>db.prepare('DELETE FROM whatsapp_voice_attempts').run());
});

test('signed MM MP3 through Worker, transcription and Sol preserves synthetic Hebrew envelope and advances',async t=>{
 const {r,seen}=await run(t,{mode:'syntheticHebrew'});
 assert.equal(r.state.language,'he');assert.equal(r.state.phase,'collect');assert.equal(r.state.data.size,'small');assert.equal(r.state.data.notes,'מעטפה קטנה');
 assert.equal(r.replay.duplicate,true);assert.equal(r.voice.used_calls,1);assert.equal(r.attempts[0].outcome,'ok');assert.equal(r.orders.n,0);assert.equal(seen.length,3);
 assert.ok(seen[0].url.includes('/Messages/MM'));assert.match(r.replies.at(-1).body,/מאיפה|איסוף/);assert.doesNotMatch(r.replies.at(-1).body,/נעצרה/);
});

for(const [index,c] of sizeContextCases.entries())test(`signed MM voice rejects Claude size-context ${c.id} without writing item data`,async t=>{
 const {r,seen}=await run(t,{mode:'sizeContext',index});
 assert.equal(r.state.data.size,undefined);assert.equal(r.state.data.notes,undefined);
 assert.equal(r.voice.used_calls,1);assert.equal(r.voice.reserved_micros,5000);assert.equal(r.orders.n,0);assert.equal(seen.length,3);
 assert.equal(r.modelGrant.stopped_reason,'model_uncertain');assert.equal(r.modelOperations.length,1);assert.equal(r.modelOperations[0].status,'uncertain');
 assert.equal(JSON.parse(r.modelOperations[0].outcome).proposal_rejection,c.reason);
 assert.ok(!JSON.stringify(r.attempts).includes(c.text));
});

for(const [index,c] of reviewContextCases.entries())test(`signed MM review ${c.id}: ${c.accept?'advances':'rejects'} without orders`,async t=>{
 const {r,seen}=await run(t,{mode:'reviewContext',index});
 assert.equal(r.orders.n,0);assert.equal(seen.length,c.id.endsWith('-bare')?2:3);assert.equal(r.replay.duplicate,true);
 assert.equal(r.voice.used_calls,1);assert.equal(r.voice.reserved_micros,5000);
 assert.equal(r.modelOperations.length,c.id.endsWith('-bare')?0:1);
 if(c.accept){
  assert.equal(r.state.data.size,'small');assert.equal(r.modelGrant.stopped_reason,null);
  if(r.modelOperations.length)assert.notEqual(r.modelOperations[0].status,'uncertain');
 }else{
  assert.equal(r.state.data.size,undefined);assert.equal(r.state.data.notes,undefined);
  assert.equal(r.modelGrant.stopped_reason,'model_uncertain');assert.equal(r.modelOperations[0].status,'uncertain');
  assert.ok(['quote_negated','size_context_ambiguous'].includes(JSON.parse(r.modelOperations[0].outcome).proposal_rejection));
 }
 assert.ok(!JSON.stringify(r.attempts).includes(c.text));
});
