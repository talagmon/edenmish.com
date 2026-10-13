import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import worker from '../src/index.js';
import { createOrder } from '../src/db.js';
import { makeSession } from '../src/integrations.js';
import { productionRehearsalEnvironment } from '../src/production-rehearsal-context.js';
import { issueRehearsalRun, claimRehearsalOrder } from '../src/payment-rehearsal-capability.js';
import { markPaymentRehearsal, closePaymentRehearsal } from '../src/payment-rehearsal.js';
import { syncDriverRoute, buildDispatchTasks } from '../src/driver-dispatch.js';
import { opsHtml } from '../src/pages.js';
import { schemaUploadChunks } from './helpers/install-schema.js';

test('migration upgrades existing schema without losing orders and matches fresh hold triggers', () => {
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const pre052 = fresh.split('\n-- Migration 052:')[0]
    .replace('  rehearsal_run_id TEXT, rehearsal_created_at INTEGER, rehearsal_closed_at INTEGER,\n', '');
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(pre052);
    sql.exec("INSERT INTO orders(id,token,name,price,status,payment_status,created_at) VALUES (999,'synthetic-retained-token','existing',50,'paid','paid',1)");
    sql.exec(readFileSync(new URL('../migrations/052_payment_rehearsal_hold.sql', import.meta.url), 'utf8'));
    sql.exec(readFileSync(new URL('../migrations/053_payment_rehearsal_capability.sql', import.meta.url), 'utf8'));
    const before = sql.prepare('SELECT * FROM orders WHERE id=999').get();
    assert.equal(before.price, 50); assert.equal(before.payment_status, 'paid'); assert.equal(before.rehearsal_run_id, null);
    const upgraded = sql.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'rehearsal_%' ORDER BY name").all();
    const fromFresh = new DatabaseSync(':memory:');
    try {
      fromFresh.exec(fresh);
      assert.deepEqual(upgraded, fromFresh.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'rehearsal_%' ORDER BY name").all());
    } finally { fromFresh.close(); }
    const chunks = schemaUploadChunks(fresh);
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) < 100000));
    assert.throws(() => schemaUploadChunks('x'.repeat(100000)), /schema_upload_too_large/);
    assert.match(schemaUploadChunks("SELECT '-- literal';\n-- stripped\nSELECT 'still literal';")[0], /'-- literal'/);
  } finally { sql.close(); }
});

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return { sqlite, prepare(sql) {
    const stmt = sqlite.prepare(sql); let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return stmt.get(...args) || null; },
      async all() { return { results: stmt.all(...args) }; },
      async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; } };
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}
async function fixture(t) {
  const DB = database(t);
  const now=Date.now();
  const run={version:1,run_id:'synthetic-test-001',starts_at:now-1000,expires_at:now+1799000,
    shop:'r013gt-fc.myshopify.com',variant_id:'gid://shopify/ProductVariant/999',
    phone:'+972541234567',email:'buyer@example.com',ops_email:'ops@example.com'};
  const settings={PAYMENT_REHEARSAL_CONFIG:JSON.stringify(run),WHATSAPP_BOOKING_FULL_CONFIG:'{}',
    PAYMENT_REHEARSAL_ENABLED:'off',WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off'};
  const env={DB,SESSION_SECRET:'synthetic-session-secret',SHOPIFY_WEBHOOK_SECRET:'synthetic-webhook-secret',
    SHOPIFY_SHOP:'edenmish.myshopify.com',AUTO_DRIVER_DISPATCH:'off',PRODUCTION_REHEARSAL_SETTINGS:JSON.stringify(settings)};
  assert.equal(await issueRehearsalRun(productionRehearsalEnvironment(env),{approve:true,version:1,run_id:run.run_id}),true);
  for(const k of ['PAYMENT_REHEARSAL_ENABLED','WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'])settings[k]='on';
  env.PRODUCTION_REHEARSAL_SETTINGS=JSON.stringify(settings);
  const input={name:'בדיקה — ללא משלוח',price:1,status:'priced',payment_status:'none',
    phone:run.phone,email:run.email,service:'standard',pickup:'כתובת מוסכמת לבדיקה',dropoff:'כתובת מוסכמת לבדיקה',
    pickup_lat:32.08,pickup_lng:34.78,dropoff_lat:32.09,dropoff_lng:34.79};
  const token='e'.repeat(32);
  assert.ok(await claimRehearsalOrder(productionRehearsalEnvironment(env),input,token));
  const order=await createOrder(DB,input,{token,source:'whatsapp'});
  assert.equal(DB.sqlite.prepare('SELECT rehearsal_run_id FROM orders WHERE id=?').get(order.id).rehearsal_run_id,run.run_id);
  DB.sqlite.prepare('UPDATE orders SET shopify_draft_order_id=123 WHERE id=?').run(order.id);
  const session = await makeSession(env);
  const ops = (suffix, options = {}) => new Request('https://ops.edenmish.com/api/ops/orders' + suffix,
    { ...options, headers: { 'X-Ops': session, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('External calls forbidden'); });
  return { DB, order, env, ops, row: () => DB.sqlite.prepare('SELECT * FROM orders WHERE id=?').get(order.id) };
}
function webhook(f, patch = {}) {
  const body = JSON.stringify({ id: 777, draft_order_id: 123, financial_status: 'paid', total_price: '1.00', currency: 'ILS',
    line_items: [{quantity:1,variant_id:999,properties:[{name:'_tracking_token',value:f.order.token},{name:'_edenmish_rehearsal_id',value:'synthetic-test-001'}]}], ...patch });
  return new Request('https://ops.edenmish.com/webhooks/shopify', { method: 'POST', body,
    headers: { 'X-Shopify-Shop-Domain':'r013gt-fc.myshopify.com', 'X-Shopify-Hmac-SHA256': createHmac('sha256', f.env.SHOPIFY_WEBHOOK_SECRET).update(body).digest('base64'), 'X-Shopify-Topic': 'orders/paid' } });
}

test('real signed paid reconciliation remains in Ops and preserves payment/audit through idempotent closure', async t => {
  const f = await fixture(t);
  f.DB.sqlite.prepare("UPDATE orders SET shopify_draft_order_id=123,payment_status='link_sent',status='payment_sent' WHERE id=?").run(f.order.id);
  for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(webhook(f), f.env)).status, 200);
  assert.equal(f.row().status, 'paid'); assert.equal(f.row().payment_status, 'paid');
  assert.equal(f.row().shopify_order_id, 777);
  const payments = f.DB.sqlite.prepare('SELECT * FROM payments WHERE order_id=?').all(f.order.id);
  assert.equal(payments.length, 1); assert.equal(payments[0].amount, 100);
  let response = await worker.fetch(f.ops(''), f.env);
  assert.equal(response.status, 200); assert.equal((await response.json()).orders[0].rehearsal_run_id, 'synthetic-test-001');
  for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(f.ops(`/${f.order.id}/rehearsal/close`, { method: 'POST' }), f.env)).status, 200);
  assert.ok(f.row().rehearsal_closed_at); assert.equal(f.row().payment_status, 'paid'); assert.equal(f.row().status, 'paid');
  assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM payments WHERE order_id=?').all(f.order.id), payments);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM status_history WHERE note='payment_rehearsal_closed:ops'").get().n, 1);
  assert.equal(f.row().delivered_at, null); assert.equal(f.row().picked_up_at, null);
  response = await worker.fetch(f.ops(''), f.env);
  assert.ok((await response.json()).orders[0].rehearsal_closed_at, 'Archive stays queryable in app audit');
});

test('test name and customer fields cannot create trusted marker; marking is internal, before payment only', async t => {
  const DB = database(t);
  const order = await createOrder(DB, { name: 'TEST', price: 1, rehearsal_run_id: 'forged-test-001' });
  assert.equal(DB.sqlite.prepare('SELECT rehearsal_run_id FROM orders').get().rehearsal_run_id, null);
  DB.sqlite.prepare("UPDATE orders SET payment_status='paid',status='paid' WHERE id=?").run(order.id);
  assert.equal((await markPaymentRehearsal(DB, { orderId: order.id, runId: 'synthetic-test-002', actor: 'ops_fixture' })).error, 'rehearsal_ineligible');
});

test('paid rehearsal retains customer OTP, Ops email and one durable WhatsApp job with mocked sends only', async t => {
  const f = await fixture(t);
  f.env.SENDGRID_API_KEY = 'synthetic-no-provider-key';
  f.env.OPS_EMAIL = 'ops@example.com';
  f.DB.sqlite.prepare('UPDATE orders SET email=? WHERE id=?').run('buyer@example.com', f.order.id);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
    const body = JSON.parse(request.body);
    sent.push({ recipient: body.personalizations[0].to[0].email, subject: body.subject });
    return new Response(null, { status: 202 });
  });
  for (let i=0; i<2; i++) assert.equal((await worker.fetch(webhook(f), f.env)).status, 200);
  assert.deepEqual(sent.map(x => x.recipient), ['buyer@example.com', 'ops@example.com']);
  assert.match(sent[0].subject, /קוד אימות/);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM delivery_notification_outbox WHERE order_id=? AND transition='payment_received' AND channel='whatsapp'").get(f.order.id).n, 1);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id=? AND status='sent'").get(f.order.id).n, 2);
  await closePaymentRehearsal(f.DB, f.order.id);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM notifications WHERE order_id=?').get(f.order.id).n, 2);
  assert.equal(sent.length, 2, 'Closing the record does not send additional notifications');
});

test('physical routes and DB assignments exclude held order while canonical ingestion stays intact', async t => {
  const f = await fixture(t); await worker.fetch(webhook(f), f.env);
  const route = await syncDriverRoute(f.env, { driverId: 'drv_eden', shiftId: 'synthetic-shift' });
  assert.equal(route.empty, true); assert.equal(route.taskCount, 0);
  assert.deepEqual(buildDispatchTasks([f.row()]).tasks, []);
  assert.throws(() => f.DB.sqlite.prepare("INSERT INTO driver_assignments VALUES ('drv_eden','synthetic-shift',?,1,1)").run(f.order.id), /dispatch hold/);
  assert.throws(() => f.DB.sqlite.prepare('INSERT INTO gps_pings(order_id,lat,lng,at) VALUES (?,32,34,1)').run(f.order.id), /dispatch hold/);
  for (const status of ['to_pickup','picked_up','to_dropoff','delivered','failed'])
    assert.throws(() => f.DB.sqlite.prepare('UPDATE orders SET status=? WHERE id=?').run(status, f.order.id), /dispatch hold/);
});

test('Ops cannot manually mark paid, release, reprice or record physical execution for rehearsal', async t => {
  const f = await fixture(t);
  for (const suffix of ['status','approve','gps','deliver','release-redelivery']) {
    const response = await worker.fetch(f.ops(`/${f.order.id}/${suffix}`, { method: 'POST', body: JSON.stringify({ status:'paid',price:1,lat:32,lng:34 }) }), f.env);
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'payment_rehearsal_dispatch_hold');
  }
  const denied = await worker.fetch(new Request(`https://ops.edenmish.com/api/ops/orders/${f.order.id}/rehearsal/close`, {method:'POST'}), f.env);
  assert.equal(denied.status, 401);
});

test('amount mismatch remains mismatch and never produces a successful test payment', async t => {
  const f = await fixture(t);
  await worker.fetch(webhook(f, { total_price: '1.18' }), f.env);
  assert.equal(f.row().payment_status, 'mismatch'); assert.notEqual(f.row().status, 'paid');
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
});

test('marker, closed record and payment amount cannot be rewritten or discarded', async t => {
  const f = await fixture(t); await closePaymentRehearsal(f.DB, f.order.id);
  for (const sql of ['UPDATE orders SET rehearsal_run_id=NULL', 'UPDATE orders SET rehearsal_closed_at=NULL',
    'UPDATE orders SET price=50', 'DELETE FROM orders']) assert.throws(() => f.DB.sqlite.exec(sql), /rehearsal/);
  assert.equal((await markPaymentRehearsal(f.DB, {orderId:f.order.id,runId:'synthetic-test-001',actor:'ops_fixture'})).unchanged, true);
});

test('Ops test action renderer labels hold and offers archive without physical actions', () => {
  const html = opsHtml({});
  const source = html.slice(html.indexOf('function actions(o){'), html.indexOf('function notifPanel(){'));
  const actions = vm.runInNewContext('(' + source + ')');
  const active = actions({id:1,status:'paid',rehearsal_run_id:'synthetic-test-001'});
  assert.match(active, /ללא|אין לבצע איסוף או מסירה/); assert.match(active, /close-rehearsal/);
  assert.doesNotMatch(active, /topickup|markpaid|approve|data-act="gps"/);
  assert.doesNotMatch(actions({id:1,status:'paid',rehearsal_run_id:'synthetic-test-001',rehearsal_closed_at:1}), /close-rehearsal/);
  assert.match(html, /בדיקות תשלום סגורות/);
});

test('authenticated archive survives removed or malformed settings without opening new admission or cross-site mutations',async t=>{
 const f=await fixture(t);
 await worker.fetch(webhook(f),f.env);
 const payments=f.DB.sqlite.prepare('SELECT * FROM payments').all();
 for(const settings of [undefined,'{']){
   if(settings===undefined)delete f.env.PRODUCTION_REHEARSAL_SETTINGS;else f.env.PRODUCTION_REHEARSAL_SETTINGS=settings;
   const path=`https://ops.edenmish.com/api/ops/orders/${f.order.id}/rehearsal/close`;
   assert.equal((await worker.fetch(new Request(path,{method:'POST'}),f.env)).status,401);
   const cookie='ops_sess='+await makeSession(f.env);
   assert.equal((await worker.fetch(new Request(path,{method:'POST',headers:{Cookie:cookie,Origin:'https://untrusted.example'}}),f.env)).status,403);
   assert.equal((await worker.fetch(new Request(path,{method:'POST',headers:{Cookie:cookie,Origin:'https://ops.edenmish.com'}}),f.env)).status,200);
   assert.equal((await worker.fetch(new Request('https://ops.edenmish.com/api/ops/payment-rehearsal/grant',{method:'POST',headers:{Cookie:cookie,Origin:'https://ops.edenmish.com'},body:'{}'}),f.env)).status,503);
 }
 assert.ok(f.row().rehearsal_closed_at);assert.equal(f.row().payment_status,'paid');
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM payments').all(),payments);
 assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM status_history WHERE note='payment_rehearsal_closed:ops'").get().n,1);
});

test('late signed payment after settings removal reconciles once without messages and keeps dispatch hold',async t=>{
 const f=await fixture(t);
 delete f.env.PRODUCTION_REHEARSAL_SETTINGS;
 f.env.SENDGRID_API_KEY='synthetic-no-provider-key';f.env.OPS_EMAIL='ops@example.com';
 f.DB.sqlite.prepare('UPDATE orders SET email=? WHERE id=?').run('buyer@example.com',f.order.id);
 for(let i=0;i<2;i++)assert.equal((await worker.fetch(webhook(f),f.env)).status,200);
 assert.equal(f.row().payment_status,'paid');assert.equal(f.row().rehearsal_run_id,'synthetic-test-001');
 assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM payments').get().n,1);
 assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM notifications').get().n,0);
 assert.deepEqual(buildDispatchTasks([f.row()]).tasks,[]);
 assert.throws(()=>f.DB.sqlite.prepare("UPDATE orders SET status='to_pickup' WHERE id=?").run(f.order.id),/dispatch hold/);
});
