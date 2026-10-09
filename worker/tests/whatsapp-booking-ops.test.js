import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import worker from '../src/index.js';
import { bookingPilotOpsPage } from '../src/whatsapp-booking-ops.js';
const env = { BOOKING_URL: 'https://staging.edenmish.com', WHATSAPP_BOOKING_MODE: 'conversation_only' };
test('pilot operator page is unavailable in production, full mode, other hosts and mutations', async () => {
  for(const [url, overrides, method] of [
    ['https://ops.edenmish.com/pilot-ops', {}, 'GET'],
    ['https://ops-staging.edenmish.com/pilot-ops', {WHATSAPP_BOOKING_MODE:'full'}, 'GET'],
    ['https://ops-staging.edenmish.com/pilot-ops', {BOOKING_URL:'https://edenmish.com'}, 'GET'],
    ['https://ops-staging.edenmish.com/pilot-ops', {}, 'POST'],
  ]) assert.equal(bookingPilotOpsPage(new Request(url,{method}),{...env,...overrides}).status,404);
});
test('pilot operator shell reuses same-origin HttpOnly login and protected booking APIs with no credential embedding', async () => {
  const r = await worker.fetch(new Request('https://ops-staging.edenmish.com/pilot-ops'), {...env, OPS_PIN:'never-embed-this', SESSION_SECRET:'never-embed-secret'}, {});
  const page=await r.text();
  assert.equal(r.status,200); assert.equal(r.headers.get('Cache-Control'),'no-store');
  assert.match(r.headers.get('Content-Security-Policy'),/connect-src 'self'/);
  assert.match(page,/credentials: 'same-origin'/); assert.match(page,/whatsapp\/bookings/); assert.match(page,/\/pause/);
  assert.doesNotMatch(page,/never-embed|sessionStorage|\.innerHTML|api-origin\.js|\/api\/orders/);
  const unauth=await worker.fetch(new Request('https://ops-staging.edenmish.com/api/ops/whatsapp/bookings'),env,{});
  assert.equal(unauth.status,401);
});

const readyEnv = () => ({...env, WHATSAPP_BOOKING_READINESS_CASE:'small_item',
 WHATSAPP_BOOKING_READINESS_APPROVED:'on', WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(Date.now()+600000).toISOString(),
 WHATSAPP_BOOKING_PILOT_PROFILE:'luna-v1',WHATSAPP_BOOKING_PILOT_ID:'edenmish-luna-ui-tests',WHATSAPP_BOOKING_PILOT_BUDGET_READY:'on',
 WHATSAPP_BOOKING_PROVIDER:'twilio',WHATSAPP_BOOKING_MODEL:'gpt-6-luna',WHATSAPP_BOOKING_OPENAI_API_KEY:'sk-synthetic-test-only',
 WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',
 WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',AUTO_DRIVER_DISPATCH:'off',
 TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:'+972541234567',TWILIO_BOOKING_FROM:'whatsapp:+15551234567',TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32)});
const successfulReport = () => ({passed:true,replay:false,outcome:'valid_proposal',diagnostic:{elapsedMs:4100,synthetic:{
 schema_valid:true,counted_input_tokens:1000,output_tokens:100,synthetic_output:'{"intent":"update","fields":[]}'}}});
async function browser({config=readyEnv(), storage=new Map(), fetchProbe=async()=>Response.json(successfulReport()), auth=200, storageError=false}={}) {
 const page=await bookingPilotOpsPage(new Request('https://ops-staging.edenmish.com/pilot-ops'),config).text();
 const source=page.match(/<script>([\s\S]*?)<\/script>/)[1], elements=new Map(), calls=[], timers=new Map(), listeners={};
 let now=Date.now(),timerId=0;
 const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',replaceChildren(){},append(){}});return elements.get(id);};
 runInNewContext(source,{document:{getElementById:element,createElement:()=>({append(){}})},Date:{now:()=>now},
  localStorage:{getItem:k=>{if(storageError)throw Error('blocked');return storage.get(k)||null;},setItem:(k,v)=>{if(storageError)throw Error('blocked');storage.set(k,v);}},
  fetch:async(url,options)=>{calls.push({url,options});return url.endsWith('/readiness')?fetchProbe(url,options):Response.json({disabled:true,bookings:[]},{status:auth});},
  setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),AbortController,
  addEventListener:(type,fn)=>{listeners[type]=fn;}});
 await new Promise(resolve=>setImmediate(resolve));
 return {element,calls,storage,timers,listeners,config,advance(ms){now+=ms;},click:()=>element('run-readiness').onclick(),refresh:()=>element('refresh').onclick(),probes:()=>calls.filter(x=>x.url.endsWith('/readiness'))};
}
test('authenticated readiness UI waits for explicit click, submits fixed body once and sanitizes display',async()=>{
 const b=await browser({fetchProbe:async()=>Response.json({...successfulReport(),error:'secret provider detail',headers:{Authorization:'never-display'}})});
 assert.equal(b.probes().length,0);assert.equal(b.element('run-readiness').disabled,false);
 await Promise.all([b.click(),b.click()]);await b.refresh();await b.click();
 assert.equal(b.probes().length,1);const request=b.probes()[0].options;
 assert.equal(request.method,'POST');assert.equal(request.credentials,'same-origin');assert.deepEqual(JSON.parse(request.body),{case_id:'small_item'});
 assert.equal(request.headers.Authorization,undefined);assert.equal(b.element('run-readiness').disabled,true);
 const result=JSON.parse(b.element('readiness-result').textContent);assert.equal(result.passed,true);assert.equal(result.input_tokens,1000);
 assert.doesNotMatch(b.element('readiness-result').textContent,/secret provider|never-display|Authorization/);
 assert.deepEqual([...b.storage.values()],['submitted']);
});
test('reload after interruption or network uncertainty never resubmits',async()=>{
 const storage=new Map();let release;
 const first=await browser({storage,fetchProbe:()=>new Promise(resolve=>{release=resolve;})});
 const pending=first.click();assert.equal(first.probes().length,1);
 const reloaded=await browser({storage});await reloaded.click();assert.equal(reloaded.probes().length,0);assert.equal(reloaded.element('run-readiness').disabled,true);
 release(Response.json(successfulReport()));await pending;
 const failed=await browser({fetchProbe:async()=>{throw Error('private transport detail');}});await failed.click();await failed.click();
 assert.equal(failed.probes().length,1);assert.match(failed.element('readiness-status').textContent,/אינה ודאית/);
 const afterFailure=await browser({storage:failed.storage});await afterFailure.click();assert.equal(afterFailure.probes().length,0);
});
test('UI timeout aborts once and remains locked after refresh',async()=>{
 const b=await browser({fetchProbe:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))});
 const pending=b.click();const timeout=[...b.timers.values()].find(t=>t.ms===15000);assert.ok(timeout);timeout.fn();await pending;
 await b.refresh();await b.click();assert.equal(b.probes().length,1);assert.equal(b.element('run-readiness').disabled,true);
});
test('disabled, expired, unauthenticated and unavailable local lock prevent invocation',async()=>{
 for(const options of [{config:{...readyEnv(),WHATSAPP_BOOKING_READINESS_APPROVED:'off'}},{auth:401},{storageError:true}]){
  const b=await browser(options);await b.click();assert.equal(b.probes().length,0);
 }
 const b=await browser();b.advance(600001);await b.click();assert.equal(b.probes().length,0);assert.equal(b.element('run-readiness').disabled,true);
});
test('provider failure, invalid JSON and unexpected replay cannot offer a retry or claim success',async()=>{
 for(const fetchProbe of [async()=>new Response('private html',{status:503}),async()=>Response.json({...successfulReport(),replay:true}),
  async()=>Response.json({error:'private error'},{status:401}),async()=>Response.json({...successfulReport(),passed:false,outcome:'proposal_schema'})]){
  const b=await browser({fetchProbe});await b.click();await b.click();assert.equal(b.probes().length,1);
  assert.equal(b.element('run-readiness').disabled,true);assert.doesNotMatch(b.element('readiness-status').textContent,/בדיקת הפענוח הצליחה/);
  assert.doesNotMatch(b.element('readiness-result').textContent,/private/);
 }
});
test('another tab observes persisted lock before attempting a second submission',async()=>{
 const storage=new Map(),first=await browser({storage}),second=await browser({storage});await first.click();
 second.listeners.storage({key:[...storage.keys()][0]});await second.click();assert.equal(second.probes().length,0);
});
