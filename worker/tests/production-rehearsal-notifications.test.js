import {createHmac} from 'node:crypto';
import {persistPaidOrderAndOpsWhatsAppJob} from '../src/delivery-notification-outbox.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {makeSession} from '../src/integrations.js';
import {createOrder} from '../src/db.js';
import {notifyEmail,notifyWhatsApp} from '../src/notify.js';
import {productionRehearsalEnvironment} from '../src/production-rehearsal-context.js';
import {issueRehearsalRun,claimRehearsalOrder,stopRehearsal} from '../src/payment-rehearsal-capability.js';

async function fixture(t) {
 const now=1791788400000;t.mock.method(Date,'now',()=>now);
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
 const DB={prepare(query){const stmt=sql.prepare(query);let args=[];return {bind(...v){args=v;return this},async first(){return stmt.get(...args)||null},async run(){return {meta:{changes:Number(stmt.run(...args).changes)}}}}},async batch(stmts){sql.exec('BEGIN');try{const r=[];for(const stmt of stmts)r.push(await stmt.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const run={version:1,run_id:'synthetic-production-001',starts_at:now-1000,expires_at:now+1799000,shop:'r013gt-fc.myshopify.com',variant_id:'gid://shopify/ProductVariant/999',phone:'+972541234567',email:'buyer@example.com',ops_email:'ops@example.com'};
 const settings={PAYMENT_REHEARSAL_CONFIG:JSON.stringify(run),WHATSAPP_BOOKING_FULL_CONFIG:'{}',PAYMENT_REHEARSAL_ENABLED:'off',WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off'};
 const env={DB,SESSION_SECRET:'synthetic-session',SHOPIFY_SHOP:'edenmish.myshopify.com',SENDGRID_API_KEY:'synthetic-sendgrid',EMAIL_RECIPIENT_POLICY:'open',PRODUCTION_REHEARSAL_SETTINGS:JSON.stringify(settings)};
 const scoped=productionRehearsalEnvironment(env);
 assert.equal(await issueRehearsalRun(scoped,{approve:true,version:1,run_id:run.run_id}),true);
 for(const key of ['PAYMENT_REHEARSAL_ENABLED','WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'])settings[key]='on';
 env.PRODUCTION_REHEARSAL_SETTINGS=JSON.stringify(settings);
 const input={name:'Synthetic buyer',phone:run.phone,email:run.email,service:'standard',price:1,status:'priced',payment_status:'none'};
 const token='c'.repeat(32);assert.ok(await claimRehearsalOrder(productionRehearsalEnvironment(env),input,token));
 const held=await createOrder(DB,input,{token,source:'whatsapp'});
 const ordinary=await createOrder(DB,{...input,price:45},{token:'d'.repeat(32)});
 const sends=[];t.mock.method(globalThis,'fetch',async(url,options)=>{assert.match(String(url),/^https:\/\/api.sendgrid.com\//);sends.push(JSON.parse(options.body));return new Response(null,{status:202})});
 const email=(orderId,recipient=run.email)=>notifyEmail(env,DB,{orderId,template:'customer_otp',recipient,subject:'Receipt',html:'synthetic'});
 return {sql,DB,env,run,held,ordinary,sends,email};
}
test('production callback scopes only marked email; ordinary recipient policy and subject remain unchanged',async t=>{
 const f=await fixture(t);
 assert.equal((await f.email(f.ordinary.id,'other@example.com')).ok,true);
 assert.equal(f.sends[0].subject,'Receipt');
 assert.equal((await f.email(f.held.id,'other@example.com')).skipped,true);
 for(let i=0;i<5;i++)await f.email(f.held.id);
 assert.equal(f.sends.length,5);assert.match(f.sends[1].subject,/ללא משלוח/);
 assert.equal(f.sql.prepare('SELECT email_attempts FROM payment_rehearsal_runs').get().email_attempts,4);
});
for(const state of ['removed','malformed','stopped','expired','different-run'])test(`held notifications stay closed after ${state}; ordinary email still sends`,async t=>{
 const f=await fixture(t);
 if(state==='removed')delete f.env.PRODUCTION_REHEARSAL_SETTINGS;
 if(state==='malformed')f.env.PRODUCTION_REHEARSAL_SETTINGS='{';
 if(state==='stopped')await stopRehearsal(productionRehearsalEnvironment(f.env));
 if(state==='expired')t.mock.method(Date,'now',()=>f.run.expires_at);
 if(state==='different-run'){const s=JSON.parse(f.env.PRODUCTION_REHEARSAL_SETTINGS),r=JSON.parse(s.PAYMENT_REHEARSAL_CONFIG);r.run_id='synthetic-other-run';s.PAYMENT_REHEARSAL_CONFIG=JSON.stringify(r);f.env.PRODUCTION_REHEARSAL_SETTINGS=JSON.stringify(s);}
 assert.equal((await f.email(f.held.id)).skipped,true);
 assert.equal((await notifyWhatsApp(f.env,f.DB,{orderId:f.held.id,messageClass:'delivery_complete',recipient:f.run.phone})).error,'rehearsal_templates_disabled');
 assert.equal((await f.email(f.ordinary.id,'ordinary@example.com')).ok,true);
 assert.equal(f.sends.length,1);
});
test('unconfirmed durable marker fails closed without logging or provider call',async t=>{
 const f=await fixture(t),db={prepare(){throw Error('synthetic database unavailable')}};
 assert.equal((await notifyEmail(f.env,db,{orderId:f.held.id,recipient:f.run.email})).error,'notification_order_unconfirmed');
 assert.equal((await notifyWhatsApp(f.env,db,{orderId:f.held.id,recipient:f.run.phone})).error,'notification_order_unconfirmed');
 assert.equal(f.sends.length,0);
});

test('canonical rehearsal domain is local to scope; Ops cookie-origin grant and close work and reject cross-site calls',async t=>{
 const f=await fixture(t);
 assert.equal(f.env.SHOPIFY_SHOP,'edenmish.myshopify.com');
 assert.equal(productionRehearsalEnvironment(f.env).SHOPIFY_SHOP,'r013gt-fc.myshopify.com');
 const settings=JSON.parse(f.env.PRODUCTION_REHEARSAL_SETTINGS);
 for(const k of ['PAYMENT_REHEARSAL_ENABLED','WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'])settings[k]='off';
 f.env.PRODUCTION_REHEARSAL_SETTINGS=JSON.stringify(settings);
 const cookie='ops_sess='+await makeSession(f.env);
 const send=(path,origin,body)=>worker.fetch(new Request('https://ops.edenmish.com'+path,{method:'POST',headers:{Host:'ops.edenmish.com',Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),f.env);
 const grant={approve:true,version:1,run_id:f.run.run_id};
 assert.equal((await send('/api/ops/payment-rehearsal/grant','https://untrusted.example',grant)).status,403);
 assert.equal((await send('/api/ops/payment-rehearsal/grant','https://ops.edenmish.com',grant)).status,200);
 const path=`/api/ops/orders/${f.held.id}/rehearsal/close`;
 assert.equal((await send(path,'https://untrusted.example',{})).status,403);
 assert.equal(f.sql.prepare('SELECT rehearsal_closed_at FROM orders WHERE id=?').get(f.held.id).rehearsal_closed_at,null);
 assert.equal((await send(path,'https://ops.edenmish.com',{})).status,200);
 assert.ok(f.sql.prepare('SELECT rehearsal_closed_at FROM orders WHERE id=?').get(f.held.id).rehearsal_closed_at);
});

test('explicit retry after marker lookup recovery sends ordinary email only; stopped held order stays closed',async t=>{
 const f=await fixture(t);const broken={prepare(){throw Error('synthetic unavailable')}};
 const args={orderId:f.ordinary.id,template:'customer_payment_confirmation',recipient:'ordinary@example.com',subject:'Receipt',html:'synthetic'};
 assert.equal((await notifyEmail(f.env,broken,args)).error,'notification_order_unconfirmed');assert.equal(f.sends.length,0);
 // A caller must explicitly retry after a confirmed pre-send failure; webhook replay is not recovery.
 assert.equal((await notifyEmail(f.env,f.DB,args)).ok,true);assert.equal(f.sends.length,1);
 await stopRehearsal(productionRehearsalEnvironment(f.env));assert.equal((await f.email(f.held.id)).skipped,true);assert.equal(f.sends.length,1);
 const auditFailure={prepare(q){if(q.startsWith('INSERT INTO notifications'))throw Error('audit unavailable');return f.DB.prepare(q)}};
 assert.equal((await notifyEmail(f.env,auditFailure,args)).ok,true);assert.equal(f.sends.length,2);
});

// Payment recovery exercises the actual signed webhook and atomic D1 boundary.
function paidWebhook(f, order = f.ordinary) {
 order=f.sql.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
 const body=JSON.stringify({id:777,draft_order_id:123,financial_status:'paid',total_price:String(order.price),currency:'ILS',note:`EdenMish token: ${order.token}`,
  line_items:[{quantity:1,variant_id:999,properties:[{name:'_tracking_token',value:order.token},{name:'_edenmish_rehearsal_id',value:f.run.run_id}]}]});
 return new Request('https://ops.edenmish.com/webhooks/shopify',{method:'POST',body,headers:{'X-Shopify-Shop-Domain':f.run.shop,'X-Shopify-Topic':'orders/paid','X-Shopify-Hmac-SHA256':createHmac('sha256','synthetic-webhook').update(body).digest('base64')}});
}
function paymentEnv(f) {f.sql.prepare('UPDATE orders SET email=?').run(f.run.email);return {...f.env,SHOPIFY_WEBHOOK_SECRET:'synthetic-webhook',OPS_EMAIL:f.run.ops_email,AUTO_DRIVER_DISPATCH:'off'};}
function paymentCounts(f,id=f.ordinary.id) {
 return {payments:f.sql.prepare('SELECT count(*) n FROM payments WHERE order_id=?').get(id).n,
 history:f.sql.prepare("SELECT count(*) n FROM status_history WHERE order_id=? AND status='paid'").get(id).n,
 jobs:f.sql.prepare("SELECT count(*) n FROM delivery_notification_outbox WHERE order_id=? AND transition='payment_received'").get(id).n};
}
for(const failure of ['marker-read','payment-write'])test(`signed payment ${failure} outage returns503; recovery and duplicate deliver emails once`,async t=>{
 const f=await fixture(t),env=paymentEnv(f),prepare=f.DB.prepare.bind(f.DB);let broken=true;
 t.mock.method(f.DB,'prepare',q=>{const s=prepare(q);const run=s.run.bind(s);s.run=async()=>{
  if(broken && q.includes(failure==='marker-read'?'notification_marker_confirmed':'INSERT INTO payments'))throw Error('synthetic database outage');
  return run();};return s;});
 const response=await worker.fetch(paidWebhook(f),env);assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:'payment_transition_unavailable'});
 assert.deepEqual(paymentCounts(f),{payments:0,history:0,jobs:0});assert.equal(f.sends.length,0);
 assert.equal(f.sql.prepare('SELECT payment_status FROM orders WHERE id=?').get(f.ordinary.id).payment_status,'none');
 broken=false;
 for(let i=0;i<3;i++)assert.equal((await worker.fetch(paidWebhook(f),env)).status,200);
 assert.deepEqual(paymentCounts(f),{payments:1,history:1,jobs:1});assert.equal(f.sends.length,2);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM notifications').get().n,2);
});
test('ordinary payment does not repeat classification after commit; duplicate leaves OTP and emails unchanged',async t=>{
 const f=await fixture(t),env=paymentEnv(f),prepare=f.DB.prepare.bind(f.DB);
 t.mock.method(f.DB,'prepare',q=>{if(q==='SELECT rehearsal_run_id FROM orders WHERE id=?')throw Error('postcommit marker read unavailable');return prepare(q);});
 assert.equal((await worker.fetch(paidWebhook(f),env)).status,200);
 const before=f.sql.prepare('SELECT * FROM orders WHERE id=?').get(f.ordinary.id);
 assert.equal(f.sends.length,2);assert.ok(f.sends.every(x=>!x.subject.includes('ללא משלוח')));
 assert.equal((await worker.fetch(paidWebhook(f),env)).status,200);
 assert.deepEqual(f.sql.prepare('SELECT * FROM orders WHERE id=?').get(f.ordinary.id),before);
 assert.equal(f.sends.length,2);assert.deepEqual(paymentCounts(f),{payments:1,history:1,jobs:1});
});
test('marker changed since callback validation rolls back instead of confirming with a stale ordinary policy',async t=>{
 const f=await fixture(t);const stale={...f.held,rehearsal_run_id:null};
 await assert.rejects(persistPaidOrderAndOpsWhatsAppJob(f.DB,stale.id,{amountAgorot:100,notificationMarker:stale.rehearsal_run_id}),/payment_transition_unavailable/);
 assert.deepEqual(paymentCounts(f,f.held.id),{payments:0,history:0,jobs:0});assert.equal(f.sends.length,0);
});
for(const stopped of [false,true])test(`marked payment recovery preserves hold and ${stopped?'late stopped silence':'scoped notifications'}`,async t=>{
 const f=await fixture(t),env=paymentEnv(f);
 f.sql.prepare('UPDATE orders SET shopify_draft_order_id=123 WHERE id=?').run(f.held.id);
 if(stopped)await stopRehearsal(productionRehearsalEnvironment(f.env));
 const prepare=f.DB.prepare.bind(f.DB);let broken=true;
 t.mock.method(f.DB,'prepare',q=>{const s=prepare(q);const run=s.run.bind(s);s.run=async()=>{if(broken&&q.includes('notification_marker_confirmed'))throw Error('outage');return run();};return s;});
 assert.equal((await worker.fetch(paidWebhook(f,f.held),env)).status,503);assert.equal(f.sends.length,0);broken=false;
 for(let i=0;i<2;i++)assert.equal((await worker.fetch(paidWebhook(f,f.held),env)).status,200);
 assert.deepEqual(paymentCounts(f,f.held.id),{payments:1,history:1,jobs:1});assert.equal(f.sends.length,stopped?0:2);
 assert.ok(f.sends.every(x=>x.subject.includes('ללא משלוח')));
 assert.throws(()=>f.sql.prepare("UPDATE orders SET status='to_pickup' WHERE id=?").run(f.held.id),/dispatch hold/);
});
test('manual paid route returns503 on marker outage and succeeds once after recovery',async t=>{
 const f=await fixture(t),env=paymentEnv(f),prepare=f.DB.prepare.bind(f.DB);let broken=true;
 t.mock.method(f.DB,'prepare',q=>{if(broken&&q.includes('notification_marker_confirmed'))throw Error('outage');return prepare(q);});
 const session=await makeSession(env);const request=()=>new Request(`https://ops.edenmish.com/api/ops/orders/${f.ordinary.id}/status`,{method:'POST',headers:{'X-Ops':session,'Content-Type':'application/json'},body:JSON.stringify({status:'paid'})});
 assert.equal((await worker.fetch(request(),env)).status,503);assert.equal(f.sends.length,0);broken=false;
 for(let i=0;i<2;i++)assert.equal((await worker.fetch(request(),env)).status,200);
 assert.deepEqual(paymentCounts(f),{payments:1,history:1,jobs:1});assert.equal(f.sends.length,2);
});
test('payment notification proof rejects forged, cross-order, cross-DB, wrong-template and repeated uses',async t=>{
 const f=await fixture(t);const {paymentScope}=await persistPaidOrderAndOpsWhatsAppJob(f.DB,f.ordinary.id,{amountAgorot:4500,notificationMarker:null});
 const args={orderId:f.ordinary.id,template:'customer_payment_confirmation',recipient:f.run.email,subject:'Receipt',html:'synthetic',paymentScope};
 for(const patch of [{paymentScope:{}},{orderId:f.held.id},{template:'customer_otp'}])assert.equal((await notifyEmail(f.env,f.DB,{...args,...patch})).error,'notification_order_unconfirmed');
 assert.equal((await notifyEmail(f.env,{},args)).error,'notification_order_unconfirmed');
 assert.equal((await notifyEmail(f.env,f.DB,args)).ok,true);
 assert.equal((await notifyEmail(f.env,f.DB,args)).error,'notification_order_unconfirmed');assert.equal(f.sends.length,1);
});

test('concurrent signed paid callbacks serialize to one transition and one pair of emails',async t=>{
 const f=await fixture(t),env=paymentEnv(f),batch=f.DB.batch.bind(f.DB);let previous=Promise.resolve();
 // Model D1 transaction serialization while allowing both webhooks to read unpaid.
 t.mock.method(f.DB,'batch',statements=>{const next=previous.then(()=>batch(statements));previous=next.catch(()=>{});return next;});
 const responses=await Promise.all([worker.fetch(paidWebhook(f),env),worker.fetch(paidWebhook(f),env)]);
 assert.deepEqual(responses.map(r=>r.status),[200,200]);
 assert.deepEqual(paymentCounts(f),{payments:1,history:1,jobs:1});assert.equal(f.sends.length,2);
});
