import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import worker from '../src/index.js';
import {handleDriverApi} from '../src/driver-api.js';
import {REHEARSAL_ORIGIN} from '../src/payment-rehearsal-capability.js';
const NOW=1791788400000;
const installation='22222222-2222-4222-8222-222222222222';
const headers={'x-request-id':'11111111-1111-4111-8111-111111111111','x-device-installation-id':installation,'x-client-version':'1.1.0+1','content-type':'application/json',authorization:'Bearer synthetic-access'};
async function fixture(t) {
 t.mock.method(Date,'now',()=>NOW); t.mock.method(globalThis,'fetch',async()=>assert.fail('No provider calls'));
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
 const DB={prepare(q){const stmt=sqlite.prepare(q);let args=[];return {bind(...v){args=v;return this},async first(){return stmt.get(...args)||null},async run(){return {meta:{changes:Number(stmt.run(...args).changes)}}},async all(){return {results:stmt.all(...args)}}}},async batch(stmts){return Promise.all(stmts.map(s=>s.run()))}};
 const r={version:1,run_id:'synthetic-rehearsal-001',starts_at:NOW-1000,expires_at:NOW+1799000,shop:'edenmish.myshopify.com',variant_id:'gid://shopify/ProductVariant/999',phone:'+972541234567',email:'buyer@example.com',ops_email:'ops@example.com'};
 const env={DB,WHATSAPP_BOOKING_FULL_CONFIG:'{}',BOOKING_URL:REHEARSAL_ORIGIN,SHOPIFY_SHOP:r.shop,SESSION_SECRET:'synthetic-session',AUTO_DRIVER_DISPATCH:'off',SHOPIFY_WEBHOOK_REGISTRATION:'off',PAYMENT_REHEARSAL_CONFIG:JSON.stringify(r),PAYMENT_REHEARSAL_APP_ENABLED:'on',DRIVER_REVIEW_CODE:'12345678'};
 const driver='drv_rehearsal_'+createHash('sha256').update(r.run_id).digest('hex').slice(0,20);
 sqlite.prepare('INSERT INTO drivers(id,display_name,locale,active,created_at) VALUES(?,?,?,1,?)').run(driver,'Rehearsal','he-IL',NOW);
 sqlite.prepare('INSERT INTO driver_sessions(id,driver_id,installation_id,login_code_hash,access_token_hash,refresh_token_hash,access_expires_at,refresh_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('session-synthetic',driver,installation,'synthetic-login',createHash('sha256').update('synthetic-access').digest('hex'),'synthetic-refresh',NOW+600000,NOW+600000,NOW);
 const request=(path='/api/driver/v1/rehearsal/order',options={})=>new Request(REHEARSAL_ORIGIN+path,{...options,headers:{...headers,...options.headers}});
 const insert=()=>{
 const result=sqlite.prepare("INSERT INTO orders(token,name,phone,email,service,pickup,dropoff,price,currency,payment_status,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('a'.repeat(32),'Private name','+972541234567','buyer@example.com','standard','Private pickup','Private dropoff',1,'ILS','paid','paid',NOW);
 sqlite.prepare('UPDATE orders SET rehearsal_run_id=?,rehearsal_created_at=? WHERE id=?').run(r.run_id,NOW,result.lastInsertRowid);return result;
 };
 return {sqlite,env,r,request,insert};
}
test('actual Worker exposes only current run canonical paid state without PII',async t=>{
 const f=await fixture(t);f.insert();
 const res=await worker.fetch(f.request(),f.env,{});assert.equal(res.status,200);
 const body=await res.json();assert.equal(body.order.payment_status,'paid');assert.equal(body.order.dispatch_hold,true);assert.equal(body.order.amount_minor,100);
 assert.deepEqual(Object.keys(body.order).sort(),['amount_minor','archived','currency','dispatch_hold','order_id','payment_status','shopify_draft_order_id','shopify_order_id'].sort());assert.equal(JSON.stringify(body).includes('Private'),false);
 assert.equal(res.headers.get('cache-control'),'no-store');
});
test('archive is read from canonical record and preserves paid state',async t=>{
 const f=await fixture(t);f.insert();f.sqlite.prepare('UPDATE orders SET rehearsal_closed_at=?,shopify_order_id=?').run(NOW,'123');
 const body=await (await handleDriverApi(f.request(),f.env)).json();assert.equal(body.order.archived,true);assert.equal(body.order.payment_status,'paid');assert.equal(body.order.shopify_order_id,'123');
});
test('empty run is waiting rather than fabricated paid order',async t=>{
 const f=await fixture(t);const body=await (await handleDriverApi(f.request(),f.env)).json();assert.equal(body.order,null);
});
test('missing/wrong installation, production driver and old-run sessions cannot read',async t=>{
 const f=await fixture(t);
 for(const change of [{authorization:''},{'x-device-installation-id':'33333333-3333-4333-8333-333333333333'}])assert.equal((await handleDriverApi(f.request(undefined,{headers:change}),f.env)).status,401);
 const oldConfig=f.env.PAYMENT_REHEARSAL_CONFIG;f.env.PAYMENT_REHEARSAL_CONFIG=JSON.stringify({...f.r,run_id:'synthetic-other-run'});assert.equal((await handleDriverApi(f.request(),f.env)).status,401);f.env.PAYMENT_REHEARSAL_CONFIG=oldConfig;
 f.sqlite.prepare('INSERT INTO drivers(id,display_name,locale,active,created_at) VALUES(?,?,?,1,?)').run('drv_eden','Eden','he-IL',NOW);
 f.sqlite.prepare("UPDATE driver_sessions SET driver_id=?").run('drv_eden');
 // Invalid FK driver IDs are not an authenticated join; same rejection as any other run.
 assert.equal((await handleDriverApi(f.request(),f.env)).status,401);
});
test('all execution, GPS, proof, shift and push paths remain disabled',async t=>{
 const f=await fixture(t);
 for(const [path,method] of [['/api/driver/v1/shifts/current','GET'],['/api/driver/v1/location:batch','POST'],['/api/driver/v1/execution-events:batch','POST'],['/api/driver/v1/push-devices','POST'],['/api/driver/v1/rehearsal/order','POST']])
 assert.equal((await worker.fetch(f.request(path,{method}),f.env,{})).status,403,path);
});
test('read access requires explicit app flag, exact private origin and bounded expiry',async t=>{
 const f=await fixture(t);for(const flag of ['off',undefined])assert.equal((await handleDriverApi(f.request(),{...f.env,PAYMENT_REHEARSAL_APP_ENABLED:flag})).status,403);
 const prod=new Request('https://ops.edenmish.com/api/driver/v1/rehearsal/order',{headers});assert.equal((await handleDriverApi(prod,f.env)).status,403);
 t.mock.method(Date,'now',()=>f.r.expires_at+86400000);assert.equal((await handleDriverApi(f.request(),f.env)).status,403);
});
test('login accepts dedicated review code only and cannot use legacy credentials',async t=>{
 const f=await fixture(t);f.env.DRIVER_ADDITIONAL_ONE_TIME_CODES='87654321';
 const login=code=>handleDriverApi(f.request('/api/driver/v1/session',{method:'POST',body:JSON.stringify({one_time_code:code})}),f.env);
 assert.equal((await login('87654321')).status,401);
 const res=await login('12345678');assert.equal(res.status,201);const data=await res.json();assert.match(data.driver.driver_id,/^drv_rehearsal_/);
 assert.equal((await handleDriverApi(f.request(undefined,{headers:{authorization:'Bearer '+data.access_token}}),f.env)).status,200);
});

test('rehearsal access and refresh cannot become production authority after config removal',async t=>{
 const f=await fixture(t);
 const res=await handleDriverApi(f.request('/api/driver/v1/session',{method:'POST',body:JSON.stringify({one_time_code:'12345678'})}),f.env);
 const session=await res.json();assert.equal(res.status,201);
 delete f.env.PAYMENT_REHEARSAL_CONFIG;
 assert.equal((await handleDriverApi(f.request('/api/driver/v1/shifts/current',{headers:{authorization:'Bearer '+session.access_token}}),f.env)).status,401);
 assert.equal((await handleDriverApi(f.request('/api/driver/v1/execution-events:batch',{method:'POST',headers:{authorization:'Bearer '+session.access_token},body:'{}'}),f.env)).status,401);
 const refresh=await handleDriverApi(f.request('/api/driver/v1/session/refresh',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})}),f.env);
 assert.equal(refresh.status,401);
});
