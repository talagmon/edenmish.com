import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import worker from '../src/index.js';
import { issueRehearsalRun, REHEARSAL_ORIGIN, REHEARSAL_PRODUCT, REHEARSAL_SHOP } from '../src/payment-rehearsal-capability.js';
import { startDriverShift } from '../src/driver-dispatch.js';
import { issueFullBookingGrant, stopFullBookingGrant } from '../src/whatsapp-full-booking.js';
import { makeSession } from '../src/integrations.js';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const phone = '+972541234567';
const SID = 'AC' + '1'.repeat(32);
const FROM = 'whatsapp:+15551234567';
const URL = REHEARSAL_ORIGIN+'/webhooks/twilio/booking';
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
      const money=amount=>({shopMoney:{amount,currencyCode:'ILS'},presentmentMoney:{amount,currencyCode:'ILS'}});
      const totals={taxesIncluded:true,totalPriceSet:money('1.00'),totalShippingPriceSet:money('0.00'),totalDiscountsSet:money('0.00'),totalTaxSet:money('0.00')};
      if(body.query.includes('query RehearsalAudit'))return Response.json({data:{shop:{id:REHEARSAL_SHOP,myshopifyDomain:env.SHOPIFY_SHOP,currencyCode:'ILS',taxesIncluded:true},product:{id:REHEARSAL_PRODUCT,status:'DRAFT',variants:{nodes:[{id:'gid://shopify/ProductVariant/999',sku:'EDENMISH-PAYMENT-REHEARSAL-1ILS',price:'1.00',taxable:false,inventoryItem:{tracked:false,requiresShipping:false}}],pageInfo:{hasNextPage:false}},resourcePublications:{nodes:[],pageInfo:{hasNextPage:false}}}}});
      if(body.query.includes('draftOrderCalculate'))return Response.json({data:{draftOrderCalculate:{calculatedDraftOrder:totals,userErrors:[]}}});
      if (body.query.includes('draftOrderCreate')) {
        counts.charges++; if (chargeFails) throw new Error('mock checkout timeout');
        return Response.json({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/123', legacyResourceId: '123', invoiceUrl: 'https://pay.edenmish.com/invoice/123', ...totals }, userErrors: [] } } });
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
 const config={version:1,environment:'staging',budget_id:'synthetic-budget',grant_id:'synthetic-full-grant',source_sha256:'a'.repeat(64),starts_at:NOW,expires_at:NOW+1800000,budget_micros:2000000,retained_micros:0,allocation_micros:1500000,limits:{inbound:30,outbound:30,address:10,model:8},account_sid:SID,sender:FROM,recipients:[phone],booking_url:REHEARSAL_ORIGIN,webhook_url:URL,execution:'durable-v1',model:'gpt-6.1-sol',reasoning_effort:'low',service_tier:'default',max_output_tokens:1024,input_tokens:16384,request_bytes:8192,soft_timeout_ms:10000,transport_timeout_ms:20000,timeout_ms:30000,costs:{inbound:10300,outbound:11300,address:32000,model:56320}};
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


test('private protected rehearsal: signed WhatsApp natural partial text, numbered confirmation, one checkout, paid event and Ops archive',async t=>{
 t.mock.method(Date,'now',()=>NOW);
 const env=environment(database());
 const config={version:1,run_id:'synthetic-private-rehearsal',starts_at:NOW,expires_at:NOW+1800000,shop:'edenmish.myshopify.com',variant_id:'gid://shopify/ProductVariant/999',phone,email:'test@example.com',ops_email:'ops@example.com'};
 Object.assign(env,{BOOKING_URL:REHEARSAL_ORIGIN,SHOPIFY_SHOP:config.shop,SHOPIFY_ADMIN_TOKEN:'synthetic-only',SHOPIFY_WEBHOOK_SECRET:'synthetic-secret',SHOPIFY_WEBHOOK_REGISTRATION:'off',AUTO_DRIVER_DISPATCH:'off',PAYMENT_REHEARSAL_CONFIG:JSON.stringify(config),PAYMENT_REHEARSAL_ENABLED:'off',WHATSAPP_BOOKING_FULL_CONFIG:'{}',WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',GOOGLE_PLACES_SERVER_KEY:'synthetic-only',SENDGRID_API_KEY:'synthetic-only',OPS_EMAIL:config.ops_email});
 assert.equal(await issueRehearsalRun(env,{version:1,run_id:config.run_id,approve:true}),true);
 await enableFullSol(env);env.PAYMENT_REHEARSAL_ENABLED='on';
 const net=installNetworkFixtures(env,{sol:true});
 await solReview(env,net);
 assert.match(net.outbound.at(-1).Body,/בדיקת תשלום אמיתי/);
 assert.match(net.outbound.at(-1).Body,/₪1/);
 await net.inbound('1');
 const order=env.DB.sqlite.prepare('SELECT * FROM orders').get();
 assert.ok(order,'canonical order created');assert.equal(order.price,1);assert.equal(order.rehearsal_run_id,config.run_id);assert.equal(order.source_channel,'whatsapp');
 assert.equal(order.payment_status,'link_sent');assert.equal(net.counts.charges,1);
 assert.match(net.outbound.at(-1).Body,/pay.edenmish.com/);
 await net.inbound('1');assert.equal(net.counts.charges,1);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
 const body=JSON.stringify({id:777,total_price:'1.00',currency:'ILS',financial_status:'paid',line_items:[{quantity:1,variant_id:999,properties:[{name:'_tracking_token',value:order.token},{name:'_edenmish_rehearsal_id',value:config.run_id}]}]});
 const headers={'X-Shopify-Shop-Domain':config.shop,'X-Shopify-Topic':'orders/paid','X-Shopify-Hmac-SHA256':createHmac('sha256',env.SHOPIFY_WEBHOOK_SECRET).update(body).digest('base64')};
 for(let i=0;i<2;i++)assert.equal((await worker.fetch(new Request(REHEARSAL_ORIGIN+'/webhooks/shopify/rehearsal',{method:'POST',body,headers}),env)).status,200);
 assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM payments').get().n,1);
 const paid=env.DB.sqlite.prepare('SELECT * FROM orders').get();assert.equal(paid.payment_status,'paid');assert.equal(paid.delivered_at,null);assert.equal(paid.picked_up_at,null);
 const opsHeaders={'X-Ops':await makeSession(env)};
 const listed=await(await worker.fetch(new Request(REHEARSAL_ORIGIN+'/api/ops/orders',{headers:opsHeaders}),env)).json();assert.equal(listed.orders[0].rehearsal_run_id,config.run_id);
 assert.equal((await worker.fetch(new Request(REHEARSAL_ORIGIN+`/api/ops/orders/${order.id}/rehearsal/close`,{method:'POST',headers:opsHeaders}),env)).status,200);
 assert.ok(env.DB.sqlite.prepare('SELECT rehearsal_closed_at FROM orders').get().rehearsal_closed_at);
 assert.deepEqual(net.unexpected,[]);assert.equal(net.emails.length,3);assert.ok(net.emails.every(m=>m.subject.includes('ללא משלוח')));
 assert.match(JSON.stringify(net.emails),new RegExp(REHEARSAL_ORIGIN.replaceAll('.','\\.')));
});
