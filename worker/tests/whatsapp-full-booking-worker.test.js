import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const code=`
import worker from './src/index.js';
import {makeSession} from './src/integrations.js';
import {FULL_BOOKING_PROFILE,FULL_BOOKING_COSTS,reserveFullBookingOperation} from './src/whatsapp-full-booking.js';
import {processBookingEvent} from './src/whatsapp-booking-store.js';
import {createOfflineBookingModel} from './src/whatsapp-booking-model.js';
import {acceptDurableBookingEvent,decryptBookingJob} from './src/whatsapp-booking-jobs.js';
export default {async fetch(req,{DB}){
 const now=Date.now(),phone='+972541234567';
 const spec={version:1,environment:'staging',budget_id:'full-worker-budget',grant_id:'full-worker-grant',source_sha256:'a'.repeat(64),starts_at:now-1000,expires_at:now+1800000,budget_micros:2000000,retained_micros:100000,allocation_micros:500000,limits:{inbound:10,outbound:10,address:4,model:1},account_sid:'AC'+'1'.repeat(32),sender:'whatsapp:+15551234567',recipients:[phone],booking_url:'https://staging.edenmish.com',webhook_url:'https://ops-staging.edenmish.com/webhooks/twilio/booking',...FULL_BOOKING_PROFILE,costs:FULL_BOOKING_COSTS};
 const env={DB,SESSION_SECRET:'local-synthetic-secret',WHATSAPP_BOOKING_PROVIDER:'twilio',WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify(spec),WHATSAPP_BOOKING_FULL_APPROVED:'on',WHATSAPP_BOOKING_FULL_SCHEMA_READY:'on',WHATSAPP_BOOKING_DURABLE_READY:'on',WHATSAPP_BOOKING_QUEUE:{send:async()=>{}},WHATSAPP_BOOKING_STORAGE_READY:'on',WHATSAPP_BOOKING_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODE:'full',WHATSAPP_BOOKING_MODEL:spec.model,WHATSAPP_BOOKING_REASONING_EFFORT:'low',WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_FULL_OPENAI_API_KEY:'sk-synthetic-worker-only',WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',TWILIO_ACCOUNT_SID:spec.account_sid,TWILIO_AUTH_TOKEN:'synthetic',TWILIO_BOOKING_FROM:spec.sender,TWILIO_BOOKING_WEBHOOK_URL:spec.webhook_url,TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:phone,BOOKING_URL:spec.booking_url};
 const grantBody=JSON.stringify({version:1,grant_id:spec.grant_id,budget_id:spec.budget_id,source_sha256:spec.source_sha256,approve:true});
 const url='https://ops-staging.edenmish.com/api/ops/whatsapp/full/grant';
 const unauthorized=await worker.fetch(new Request(url,{method:'POST',body:grantBody}),env);
 const grant=await worker.fetch(new Request(url,{method:'POST',headers:{'X-Ops':await makeSession(env),'Content-Type':'application/json'},body:grantBody}),env);
 Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
 const reservations=await Promise.all(['one','one','two'].map(key=>reserveFullBookingOperation(env,'model',key)));
 const event=(id,text,offset)=>({id,phone,text,at:now+offset});
 const base={multilingual:true,order:async()=>null,quote:async()=>{throw Error('unexpected quote');},resolveAddress:async()=>{throw Error('unexpected Maps');}};
 const greet=await processBookingEvent(env,event('greet','היי',1),base,now);
 const consent=await processBookingEvent(env,event('consent','1',2),base,now);
 let release,started;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const services={...base,forEvent:()=>({conversationModel:createOfflineBookingModel(async()=>{started();await gate;return {version:4,intent:'update',fields:[{field:'size',quote:'מעטפה'}],topic:null,clarify_field:null,reply_language:'he',reply_style:'friendly'};})})};
 const pending=processBookingEvent(env,event('slow','אני שולח מעטפה',3),services,now);const enteredFirst=await Promise.race([entered.then(()=>true),pending.then(value=>({value}))]);if(enteredFirst!==true)return Response.json({unexpectedEarlyResult:enteredFirst,greet,consent,issued:grant.status});
 const newer=await processBookingEvent(env,event('newer','חבילה קטנה',4),base,now);release();const stale=await pending;
 const durableEvent=event('durable','בדיקת מעטפה',5);
 const durable=await acceptDurableBookingEvent(env,durableEvent,now);
 const replay=await acceptDurableBookingEvent(env,durableEvent,now+1);
 const jobs=await DB.prepare('SELECT * FROM whatsapp_booking_jobs').all();
 const decrypted=await decryptBookingJob(env,jobs.results[0]);
 const row=await DB.prepare('SELECT * FROM whatsapp_booking_conversations').first();
 const budget=await DB.prepare('SELECT allocated_micros,held_micros,retained_micros FROM whatsapp_full_booking_budgets').first();
 const grantRow=await DB.prepare('SELECT model,inbound FROM whatsapp_full_booking_grants').first();
 return Response.json({durable,replay,jobCount:jobs.results.length,cipherContainsText:jobs.results[0].payload_cipher.includes(durableEvent.text),decryptedMatches:decrypted.text===durableEvent.text,unauthorized:unauthorized.status,issued:grant.status,winners:reservations.filter(Boolean).length,newer,stale,state:JSON.parse(row.state_json),budget,grant:grantRow,orders:(await DB.prepare('SELECT COUNT(*) n FROM orders').first()).n});
}};`;

test('actual Workerd/D1 full grant, trigger quota race and slow-turn correction fencing without network',async t=>{
 const bundle=await build({stdin:{contents:code,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:()=>{throw Error('Unexpected network');}});t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 const response=await mf.dispatchFetch('http://localhost/');const body=await response.text();assert.equal(response.status,200,body);const result=JSON.parse(body);
 assert.equal(result.unauthorized,401,body);assert.equal(result.issued,201);assert.equal(result.winners,1);
 assert.equal(result.newer.busy,true);assert.equal(result.stale.superseded,true);assert.equal(result.state.data.size,undefined);
 assert.equal(result.grant.model,1);assert.equal(result.grant.inbound,5);assert.equal(result.durable.status,200);assert.equal(result.replay.status,200);assert.equal(result.jobCount,1);assert.equal(result.cipherContainsText,false);assert.equal(result.decryptedMatches,true);assert.equal(result.budget.held_micros,56320+5*10300);assert.equal(result.budget.retained_micros,100000);assert.equal(result.budget.allocated_micros,500000);assert.equal(result.orders,0);
});

const queueSetup=code.slice(code.indexOf(' const now=Date.now()'),code.indexOf(' const grantBody='));
const queueCode=`
import worker from './src/index.js';
import {FULL_BOOKING_PROFILE,FULL_BOOKING_COSTS,issueFullBookingGrant} from './src/whatsapp-full-booking.js';
import {acceptDurableBookingEvent} from './src/whatsapp-booking-jobs.js';
let runtime;
export default {
 async fetch(req,bindings,ctx){
  const {DB,WHATSAPP_BOOKING_QUEUE}=bindings;
  if(new URL(req.url).pathname==='/status')return Response.json({jobs:(await DB.prepare('SELECT state,payload_cipher FROM whatsapp_booking_jobs').all()).results,events:(await DB.prepare('SELECT COUNT(*) n FROM whatsapp_booking_events').first()).n,replies:(await DB.prepare('SELECT state,provider_ref FROM whatsapp_booking_replies').all()).results,held:(await DB.prepare('SELECT held_micros FROM whatsapp_full_booking_budgets').first())?.held_micros});
  ${queueSetup}
  env.WHATSAPP_BOOKING_QUEUE=WHATSAPP_BOOKING_QUEUE;
  const issued=await issueFullBookingGrant(env,{version:1,grant_id:spec.grant_id,budget_id:spec.budget_id,source_sha256:spec.source_sha256,approve:true});
  Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});runtime=env;
  return Response.json({issued,...await acceptDurableBookingEvent(env,{id:'SM'+'5'.repeat(32),phone,text:'היי',echo:false,at:now},now)});
 },
 async queue(batch,bindings,ctx){await worker.queue(batch,runtime,ctx);}
};`;

test('actual Workerd queue binding wakes the durable consumer and sends once from committed outbox',async t=>{
 const bundle=await build({stdin:{contents:queueCode,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
 let sends=0;
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],queueProducers:{WHATSAPP_BOOKING_QUEUE:'edenmish-booking-full-staging'},queueConsumers:{'edenmish-booking-full-staging':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:2}},outboundService:req=>{
  assert.equal(req.method,'POST');assert.match(req.url,/api\.twilio\.com.*Messages\.json$/);sends++;
  return Response.json({sid:'SM'+'8'.repeat(32)});
 }});t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 const accepted=await(await mf.dispatchFetch('http://localhost/')).json();assert.equal(accepted.issued,true);assert.equal(accepted.status,200);
 let state;
 for(let i=0;i<100;i++){state=await(await mf.dispatchFetch('http://localhost/status')).json();if(state.jobs[0]?.state==='done')break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(state.jobs[0]?.state,'done',JSON.stringify(state));assert.equal(state.jobs[0].payload_cipher,null);assert.equal(state.events,1);assert.equal(state.replies.length,1);assert.equal(state.replies[0].state,'sent');assert.equal(sends,1);assert.equal(state.held,10300+11300);
});

const maintenanceCode=`
import worker from './src/index.js';
import {FULL_BOOKING_PROFILE,FULL_BOOKING_COSTS,issueFullBookingGrant} from './src/whatsapp-full-booking.js';
import {acceptDurableBookingEvent} from './src/whatsapp-booking-jobs.js';
export default {async fetch(req,{DB}){
 ${queueSetup}
 await issueFullBookingGrant(env,{version:1,grant_id:spec.grant_id,budget_id:spec.budget_id,source_sha256:spec.source_sha256,approve:true});
 Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
 await acceptDurableBookingEvent(env,{id:'SM'+'8'.repeat(32),phone,text:'היי',echo:false,at:now},now);
 const source=await DB.prepare('SELECT id FROM whatsapp_booking_conversations').first();
 await DB.prepare('UPDATE whatsapp_booking_conversations SET created_at=? WHERE id=?').bind(now-31*86400000,source.id).run();
 await DB.prepare("INSERT INTO whatsapp_booking_conversations(id,sender_key,provider,recipient,state_json,phase,order_token,checkout_started_at,created_at,updated_at) VALUES('uncertain','hash-retained','twilio','+972541234567',?, 'handoff','invoice-token-retained',?,?,?)")
  .bind(JSON.stringify({phase:'handoff',data:{name:'Synthetic'}}),now-31*86400000,now-31*86400000,now).run();
 await DB.prepare("INSERT INTO whatsapp_booking_full_fences(conversation_id,grant_id) VALUES('uncertain',?)").bind(spec.grant_id).run();
 const before=await DB.prepare('SELECT retained_micros,allocated_micros,held_micros FROM whatsapp_full_booking_budgets').first();
 const tasks=[],originalNow=Date.now;Date.now=()=>now+60000;
 try {await worker.scheduled({cron:'* * * * *',scheduledTime:now-86400000},{DB},{waitUntil:task=>tasks.push(task)});await Promise.all(tasks);} finally {Date.now=originalNow;}
 return Response.json({before,after:await DB.prepare('SELECT retained_micros,allocated_micros,held_micros FROM whatsapp_full_booking_budgets').first(),jobs:(await DB.prepare('SELECT COUNT(*) n FROM whatsapp_booking_jobs').first()).n,ingress:(await DB.prepare('SELECT COUNT(*) n FROM whatsapp_booking_full_ingress').first()).n,conversations:(await DB.prepare('SELECT id,sender_key,recipient,state_json,order_token,checkout_started_at FROM whatsapp_booking_conversations').all()).results,fences:(await DB.prepare('SELECT conversation_id FROM whatsapp_booking_full_fences').all()).results});
}};`;

test('actual Workerd/D1 minute maintenance expires ciphertext, cascades safe metadata and preserves uncertain invoice with DB alone',async t=>{
 const bundle=await build({stdin:{contents:maintenanceCode,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:()=>{assert.fail('maintenance must never call any provider');}});t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 const response=await mf.dispatchFetch('http://localhost/');const text=await response.text();assert.equal(response.status,200,text);const result=JSON.parse(text);
 assert.deepEqual(result.before,result.after);assert.equal(result.before.held_micros,10300);assert.equal(result.jobs,0);assert.equal(result.ingress,0);
 assert.equal(result.conversations.length,1);const row=result.conversations[0];assert.equal(row.id,'uncertain');assert.equal(row.recipient,null);assert.deepEqual(JSON.parse(row.state_json),{phase:'handoff',data:{}});assert.equal(row.sender_key,'hash-retained');assert.equal(row.order_token,'invoice-token-retained');assert.ok(row.checkout_started_at);assert.deepEqual(result.fences,[{conversation_id:'uncertain'}]);
});
