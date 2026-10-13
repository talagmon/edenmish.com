import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker from '../src/index.js';
import {createOrder} from '../src/db.js';
import {createCharge} from '../src/payment.js';
import {notifyEmail} from '../src/notify.js';
import {makeSession} from '../src/integrations.js';
import {REHEARSAL_ORIGIN,REHEARSAL_PRODUCT,REHEARSAL_SHOP,issueRehearsalRun,activeRehearsal,claimRehearsalOrder,stopRehearsal} from '../src/payment-rehearsal-capability.js';
const NOW=1791788400000;
const flags=['WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'];
async function fixture(t) {
 t.mock.method(Date,'now',()=>NOW);
 t.mock.method(globalThis,'fetch',async()=>assert.fail('Unexpected provider request'));
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
 const DB={prepare(query){const stmt=sql.prepare(query);let args=[];return {bind(...v){args=v;return this},async first(){return stmt.get(...args)||null},async run(){return {meta:{changes:Number(stmt.run(...args).changes)}}},async all(){return {results:stmt.all(...args)}}}},async batch(stmts){sql.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const config={version:1,run_id:'synthetic-rehearsal-001',starts_at:NOW-1000,expires_at:NOW+1799000,shop:'edenmish.myshopify.com',variant_id:'gid://shopify/ProductVariant/999',phone:'+972541234567',email:'buyer@example.com',ops_email:'ops@example.com'};
 const env={DB,WHATSAPP_BOOKING_FULL_CONFIG:'{}',BOOKING_URL:REHEARSAL_ORIGIN,SHOPIFY_SHOP:config.shop,SHOPIFY_ADMIN_TOKEN:'synthetic-only',SHOPIFY_WEBHOOK_SECRET:'synthetic-webhook-secret',SESSION_SECRET:'synthetic-session-secret',AUTO_DRIVER_DISPATCH:'off',SHOPIFY_WEBHOOK_REGISTRATION:'off',PAYMENT_REHEARSAL_ENABLED:'off',PAYMENT_REHEARSAL_CONFIG:JSON.stringify(config)};
 for(const flag of flags)env[flag]='off';
 assert.equal(await issueRehearsalRun(env,{approve:true,version:1,run_id:config.run_id}),true);
 env.PAYMENT_REHEARSAL_ENABLED='on';for(const flag of flags)env[flag]='on';
 const input={name:'Synthetic buyer',phone:config.phone,email:config.email,service:'standard',price:1,status:'priced',payment_status:'none'};
 const token='a'.repeat(32);
 const create=async()=>{assert.ok(await claimRehearsalOrder(env,input,token));const o=await createOrder(DB,input,{token,source:'whatsapp'});sql.prepare('UPDATE orders SET email=? WHERE id=?').run(input.email,o.id);return {...sql.prepare('SELECT * FROM orders WHERE id=?').get(o.id),email:input.email}};
 return {sql,DB,env,config,input,token,create};
}
const money=n=>({shopMoney:{amount:n,currencyCode:'ILS'},presentmentMoney:{amount:n,currencyCode:'ILS'}});
const totals=()=>({taxesIncluded:true,totalPriceSet:money('1.00'),totalShippingPriceSet:money('0.00'),totalDiscountsSet:money('0.00'),totalTaxSet:money('0.00')});
function network(t,f,{calcPatch={},draftPatch={},auditPatch={},uncertain=false}={}) {
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,`https://${f.config.shop}/admin/api/2026-04/graphql.json`);assert.ok(options.signal);
  const body=JSON.parse(options.body);calls.push(body);
  if(body.query.includes('query RehearsalAudit'))return Response.json({data:{shop:{id:REHEARSAL_SHOP,myshopifyDomain:f.config.shop,currencyCode:'ILS',taxesIncluded:true},product:{id:REHEARSAL_PRODUCT,status:'DRAFT',variants:{nodes:[{id:f.config.variant_id,sku:'EDENMISH-PAYMENT-REHEARSAL-1ILS',price:'1.00',taxable:false,inventoryItem:{tracked:false,requiresShipping:false}}],pageInfo:{hasNextPage:false}},resourcePublications:{nodes:[],pageInfo:{hasNextPage:false}}},...auditPatch}});
  if(body.query.includes('draftOrderCalculate'))return Response.json({data:{draftOrderCalculate:{calculatedDraftOrder:{...totals(),...calcPatch},userErrors:[]}}});
  if(uncertain)throw Error('synthetic connection lost');
  return Response.json({data:{draftOrderCreate:{draftOrder:{id:'gid://shopify/DraftOrder/123',legacyResourceId:'123',invoiceUrl:'https://pay.edenmish.com/invoice/123',...totals(),...draftPatch},userErrors:[]}}});
 });return calls;
}
function paid(f,order,overrides={}) {
 const body=JSON.stringify({id:777,draft_order_id:123,total_price:'1.00',currency:'ILS',financial_status:'paid',line_items:[{quantity:1,variant_id:999,properties:[{name:'_tracking_token',value:order.token},{name:'_edenmish_rehearsal_id',value:f.config.run_id}]}],...overrides});
 return new Request(REHEARSAL_ORIGIN+'/webhooks/shopify/rehearsal',{method:'POST',body,headers:{'X-Shopify-Shop-Domain':f.config.shop,'X-Shopify-Topic':'orders/paid','X-Shopify-Hmac-SHA256':createHmac('sha256',f.env.SHOPIFY_WEBHOOK_SECRET).update(body).digest('base64')}});
}
test('one immutable run claims one order, atomically installs permanent hold and rejects rewrites',async t=>{
 const f=await fixture(t);assert.equal(await activeRehearsal(f.env,{...f.input,email:'unapproved@example.com'}),null);
 const stored=f.sql.prepare('SELECT config_json FROM payment_rehearsal_runs').get().config_json;
 assert.ok(!stored.includes(f.config.phone)&&!stored.includes(f.config.email)&&!stored.includes(f.config.ops_email));
 const order=await f.create();assert.equal(order.rehearsal_run_id,f.config.run_id);
 assert.equal(await claimRehearsalOrder(f.env,f.input,f.token),null);
 assert.equal(await claimRehearsalOrder(f.env,f.input,'b'.repeat(32)),null);
 assert.throws(()=>f.sql.exec("UPDATE orders SET status='delivered'"),/dispatch hold/);
 for(const change of ['order_token=NULL','expires_at=expires_at+1','config_json=\'{}\''])assert.throws(()=>f.sql.exec('UPDATE payment_rehearsal_runs SET '+change),/immutable/);
 await stopRehearsal(f.env);assert.equal(await activeRehearsal(f.env),null);
});
test('canonical insertion rejects wrong amount atomically; claim remains burned',async t=>{
 const f=await fixture(t);assert.ok(await claimRehearsalOrder(f.env,f.input,f.token));
 await assert.rejects(createOrder(f.DB,{...f.input,price:20},{token:f.token,source:'whatsapp'}),/dispatch hold/);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
 assert.equal(await claimRehearsalOrder(f.env,f.input,f.token),null);
});
test('audited dedicated product and exact calculation create one real draft via canonical boundary; duplicate never retries',async t=>{
 const f=await fixture(t),order=await f.create(),calls=network(t,f);
 const result=await createCharge(f.env,order,1);assert.match(result.checkoutUrl,/locale=he/);assert.equal(calls.length,3);
 assert.deepEqual(calls[1].variables,calls[2].variables);
 const input=calls[2].variables.input;assert.equal(input.lineItems[0].variantId,f.config.variant_id);assert.equal(input.email,f.config.email);
 assert.equal(input.acceptAutomaticDiscounts,false);assert.equal(input.allowDiscountCodesInCheckout,false);
 await assert.rejects(createCharge(f.env,order,1),/no_retry/);assert.equal(calls.length,3);
 assert.equal(String(f.sql.prepare('SELECT shopify_draft_order_id FROM orders').get().shopify_draft_order_id),'123');
});
for(const kind of ['wrong-shop','tax','uncertain-create','wrong-created-total','wrong-link'])test('fail closed without retry: '+kind,async t=>{
 const f=await fixture(t),order=await f.create();
 const options=kind==='wrong-shop'?{auditPatch:{shop:{id:'wrong'}}}:kind==='tax'?{calcPatch:{totalTaxSet:money('0.18')}}:kind==='uncertain-create'?{uncertain:true}:kind==='wrong-link'?{draftPatch:{invoiceUrl:'https://attacker.example/invoice'}}:{draftPatch:{totalPriceSet:money('2.00')}};
 const calls=network(t,f,options);await assert.rejects(createCharge(f.env,order,1));const n=calls.length;
 await assert.rejects(createCharge(f.env,order,1),/no_retry/);assert.equal(calls.length,n);
});
test('signed paid webhook after stop reconciles only held order once; app archive preserves payment and dispatch hold',async t=>{
 const f=await fixture(t),order=await f.create();network(t,f);await createCharge(f.env,order,1);await stopRehearsal(f.env);
 t.mock.method(globalThis,'fetch',async()=>assert.fail('Stopped reconciliation must not send'));
 for(let i=0;i<2;i++)assert.equal((await worker.fetch(paid(f,order),f.env)).status,200);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payments').get().n,1);
 assert.equal(f.sql.prepare('SELECT payment_status FROM orders').get().payment_status,'paid');
 const headers={'X-Ops':await makeSession(f.env)};
 const list=await(await worker.fetch(new Request(REHEARSAL_ORIGIN+'/api/ops/orders',{headers}),f.env)).json();assert.equal(list.orders[0].rehearsal_run_id,f.config.run_id);
 assert.equal((await worker.fetch(new Request(REHEARSAL_ORIGIN+`/api/ops/orders/${order.id}/rehearsal/close`,{method:'POST',headers}),f.env)).status,200);
 assert.ok(f.sql.prepare('SELECT rehearsal_closed_at FROM orders').get().rehearsal_closed_at);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payments').get().n,1);
});
for(const patch of [{line_items:[{variant_id:888,quantity:1,properties:[{name:'_tracking_token',value:'a'.repeat(32)},{name:'_edenmish_rehearsal_id',value:'synthetic-rehearsal-001'}]}]},{draft_order_id:456},{currency:'USD'},{total_price:'1.01'}])test('held payment requires exact signed draft, amount and currency: '+JSON.stringify(patch),async t=>{
 const f=await fixture(t),order=await f.create();network(t,f);await createCharge(f.env,order,1);
 await worker.fetch(paid(f,order,patch),f.env);
 assert.equal(f.sql.prepare('SELECT payment_status FROM orders').get().payment_status,'mismatch');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payments').get().n,0);
});
test('private runtime blocks public order, wallet, driver and old webhook paths; Ops shell stays local',async t=>{
 const f=await fixture(t);
 for(const path of ['/api/orders','/business','/api/driver/v1/shift','/webhooks/shopify'])assert.equal((await worker.fetch(new Request(REHEARSAL_ORIGIN+path,{method:'POST',body:'{}'}),f.env)).status,403);
 assert.equal((await worker.fetch(new Request(REHEARSAL_ORIGIN+'/ops'),f.env)).status,200);
 assert.equal((await worker.fetch(new Request(REHEARSAL_ORIGIN+'/api/ops/payment-rehearsal/grant',{method:'POST',body:'{}'}),f.env)).status,401);
});
test('email attempts are capped, labelled and recipient restricted; expiry/stop blocks sends',async t=>{
 const f=await fixture(t),order=await f.create(),sent=[];f.env.SENDGRID_API_KEY='synthetic-only';
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.match(url,/sendgrid/);sent.push(JSON.parse(options.body));return new Response(null,{status:202})});
 const send=recipient=>notifyEmail(f.env,f.DB,{orderId:order.id,template:'customer_otp',recipient,subject:'OTP',html:'synthetic'});
 assert.equal((await send('other@example.com')).skipped,true);
 for(let i=0;i<5;i++)await send(f.config.email);
 assert.equal(sent.length,4);assert.match(sent[0].subject,/ללא משלוח/);
 await stopRehearsal(f.env);assert.equal((await send(f.config.email)).skipped,true);assert.equal(sent.length,4);
});
test('expiry invalidates capability before any external side effects',async t=>{
 const f=await fixture(t),order=await f.create();t.mock.method(Date,'now',()=>f.config.expires_at);
 assert.equal(await activeRehearsal(f.env),null);await assert.rejects(createCharge(f.env,order,1),/no_retry/);
});

test('documented orders payload without draft ID reconciles via signed run/token/variant; later pending event cannot downgrade payment',async t=>{
 const f=await fixture(t),order=await f.create();network(t,f);await createCharge(f.env,order,1);
 await worker.fetch(paid(f,order,{draft_order_id:null}),f.env);
 assert.equal(f.sql.prepare('SELECT payment_status FROM orders').get().payment_status,'paid');
 await worker.fetch(paid(f,order,{draft_order_id:null,financial_status:'pending'}),f.env);
 assert.equal(f.sql.prepare('SELECT payment_status FROM orders').get().payment_status,'paid');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payments').get().n,1);
});
test('operator takeover between calculation and creation blocks the external draft without retries',async t=>{
 const f=await fixture(t),order=await f.create(),calls=network(t,f);
 await assert.rejects(createCharge(f.env,order,1,{canProceed:async()=>calls.length<2}),/no_retry/);
 assert.equal(calls.length,2);assert.equal(f.sql.prepare('SELECT shopify_draft_order_id FROM orders').get().shopify_draft_order_id,null);
 await assert.rejects(createCharge(f.env,order,1),/no_retry/);assert.equal(calls.length,2);
});

test('wrong Shopify store and unsigned events cannot reconcile private order',async t=>{
 const f=await fixture(t),order=await f.create();network(t,f);await createCharge(f.env,order,1);
 let req=paid(f,order);req.headers.set('X-Shopify-Shop-Domain','other.myshopify.com');assert.equal((await worker.fetch(req,f.env)).status,403);
 req=paid(f,order);req.headers.set('X-Shopify-Hmac-SHA256','bad');assert.equal((await worker.fetch(req,f.env)).status,401);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM payments').get().n,0);
});

test('proposed carry-forward template is inert until bound and preserves prior authority/holds',async t=>{
 const f=await fixture(t);
 f.sql.exec(`CREATE TABLE eden_setup_authority(id INTEGER PRIMARY KEY,provider_cap_micros INTEGER,provider_retained_micros INTEGER);
 INSERT INTO eden_setup_authority VALUES(1,2000000,1805204);
 CREATE TRIGGER eden_setup_block_full_budget BEFORE INSERT ON whatsapp_full_booking_budgets BEGIN SELECT RAISE(ABORT,'setup blocked'); END;`);
 const template=readFileSync(new URL('../provisioning/payment-rehearsal-release.sql.template',import.meta.url),'utf8');
 f.sql.exec('BEGIN');assert.throws(()=>f.sql.exec(template),/CHECK/);f.sql.exec('ROLLBACK');
 assert.ok(f.sql.prepare("SELECT name FROM sqlite_master WHERE name='eden_setup_block_full_budget'").get());
 const sql=template.replace('__APPROVAL_SHA256__','a'.repeat(64)).replace('__APPROVED_ROOT_BINDING_SHA256__','b'.repeat(64));
 f.sql.exec('BEGIN');f.sql.exec(sql);f.sql.exec('COMMIT');
 const insert=f.sql.prepare('INSERT INTO whatsapp_full_booking_budgets(environment,budget_id,binding_hash,cap_micros,retained_micros,created_at) VALUES(?,?,?,?,?,?)');
 for(const cap of [2000000,4000000])assert.throws(()=>insert.run('staging','edenmish-rehearsal-budget-20261012-a','b'.repeat(64),cap,1805204,NOW),/carry-forward/);
 assert.throws(()=>insert.run('staging','edenmish-rehearsal-budget-20261012-a','b'.repeat(64),3250000,0,NOW),/carry-forward/);
 insert.run('staging','edenmish-rehearsal-budget-20261012-a','b'.repeat(64),3250000,1805204,NOW);
 assert.equal(f.sql.prepare('SELECT provider_retained_micros FROM eden_setup_authority').get().provider_retained_micros,1805204);
 assert.throws(()=>f.sql.exec('UPDATE eden_rehearsal_release_approval SET retained_micros=0'),/immutable/);
});

test('reviewable Ops page exposes one-shot metadata-only issuance and never renders credentials',async()=>{
 const {rehearsalOpsHtml}=await import('../src/payment-rehearsal-ops.js');
 const {Script}=await import('node:vm');
 const html=rehearsalOpsHtml({run_id:'synthetic-rehearsal-001',starts_at:NOW,expires_at:NOW+1800000},{grant_id:'synthetic-grant',budget_id:'synthetic-budget',source_sha256:'a'.repeat(64)});
 assert.match(html,/sessionStorage.setItem/);assert.match(html,/credentials:'same-origin'/);
 assert.doesNotMatch(html,/api.openai|api.twilio|SHOPIFY_ADMIN_TOKEN|OPS_PIN/);
 new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 assert.match(rehearsalOpsHtml({run_id:'synthetic-rehearsal-001',starts_at:NOW,expires_at:NOW+1800000},{},{off:false}),/id="run" disabled/);
});
