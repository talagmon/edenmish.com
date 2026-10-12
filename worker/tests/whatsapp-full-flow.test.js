import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import worker from '../src/index.js';
import { startDriverShift } from '../src/driver-dispatch.js';
import { issueFullBookingGrant, stopFullBookingGrant } from '../src/whatsapp-full-booking.js';
import { makeSession } from '../src/integrations.js';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const phone = '+972541234567';
const SID = 'AC' + '1'.repeat(32);
const FROM = 'whatsapp:+15551234567';
const URL = 'https://ops-staging.edenmish.com/webhooks/twilio/booking';
const schema = readFileSync(new globalThis.URL('../schema.sql', import.meta.url), 'utf8');
const databases = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; while (databases.length) databases.pop().close(); });
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema); databases.push(sqlite);
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql); let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } };
  }, async batch(statements) { sqlite.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
}
const environment = (DB) => ({ DB, SESSION_SECRET: 'local-test-secret', WHATSAPP_BOOKING_STORAGE_READY: 'on', WHATSAPP_BOOKING_ENABLED: 'on', WHATSAPP_BOOKING_PRIVACY_APPROVED: 'on', WHATSAPP_BOOKING_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'local-test-auth', TWILIO_BOOKING_FROM: FROM, TWILIO_BOOKING_WEBHOOK_URL: URL, TWILIO_RECIPIENT_POLICY: 'allowlist', TWILIO_RECIPIENT_ALLOWLIST: phone });
const details = ['קטן', 'דיזנגוף 10, תל אביב', 'ביאליק 2, רמת גן', '2026-10-11 11:00', 'Test Person', 'test@example.com', 'אין', 'אין', 'ספר'];
function sign(form, url = URL, secret = 'local-test-auth') {
  let message = url; for (const key of [...form.keys()].sort()) message += key + form.get(key);
  return createHmac('sha1', secret).update(message).digest('base64');
}
function request(text, id = 'SM' + '2'.repeat(32), overrides = {}) {
  const form = new URLSearchParams({ AccountSid: SID, MessageSid: id, From: 'whatsapp:' + phone, To: FROM, Body: text, NumMedia: '0', ...overrides });
  return { form, req: new Request(URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(form) }, body: form.toString() }) };
}
function messageResource(id, at = NOW, overrides = {}) { return { sid: id, account_sid: SID, direction: 'inbound', from: 'whatsapp:' + phone, to: FROM, date_created: new Date(at).toUTCString(), ...overrides }; }

function installNetworkFixtures(env, { chargeFails = false, sol = false, transformModel = value => value, autoConsume=true } = {}) {
  const outbound=[],emails=[],unexpected=[],modelRequests=[],queued=[];
  if(env.WHATSAPP_BOOKING_FULL_CONFIG)env.WHATSAPP_BOOKING_QUEUE={send:async body=>queued.push(body)}; const messages = new Map(); const counts = { charges: 0, sends: 0, emails: 0, models:0 };
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url === 'https://api.openai.com/v1/responses' && sol) {
      counts.models++; const payload=JSON.parse(options.body),input=JSON.parse(payload.input[0].content);modelRequests.push(payload);
      assert.equal(payload.model,'gpt-6.1-sol');assert.deepEqual(payload.reasoning,{effort:'low'});assert.equal(payload.service_tier,'default');assert.equal(payload.store,false);assert.equal(payload.max_output_tokens,1024);
      assert.equal(options.headers.Authorization,'Bearer sk-full-synthetic-only');
      assert.ok(Buffer.byteLength(options.body)<=8192);
      const scripted={
        'אני רוצה לשלוח מעטפה עם מסמכים מבני משא 16 תל אביב':[['size','מעטפה עם מסמכים'],['pickup','מבני משא 16 תל אביב']],
        'אני רוצה לשלוח מעטפה עם מסמכים מבני משה 16 תל אביב':[['size','מעטפה עם מסמכים'],['pickup','מבני משה 16 תל אביב']],
        'לקריניצי 111 רמת גן בבוקר':[['dropoff','לקריניצי 111 רמת גן'],['schedule','בבוקר']],
        'Test Person':[['name','Test Person']], 'test@example.com':[['email','test@example.com']],
      };
      const entries=scripted[input.customer_message];assert.ok(entries,'Unscripted model turn');
      const proposal={version:4,intent:'update',fields:entries.map(([field,quote])=>({field,quote})),topic:null,clarify_field:null,reply_language:'he',reply_style:'friendly'};
      return Response.json(transformModel({status:'completed',model:'gpt-6.1-sol',service_tier:'default',usage:{total_tokens:1381,input_tokens:1181,input_tokens_details:{cached_tokens:0},output_tokens:200,output_tokens_details:{reasoning_tokens:40}},output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(proposal)}]}]}));
    }
    if (url === 'https://api.sendgrid.com/v3/mail/send') { counts.emails++; emails.push(JSON.parse(options.body)); return new Response(null, { status: 202 }); }
    if (/api.twilio.com.*\/Messages\/SM/.test(url)) return Response.json(messages.get(url.split('/').pop().slice(0, -5)));
    if (url.includes('places.googleapis.com/v1/places:searchText')) {
      const q = JSON.parse(options.body).textQuery; const parts = /^(.*?) (\d+),? (.*?), ישראל$/.exec(q);assert.ok(parts,'Unexpected address query shape');
      return Response.json({ places: [{ formattedAddress: q.replace('משא','משה'), location: { latitude: 32.08, longitude: 34.78 }, addressComponents: [ { types: ['route'], longText: parts[1].replace('משא','משה') }, { types: ['street_number'], longText: parts[2] }, { types: ['locality'], longText: parts[3] }, { types: ['country'], longText: 'ישראל' } ] }] });
    }
    if (url.endsWith('/webhooks.json')&&(!options.method||options.method==='GET')) return Response.json({webhooks:['orders/paid','orders/updated','refunds/create'].map(topic=>({topic,address:'https://find.edenmish.com/webhooks/shopify'}))});
    if (url.includes('/graphql.json')) {
      const body = JSON.parse(options.body);
      if (body.query.includes('draftOrderCreate')) {
        counts.charges++; if (chargeFails) throw new Error('mock checkout timeout');
        return Response.json({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/123', legacyResourceId: '123', invoiceUrl: 'https://checkout.example/invoice/123' }, userErrors: [] } } });
      }
      unexpected.push('graphql');throw new Error('Unexpected GraphQL operation');
    }
    if (url.endsWith('/Messages.json')) { counts.sends++; outbound.push(Object.fromEntries(new URLSearchParams(options.body))); return Response.json({ sid: 'SM' + (10000+counts.sends).toString(16).padStart(32,'0') }); }
    unexpected.push(url);throw new Error('Blocked unexpected network request');
  };
  let index = 0;
  return { counts, outbound, emails, unexpected, modelRequests, queued, async inbound(text) {
    index++; const id = 'SM' + index.toString(16).padStart(32, '0');
    messages.set(id, messageResource(id, NOW + index * 1000));
    const { req } = request(text, id);const response=await worker.fetch(req,env);
    while(autoConsume && queued.length){const body=queued.shift();await worker.queue({queue:'edenmish-booking-full-staging',messages:[{body,attempts:1,ack(){},retry(){throw Error('Unexpected queue retry');}}]},env);}
    return { response, id };
  }, messages };
}
async function fullReview(env, net) {
  for (const text of ['hello', 'מתחילים', ...details]) assert.equal((await net.inbound(text)).response.status, 200);
  let row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();
  assert.equal(row.phase, 'address_review');
  await net.inbound('1');
  row = env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(); assert.equal(row.phase, 'review'); return row;
}


async function enableFullSol(env) {
 const config={version:1,environment:'staging',budget_id:'synthetic-budget',grant_id:'synthetic-full-grant',source_sha256:'a'.repeat(64),starts_at:NOW,expires_at:NOW+1800000,budget_micros:2000000,retained_micros:0,allocation_micros:1500000,limits:{inbound:30,outbound:30,address:10,model:8},account_sid:SID,sender:FROM,recipients:[phone],booking_url:'https://staging.edenmish.com',webhook_url:URL,execution:'durable-v1',model:'gpt-6.1-sol',reasoning_effort:'low',service_tier:'default',max_output_tokens:1024,input_tokens:16384,request_bytes:8192,soft_timeout_ms:10000,transport_timeout_ms:20000,timeout_ms:30000,costs:{inbound:10300,outbound:11300,address:32000,model:56320}};
 Object.assign(env,{BOOKING_URL:config.booking_url,WHATSAPP_BOOKING_MODE:'full',WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify(config),WHATSAPP_BOOKING_FULL_APPROVED:'on',WHATSAPP_BOOKING_FULL_SCHEMA_READY:'on',WHATSAPP_BOOKING_DURABLE_READY:'on',WHATSAPP_BOOKING_QUEUE:{send:async()=>{}},WHATSAPP_BOOKING_FULL_OPENAI_API_KEY:'sk-full-synthetic-only',WHATSAPP_BOOKING_MODEL:'gpt-6.1-sol',WHATSAPP_BOOKING_REASONING_EFFORT:'low',WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',AUTO_DRIVER_DISPATCH:'off'});
 assert.equal(await issueFullBookingGrant(env,{version:1,grant_id:config.grant_id,budget_id:config.budget_id,source_sha256:config.source_sha256,approve:true},NOW-1000),true);
 Object.assign(env,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
}
async function solReview(env,net) {
 await net.inbound('היי');assert.equal(net.counts.models,0);await net.inbound('1');
 await net.inbound('אני רוצה לשלוח מעטפה עם מסמכים מבני משא 16 תל אביב');
 let state=JSON.parse(env.DB.sqlite.prepare('SELECT state_json FROM whatsapp_booking_conversations').get().state_json);
 assert.equal(state.data.pickup,'בני משה 16',JSON.stringify({state,counts:net.counts,ops:env.DB.sqlite.prepare('SELECT kind,status,diagnostics_json FROM whatsapp_full_booking_operations').all()}));assert.equal(state.data.dropoff,undefined);assert.equal(state.data.size,'small');
 await net.inbound('לקריניצי 111 רמת גן בבוקר');
 state=JSON.parse(env.DB.sqlite.prepare('SELECT state_json FROM whatsapp_booking_conversations').get().state_json);
 assert.equal(state.data.when_date,undefined);assert.equal(state.menu.kind,'schedule_day');
 // Day is explicit, then an offered numbered slot; daypart never invents a date.
 await net.inbound('2');await net.inbound('1');
 await net.inbound('Test Person');await net.inbound('test@example.com');
 await net.inbound('אין');await net.inbound('אין');
 let row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();
 assert.equal(row.phase,'address_review');assert.match(net.outbound.at(-1).Body,/בני משה/);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
 await net.inbound('1');row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();assert.equal(row.phase,'review');
 assert.equal(net.counts.models,3);assert.ok(net.modelRequests[1].input[0].content.includes('pickup'));
 return row;
}

// All provider boundaries are intercepted by installNetworkFixtures. This is a
// joined canonical pipeline test, not an actual model, payment or driver trip.
for (const sol of [false,true]) test(`${sol?'Sol low partial text':'deterministic'} same WhatsApp order: sent invoice, signed paid event, OTP, authenticated pickup/delivery, unique notice`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+60000});
 const env={...environment(database()),WHATSAPP_BOOKING_SEND_ENABLED:'on',GOOGLE_PLACES_SERVER_KEY:'mock',SHOPIFY_SHOP:'mock.myshopify.com',SHOPIFY_ADMIN_TOKEN:'mock',SHOPIFY_WEBHOOK_SECRET:'webhook-mock',SENDGRID_API_KEY:'mock',OPS_EMAIL:'ops@example.com'};
 if(sol)await enableFullSol(env);
 const net=installNetworkFixtures(env,{sol});await (sol?solReview:fullReview)(env,net);const confirmed=await net.inbound('1');assert.equal(confirmed.response.status,200);
 let order=env.DB.sqlite.prepare('SELECT * FROM orders').get();assert.equal(order.source_channel,'whatsapp');assert.equal(order.payment_status,'link_sent');assert.equal(net.counts.charges,1);
 const invoiceMessages=()=>net.outbound.filter(m=>m.Body.includes('https://checkout.example/invoice/123'));
 assert.equal(invoiceMessages().length,1);assert.equal(invoiceMessages()[0].To,'whatsapp:'+phone);
 const sent=net.counts.sends;await worker.fetch(request('1',confirmed.id).req,env);assert.equal(net.counts.sends,sent);assert.equal(net.counts.charges,1);
 const paid=async(total,currency='ILS')=>{const body=JSON.stringify({id:567,draft_order_id:123,note:`EdenMish token: ${order.token}`,total_price:String(total),currency,financial_status:'paid'});return worker.fetch(new Request('https://find.edenmish.com/webhooks/shopify',{method:'POST',headers:{'X-Shopify-Hmac-SHA256':createHmac('sha256',env.SHOPIFY_WEBHOOK_SECRET).update(body).digest('base64'),'X-Shopify-Topic':'orders/paid'},body}),env);};
 await paid(1);assert.notEqual(env.DB.sqlite.prepare('SELECT payment_status FROM orders').get().payment_status,'paid');
 if(sol)assert.equal(await stopFullBookingGrant(env),true); // Already-created canonical payment/driver lifecycle survives grant stop.
 await paid(order.price);const afterPaid=net.counts.emails;await paid(order.price);assert.equal(net.counts.emails,afterPaid);
 order=env.DB.sqlite.prepare('SELECT * FROM orders').get();assert.equal(order.payment_status,'paid');assert.equal(order.picked_up_at,null);assert.equal(order.delivered_at,null);
 assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM payments WHERE status='paid'").get().n,1);
 const recipient=m=>m.personalizations?.[0]?.to?.[0]?.email;
 const paidEmails=net.emails.filter(m=>recipient(m)==='test@example.com'&&m.subject.includes('התשלום התקבל'));assert.equal(paidEmails.length,1);
 const opsPaid=net.emails.filter(m=>m.subject.startsWith('תשלום התקבל #'));assert.equal(opsPaid.length,1);assert.equal(recipient(opsPaid[0]),'ops@example.com');
 const html=paidEmails[0].content.find(x=>x.type==='text/html').value,otp=/letter-spacing:6px[^>]*>(\d{6})</.exec(html)?.[1];assert.ok(otp);
 const trackingUrl='https://find.edenmish.com/api/orders/'+order.token;
 assert.equal((await(await worker.fetch(new Request(trackingUrl),env)).json()).otp_pending,false,'active magic-link tracking is available after payment');
 const verified=await worker.fetch(new Request(trackingUrl+'/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:otp})}),env);assert.equal((await verified.json()).verified,true);
 const cookie=verified.headers.get('Set-Cookie')?.split(';')[0];const unlocked=await(await worker.fetch(new Request(trackingUrl,{headers:cookie?{Cookie:cookie}:{}}),env)).json();assert.equal(unlocked.otp_pending,false);assert.equal(unlocked.order.id,order.id);
 const ops=await(await worker.fetch(new Request('https://ops.edenmish.com/api/ops/orders',{headers:{'X-Ops':await makeSession(env)}}),env)).json();assert.equal(ops.orders[0].id,order.id);
 const driveTime=Date.parse(order.when_date+'T08:00:00Z');t.mock.timers.setTime(driveTime);await startDriverShift(env,{now:driveTime});
 const shift=env.DB.sqlite.prepare('SELECT * FROM driver_shifts').get(),installation=randomUUID(),token='synthetic-driver-session-only';
 env.DB.sqlite.prepare('INSERT INTO driver_sessions(id,driver_id,installation_id,login_code_hash,access_token_hash,refresh_token_hash,access_expires_at,refresh_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),shift.driver_id,installation,'synthetic-code',createHash('sha256').update(token).digest('hex'),'synthetic-refresh',driveTime+900000,driveTime+900000,driveTime);
 const deferred=[],ctx={waitUntil:p=>deferred.push(p)};
 const drain=async()=>{while(deferred.length)await Promise.all(deferred.splice(0));};
 async function driverEvent(kind,type){
  const stop=env.DB.sqlite.prepare('SELECT s.*,r.revision FROM driver_route_stops s JOIN driver_routes r ON r.id=s.route_id WHERE s.order_id=? AND s.task_type=? ORDER BY r.revision DESC LIMIT 1').get(order.id,kind);assert.ok(stop);
  const event={event_id:randomUUID(),event_type:type,occurred_at:new Date(Date.now()).toISOString(),recorded_at_monotonic_ms:1,shift_id:shift.id,order_id:'ord_'+order.id,stop_id:stop.stop_id,route_revision_seen:stop.revision,payload:{}};
  const call=()=>worker.fetch(new Request('https://ops.edenmish.com/api/driver/v1/execution-events:batch',{method:'POST',headers:{'Content-Type':'application/json','X-Request-Id':randomUUID(),'X-Device-Installation-Id':installation,'X-Client-Version':'1.0.0+1',Authorization:'Bearer '+token},body:JSON.stringify({events:[event]})}),env,ctx);
  const response=await call();assert.equal(response.status,200);const body=await response.json();assert.equal(body.results[0].status,'accepted',JSON.stringify(body));await drain();return call;
 }
 await driverEvent('pickup','navigation_started');await driverEvent('pickup','pickup_completed');
 order=env.DB.sqlite.prepare('SELECT * FROM orders').get();assert.ok(order.picked_up_at);assert.equal(order.delivered_at,null);
 await driverEvent('dropoff','navigation_started');const replay=await driverEvent('dropoff','delivery_completed');
 order=env.DB.sqlite.prepare('SELECT * FROM orders').get();assert.equal(order.status,'delivered');assert.ok(order.delivered_at);
 const deliveredCount=net.counts.emails;assert.equal((await(await replay()).json()).results[0].status,'duplicate');await drain();assert.equal(net.counts.emails,deliveredCount);
 const deliveryEmails=net.emails.filter(m=>m.subject==='המשלוח מ-EdenMish נמסר ✓');assert.equal(deliveryEmails.length,1);assert.equal(recipient(deliveryEmails[0]),'test@example.com');assert.ok(deliveryEmails[0].content.find(x=>x.type==='text/html').value.includes('/delivered.html?t='+order.token));
 const jobs=env.DB.sqlite.prepare("SELECT * FROM delivery_notification_outbox WHERE order_id=? AND transition='delivered'").all(order.id);assert.equal(jobs.length,1);assert.equal(jobs[0].channel,'email');assert.equal(jobs[0].state,'sent');
 assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,1);assert.equal(net.counts.charges,1);assert.equal(invoiceMessages().length,1);
 t.mock.timers.setTime(driveTime+86400001);
 const locked=await(await worker.fetch(new Request(trackingUrl),env)).json();assert.equal(locked.otp_pending,true);assert.equal(locked.order.pickup,undefined);
 assert.equal((await(await worker.fetch(new Request(trackingUrl+'/resend-otp',{method:'POST'}),env)).json()).ok,true);
 const otpEmail=net.emails.at(-1);assert.equal(recipient(otpEmail),'test@example.com');const freshOtp=/letter-spacing:6px[^>]*>(\d{6})</.exec(otpEmail.content.find(x=>x.type==='text/html').value)?.[1];assert.ok(freshOtp);
 const unlock=await worker.fetch(new Request(trackingUrl+'/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:freshOtp})}),env);assert.equal((await unlock.json()).verified,true);
 const unlockCookie=unlock.headers.get('Set-Cookie')?.split(';')[0];assert.ok(unlockCookie);
 const final=await(await worker.fetch(new Request(trackingUrl,{headers:{Cookie:unlockCookie}}),env)).json();assert.equal(final.otp_pending,false);assert.equal(final.order.status,'delivered');assert.equal(final.order.id,order.id);await drain();assert.deepEqual(net.unexpected,[]);
});

for(const category of ['proposal_schema','usage_unverified','expired','settlement_unconfirmed'])test(`joined Sol ${category}: one held attempt, no guessed fields/order/retry, bounded diagnostic`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+60000});
 const env={...environment(database()),GOOGLE_PLACES_SERVER_KEY:'mock'};await enableFullSol(env);
 if(category==='settlement_unconfirmed') {
  const prepare=env.DB.prepare.bind(env.DB);
  env.DB.prepare=sql=>{const stmt=prepare(sql),bind=stmt.bind;let values=[];stmt.bind=function(...args){values=args;return bind.apply(this,args);};const run=stmt.run;stmt.run=async()=>sql.startsWith('UPDATE whatsapp_full_booking_operations SET status=') && values[0]==='settled' && values.includes('model')?{meta:{changes:0}}:run.call(stmt);return stmt;};
 }
 const net=installNetworkFixtures(env,{sol:true,transformModel:value=>{
  if(category==='proposal_schema')value.output[1].content[0].text=JSON.stringify({version:4,intent:'create',fields:[],topic:null,clarify_field:null,reply_language:'he',reply_style:'friendly'});
  if(category==='usage_unverified')value.usage.total_tokens=1;
  if(category==='expired')t.mock.timers.setTime(NOW+1800000);
  return value;
 }});
 await net.inbound('היי');await net.inbound('1');const failed=await net.inbound('אני רוצה לשלוח מעטפה עם מסמכים מבני משה 16 תל אביב');
 const row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(),state=JSON.parse(row.state_json);
 assert.equal(state.data.pickup,undefined);assert.equal(state.data.size,undefined);
 assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,0);assert.equal(net.counts.models,1);assert.equal(net.counts.charges,0);
 const operation=env.DB.sqlite.prepare("SELECT * FROM whatsapp_full_booking_operations WHERE kind='model'").get();
 assert.equal(operation.status,'uncertain');assert.equal(operation.reserved_micros,56320);
 const diagnostic=JSON.parse(operation.diagnostics_json);assert.equal(diagnostic.outcome,category==='expired'?'timeout':category);
 assert.doesNotMatch(operation.diagnostics_json,/משה|מסמכים|sk-|output_text|customer_message/);
 if(category==='proposal_schema')assert.equal(diagnostic.proposalRejection,'envelope_values');
 await worker.fetch(request('אני רוצה לשלוח מעטפה עם מסמכים מבני משה 16 תל אביב',failed.id).req,env);assert.equal(net.counts.models,1);
 const opsUrl='https://ops-staging.edenmish.com/api/ops/whatsapp/full/diagnostics';
 assert.equal((await worker.fetch(new Request(opsUrl),env)).status,401);
 const result=await(await worker.fetch(new Request(opsUrl,{headers:{'X-Ops':await makeSession(env)}}),env)).json();
 assert.ok(result.operations.some(op=>op.kind==='model'));assert.doesNotMatch(JSON.stringify(result),/operation_key|recipient|sk-|customer_message/);assert.deepEqual(net.unexpected,[]);
});

test('joined Sol checkout uncertainty keeps one canonical order and prevents a second charge',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+60000});
 const env={...environment(database()),GOOGLE_PLACES_SERVER_KEY:'mock',SHOPIFY_SHOP:'mock.myshopify.com',SHOPIFY_ADMIN_TOKEN:'mock',SHOPIFY_WEBHOOK_SECRET:'mock'};await enableFullSol(env);
 const net=installNetworkFixtures(env,{sol:true,chargeFails:true});await solReview(env,net);await net.inbound('1');
 const row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();assert.equal(row.phase,'handoff');assert.ok(row.checkout_started_at);
 assert.equal(net.counts.charges,1);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
 await net.inbound('confirm');assert.equal(net.counts.charges,1);assert.equal(net.outbound.filter(x=>x.Body.includes('https://checkout.example')).length,0);assert.deepEqual(net.unexpected,[]);
});

test('joined Sol preserves typo evidence; canonical correction remains unconfirmed until address review',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+60000});
 const env={...environment(database()),GOOGLE_PLACES_SERVER_KEY:'mock'};await enableFullSol(env);const net=installNetworkFixtures(env,{sol:true});
 await net.inbound('היי');assert.match(net.outbound[0].Body,/OpenAI/);assert.doesNotMatch(net.outbound[0].Body,/לתמלול/);await net.inbound('1');
 await net.inbound('אני רוצה לשלוח מעטפה עם מסמכים מבני משא 16 תל אביב');
 let state=JSON.parse(env.DB.sqlite.prepare('SELECT state_json FROM whatsapp_booking_conversations').get().state_json);
 assert.equal(state.phase,'collect');assert.equal(state.address_confirmed,false);assert.equal(state.data.size,'small');
 assert.match(JSON.parse(net.modelRequests[0].input[0].content).customer_message,/בני משא/);
 assert.match(state.data.pickup,/בני משה 16/);assert.equal(state.data.pickup_city,'תל אביב');assert.equal(state.data.dropoff,undefined);assert.equal(state.audio_consent_at,undefined);
 assert.equal(net.counts.models,1);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,0);assert.deepEqual(net.unexpected,[]);
});

for (const elapsed of [12000, 20000, 30000]) test(`full Sol ${elapsed}ms response: soft warning is independent of hard deadline`, async t => {
 t.mock.timers.enable({apis:['Date'],now:NOW+60000});
 const env={...environment(database()),GOOGLE_PLACES_SERVER_KEY:'mock'};await enableFullSol(env);
 const net=installNetworkFixtures(env,{sol:true,transformModel:value=>{
  // Simulate live consumer heartbeats while advancing the synthetic provider clock.
  for(let advanced=0;advanced<elapsed;advanced+=1000){t.mock.timers.setTime(Date.now()+1000);env.DB.sqlite.prepare("UPDATE whatsapp_booking_jobs SET lease_until=MIN(deadline_at,?) WHERE state='processing' AND lease_until>?").run(Date.now()+5000,Date.now());}
  return value;}});
 await net.inbound('היי');await net.inbound('1');const sends=net.counts.sends;
 await net.inbound('אני רוצה לשלוח מעטפה עם מסמכים מבני משה 16 תל אביב');
 const row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get(),state=JSON.parse(row.state_json);
 const operation=env.DB.sqlite.prepare("SELECT * FROM whatsapp_full_booking_operations WHERE kind='model'").get();
 const diagnostic=JSON.parse(operation.diagnostics_json);
 assert.equal(net.counts.models,1);assert.equal(operation.reserved_micros,56320);
 assert.equal(diagnostic.softLatencyWarning,true);assert.equal(diagnostic.modelLatencyMs,elapsed);assert.equal(diagnostic.verifiedUsage.reasoning,40);
 if(elapsed===12000){
  assert.equal(state.data.pickup,'בני משה 16');assert.equal(operation.status,'settled');assert.equal(diagnostic.outcome,'valid_proposal');
  assert.equal(net.counts.sends,sends+1);assert.equal(diagnostic.verifiedUsage.reasoning,40);
 } else {
  assert.equal(state.data.pickup,undefined);assert.equal(row.phase,'handoff');assert.equal(operation.status,'uncertain');assert.equal(diagnostic.outcome,'timeout');
  assert.equal(net.counts.sends,sends);
 }
 assert.equal(net.counts.charges,0);assert.deepEqual(net.unexpected,[]);
});

test('full turn deadline starts before Twilio resource lookup; adapter cannot restart it', async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+60000});
 const env={...environment(database()),GOOGLE_PLACES_SERVER_KEY:'mock'};await enableFullSol(env);
 const net=installNetworkFixtures(env,{sol:true,transformModel:value=>{t.mock.timers.setTime(Date.now()+16000);return value;}});
 await net.inbound('היי');await net.inbound('1');const sends=net.counts.sends;
 const fetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{const response=await fetch(url,options);if(/Messages\/SM/.test(String(url)))t.mock.timers.setTime(Date.now()+15000);return response;};
 const start=Date.now();await net.inbound('אני רוצה לשלוח מעטפה עם מסמכים מבני משה 16 תל אביב');
 const row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();
 const ingress=env.DB.sqlite.prepare('SELECT created_at,deadline_at FROM whatsapp_booking_full_ingress ORDER BY created_at DESC LIMIT 1').get();
 assert.equal(ingress.created_at,start);assert.equal(ingress.deadline_at,start+30000);
 assert.equal(row.phase,'handoff');assert.equal(JSON.parse(row.state_json).data.pickup,undefined);
 assert.equal(net.counts.models,1);assert.equal(net.counts.sends,sends);assert.equal(net.counts.charges,0);
});

test('full model deadline aborts a stalled response body after20s without retry or automatic reply',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW+60000});
 const env={...environment(database()),GOOGLE_PLACES_SERVER_KEY:'mock'};await enableFullSol(env);
 const net=installNetworkFixtures(env,{sol:true});await net.inbound('היי');await net.inbound('1');const sends=net.counts.sends;
 const fetch=globalThis.fetch;let signal,cancelled=false;let ready;const waiting=new Promise(resolve=>{ready=resolve;});
 globalThis.fetch=async(url,options)=>{
  const response=await fetch(url,options);
  if(String(url)==='https://api.openai.com/v1/responses'){
   signal=options.signal;
   return new Response(new ReadableStream({start(){ready();},cancel(){cancelled=true;}}));
  }
  return response;
 };
 const pending=net.inbound('אני רוצה לשלוח מעטפה עם מסמכים מבני משה 16 תל אביב');await waiting;
 await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(20000);await pending;
 assert.equal(signal.aborted,true);assert.equal(cancelled,true);
 const operation=env.DB.sqlite.prepare("SELECT * FROM whatsapp_full_booking_operations WHERE kind='model'").get();
 assert.equal(operation.status,'uncertain');assert.equal(JSON.parse(operation.diagnostics_json).outcome,'timeout');
 assert.equal(net.counts.models,1);assert.equal(net.counts.sends,sends);assert.equal(net.counts.charges,0);
});


test('full webhook acknowledges durable admission before any model/address/order/outbound work',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+60000});
 const env={...environment(database()),GOOGLE_PLACES_SERVER_KEY:'mock'};await enableFullSol(env);
 const net=installNetworkFixtures(env,{sol:true,autoConsume:false});const received=await net.inbound('היי');
 assert.equal(received.response.status,200);assert.equal(await received.response.text(),'<Response/>');
 assert.equal(net.counts.models,0);assert.equal(net.counts.sends,0);assert.equal(net.counts.charges,0);assert.equal(net.queued.length,1);
 const row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_booking_jobs').get();assert.equal(row.state,'pending');assert.ok(row.payload_cipher);assert.doesNotMatch(row.payload_cipher,/היי/);
 const body=net.queued.shift();await worker.queue({queue:'edenmish-booking-full-staging',messages:[{body,attempts:1,ack(){},retry(){throw Error('unexpected retry');}}]},env);
 assert.equal(net.counts.sends,1);assert.equal(env.DB.sqlite.prepare('SELECT state FROM whatsapp_booking_jobs').get().state,'done');
});
