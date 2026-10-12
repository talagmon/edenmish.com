import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { FULL_BOOKING_PROFILE, FULL_BOOKING_COSTS, fullBookingSelected, fullBookingSpec, fullBookingReady, fullBookingCanProceed, issueFullBookingGrant, reserveFullBookingOperation, finishFullBookingOperation, stopFullBookingGrant } from '../src/whatsapp-full-booking.js';
const NOW=Date.parse('2026-10-11T07:00:00Z');
const databases=[];
afterEach(()=>{while(databases.length)databases.pop().close();});
function database(){
 const sqlite=new DatabaseSync(':memory:');let batchTail=Promise.resolve();databases.push(sqlite);sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);let args=[];return {bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};},async batch(statements){const previous=batchTail;let unlock;batchTail=new Promise(resolve=>unlock=resolve);await previous;sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}finally{unlock();}}};
}
function specification(overrides={}){return {version:1,environment:'staging',budget_id:'synthetic-budget',grant_id:'synthetic-grant',source_sha256:'a'.repeat(64),starts_at:NOW,expires_at:NOW+3600000,budget_micros:1000000,retained_micros:100000,allocation_micros:200000,limits:{inbound:3,outbound:3,address:2,model:2},account_sid:'AC'+'1'.repeat(32),sender:'whatsapp:+15551234567',recipients:['+972541234567'],booking_url:'https://staging.edenmish.com',webhook_url:'https://ops-staging.edenmish.com/webhooks/twilio/booking',...FULL_BOOKING_PROFILE,costs:{...FULL_BOOKING_COSTS},...overrides};}
function environment(spec=specification()) {return {DB:database(),WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify(spec),WHATSAPP_BOOKING_FULL_APPROVED:'on',WHATSAPP_BOOKING_FULL_SCHEMA_READY:'on',WHATSAPP_BOOKING_DURABLE_READY:'on',WHATSAPP_BOOKING_QUEUE:{send:async()=>{}},WHATSAPP_BOOKING_STORAGE_READY:'on',WHATSAPP_BOOKING_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODE:'full',WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_MODEL:spec.model,WHATSAPP_BOOKING_REASONING_EFFORT:'low',WHATSAPP_BOOKING_PROVIDER:'twilio',TWILIO_ACCOUNT_SID:spec.account_sid,TWILIO_BOOKING_FROM:spec.sender,BOOKING_URL:spec.booking_url,TWILIO_BOOKING_WEBHOOK_URL:spec.webhook_url,TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:spec.recipients.join(','),WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off'};}
const request=env=>{const spec=fullBookingSpec(env);return {version:1,grant_id:spec.grant_id,budget_id:spec.budget_id,source_sha256:spec.source_sha256,approve:true};};
function activate(env){return {...env,WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on',WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'on',WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'on',WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'on',WHATSAPP_BOOKING_FULL_OPENAI_API_KEY:'sk-offline_fixture_only',SESSION_SECRET:'offline-session',TWILIO_AUTH_TOKEN:'offline-twilio'};}
async function ready(spec){const env=environment(spec);assert.equal(await issueFullBookingGrant(env,request(env),NOW),true);return activate(env);}

test('strict profile is default off, selected malformed data fails closed, and no generic key fallback',async()=>{
 assert.equal(fullBookingSelected({}),false);assert.equal(fullBookingReady({},NOW),false);
 for(const raw of ['',null,'null','{}','bad']){assert.equal(fullBookingSelected({WHATSAPP_BOOKING_FULL_CONFIG:raw}),true);assert.equal(fullBookingSpec({WHATSAPP_BOOKING_FULL_CONFIG:raw}),null);}
 for(const change of [{model:'gpt-6-luna'},{reasoning_effort:'none'},{service_tier:'flex'},{max_output_tokens:1025},{request_bytes:9000},{input_tokens:20000},{timeout_ms:10000},{soft_timeout_ms:9999},{transport_timeout_ms:30000},{unknown:true},{costs:{...FULL_BOOKING_COSTS,model:1}},{recipients:['+972541234567','+972541234567']},{webhook_url:'https://evil.invalid/webhooks/twilio/booking'}])assert.equal(fullBookingSpec({WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify(specification(change))}),null);
 const env=await ready();assert.equal(fullBookingReady(env,NOW),true);
 for(const change of [{WHATSAPP_BOOKING_DURABLE_READY:'off'},{WHATSAPP_BOOKING_QUEUE:undefined},{WHATSAPP_BOOKING_FULL_OPENAI_API_KEY:'',OPENAI_API_KEY:'sk-generic_fixture_only'},{WHATSAPP_BOOKING_FULL_OPENAI_API_KEY:'invalid'},{WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED:'off'},{WHATSAPP_BOOKING_MODEL_EVAL_APPROVED:'off'},{WHATSAPP_BOOKING_MODEL_SPEND_APPROVED:'off'},{WHATSAPP_BOOKING_MODE:'conversation_only'},{WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'off'},{TWILIO_RECIPIENT_ALLOWLIST:'+972549999999'},{WHATSAPP_BOOKING_FULL_SCHEMA_READY:'off'},{WHATSAPP_BOOKING_FULL_APPROVED:'off'},{WHATSAPP_BOOKING_PILOT_ID:'old'},{WHATSAPP_BOOKING_CONTINUATION_ID:'old'},{WHATSAPP_BOOKING_VOICE_ENABLED:'on'},{WHATSAPP_BOOKING_READINESS_APPROVED:'on'}])assert.equal(fullBookingReady({...env,...change},NOW),false,JSON.stringify(Object.keys(change)));
});
test('explicit matching approval issues only while OFF, keyless, with no implicit activation and idempotent whole allocation',async()=>{
 const env=environment();assert.equal(await fullBookingCanProceed(activate(env),NOW),false);
 assert.equal(await issueFullBookingGrant(activate(env),request(env),NOW),false);
 for(const change of [{approve:false},{grant_id:'other'},{source_sha256:'b'.repeat(64)},{extra:true}])assert.equal(await issueFullBookingGrant(env,{...request(env),...change},NOW),false);
 assert.equal(await issueFullBookingGrant(env,request(env),NOW),true);assert.equal(await issueFullBookingGrant(env,request(env),NOW),true);
 assert.equal(fullBookingReady(env,NOW),false);assert.equal(await fullBookingCanProceed(activate(env),NOW),true);
 const root=env.DB.sqlite.prepare('SELECT * FROM whatsapp_full_booking_budgets').get();assert.equal(root.allocated_micros,200000);assert.equal(root.held_micros,0);assert.equal(root.retained_micros,100000);
 const changed=activate({...env,WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify(specification({source_sha256:'b'.repeat(64)}))});assert.equal(await fullBookingCanProceed(changed,NOW),false);
});
test('atomic duplicate/concurrent reservations enforce counts and exact total cap without preventing final already-held IO',async()=>{
 const env=await ready(specification({allocation_micros:20600,limits:{inbound:5,outbound:0,address:0,model:0}}));
 const outcomes=await Promise.all([reserveFullBookingOperation(env,'inbound','same',NOW),reserveFullBookingOperation(env,'inbound','same',NOW),reserveFullBookingOperation(env,'inbound','other',NOW),reserveFullBookingOperation(env,'inbound','third',NOW)]);
 assert.equal(outcomes.filter(Boolean).length,2);assert.equal(await fullBookingCanProceed(env,NOW),true);
 assert.equal(env.DB.sqlite.prepare('SELECT spent_micros FROM whatsapp_full_booking_grants').get().spent_micros,20600);
 assert.equal(env.DB.sqlite.prepare('SELECT held_micros FROM whatsapp_full_booking_budgets').get().held_micros,20600);
 assert.equal(await reserveFullBookingOperation(env,'inbound','fifth',NOW),false);assert.equal(await reserveFullBookingOperation(env,'address','first',NOW),false);
 const counts=await ready(specification({limits:{inbound:1,outbound:1,address:1,model:1}}));
 assert.equal(await reserveFullBookingOperation(counts,'model','a'.repeat(64)+':address:0',NOW),true);
 assert.equal(await reserveFullBookingOperation(counts,'model','new-key',NOW),false);
});
test('finishing retains holds, stores only fixed diagnostics, cannot retry or overwrite terminal evidence',async()=>{
 const env=await ready();const key='a'.repeat(64);assert.equal(await reserveFullBookingOperation(env,'model',key,NOW),true);
 assert.equal(await finishFullBookingOperation(env,'model',key,false,{outcome:'proposal_schema',proposalRejection:'quote_missing',httpStatus:200,elapsedMs:900,softLatencyWarning:true,modelLatencyMs:11000,turnLatencyMs:14000,verifiedUsage:{input:1000,cached:100,output:20,reasoning:0,raw:'PRIVATE'},stageTimings:{provider_headers:{calls:1,totalMs:20,maxMs:20,secret:'PRIVATE'},raw:{calls:1,totalMs:1,maxMs:1}},customer_message:'PRIVATE',apiKey:'PRIVATE'},NOW+1000),true);
 const row=env.DB.sqlite.prepare('SELECT * FROM whatsapp_full_booking_operations').get();assert.equal(row.status,'uncertain');assert.doesNotMatch(row.diagnostics_json,/PRIVATE|customer_message|apiKey|secret|raw/);
 const diagnostic=JSON.parse(row.diagnostics_json);assert.equal(diagnostic.proposalRejection,'quote_missing');assert.equal(diagnostic.stageTimings.provider_headers.totalMs,20);assert.equal(diagnostic.verifiedUsage.input,1000);assert.equal(diagnostic.softLatencyWarning,true);assert.equal(diagnostic.modelLatencyMs,11000);assert.equal(diagnostic.turnLatencyMs,14000);
 assert.equal(await reserveFullBookingOperation(env,'model',key,NOW+1001),false);assert.equal(await finishFullBookingOperation(env,'model',key,true,{},NOW+1001),false);
 assert.equal(env.DB.sqlite.prepare('SELECT spent_micros FROM whatsapp_full_booking_grants').get().spent_micros,56320);
 assert.equal(await reserveFullBookingOperation(env,'model','next',NOW+1002),true);
 assert.equal(await finishFullBookingOperation(env,'model','next',true,{outcome:'PRIVATE',proposalRejection:'PRIVATE',httpStatus:'PRIVATE',elapsedMs:-1,softLatencyWarning:'PRIVATE',modelLatencyMs:Infinity,turnLatencyMs:60001,verifiedUsage:{input:999999,cached:0,output:10,reasoning:0},stageTimings:{provider_headers:{calls:100,totalMs:1,maxMs:1}}},NOW+1003),true);
 assert.equal(env.DB.sqlite.prepare("SELECT diagnostics_json FROM whatsapp_full_booking_operations WHERE operation_key='next'").get().diagnostics_json,'{}');
});
test('expiry and sticky stop deny fresh operations but allow terminal recording without refunds',async()=>{
 const env=await ready();assert.equal(fullBookingReady(env,NOW-1),false);assert.equal(await fullBookingCanProceed(env,NOW+3600000),false);
 assert.equal(await reserveFullBookingOperation(env,'model','pending',NOW),true);assert.equal(await stopFullBookingGrant(env,'operator_stop',NOW+1),true);
 assert.equal(await fullBookingCanProceed(env,NOW+2),false);assert.equal(await reserveFullBookingOperation(env,'model','another',NOW+2),false);
 assert.equal(await finishFullBookingOperation(env,'model','pending',false,{outcome:'expired'},NOW+3600001),true);
 assert.equal(await issueFullBookingGrant({...env,WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off'},request(env),NOW+2),false);
 assert.equal(env.DB.sqlite.prepare('SELECT allocated_micros FROM whatsapp_full_booking_budgets').get().allocated_micros,200000);
});
test('new grant/budget IDs, higher cap, lowered retained allowance and expiry cannot reset environment root',async()=>{
 const spec=specification({budget_micros:300000,retained_micros:100000,allocation_micros:200000}),env=environment(spec);
 assert.equal(await issueFullBookingGrant(env,request(env),NOW),true);
 for(const change of [{grant_id:'new-grant'},{grant_id:'new-grant',budget_id:'new-budget'},{grant_id:'new-grant',budget_micros:900000},{grant_id:'new-grant',retained_micros:0},{grant_id:'new-grant',starts_at:NOW+3600000,expires_at:NOW+7200000}]){const other={...env,WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify({...spec,...change})};assert.equal(await issueFullBookingGrant(other,request(other),NOW),false);}
 const db=env.DB.sqlite;assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_full_booking_grants').get().n,1);
 assert.throws(()=>db.exec('UPDATE whatsapp_full_booking_budgets SET cap_micros=900000'),/immutable/);
 assert.throws(()=>db.exec('DELETE FROM whatsapp_full_booking_budgets'),/retained/);
 db.exec("INSERT OR REPLACE INTO whatsapp_full_booking_budgets (environment,budget_id,binding_hash,cap_micros,retained_micros,created_at) SELECT environment,budget_id,binding_hash,900000,0,created_at FROM whatsapp_full_booking_budgets");
 assert.equal(db.prepare('SELECT cap_micros FROM whatsapp_full_booking_budgets').get().cap_micros,300000);
 assert.equal(db.prepare('SELECT allocated_micros FROM whatsapp_full_booking_budgets').get().allocated_micros,200000);
 assert.throws(()=>db.exec('UPDATE whatsapp_full_booking_grants SET allocation_micros=1'),/immutable/);
});
test('budget allocations for different new IDs race atomically and do not oversubscribe',async()=>{
 const env=environment(specification({budget_micros:300000,retained_micros:100000,allocation_micros:150000}));
 const second={...env,WHATSAPP_BOOKING_FULL_CONFIG:JSON.stringify({...fullBookingSpec(env),grant_id:'second'})};
 const results=await Promise.all([issueFullBookingGrant(env,request(env),NOW),issueFullBookingGrant(second,request(second),NOW)]);
 assert.equal(results.filter(Boolean).length,1);assert.equal(env.DB.sqlite.prepare('SELECT allocated_micros FROM whatsapp_full_booking_budgets').get().allocated_micros,150000);
});
test('post-read clock check catches expiry while DB guard is awaited',async()=>{
 const env=await ready();let time=NOW;const prepare=env.DB.prepare.bind(env.DB);
 env.DB.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith('SELECT g.binding_hash, g.root_binding')){const first=stmt.first.bind(stmt);stmt.first=async()=>{const row=await first();time=NOW+3600000;return row;};}return stmt;};
 assert.equal(await fullBookingCanProceed(env,()=>time),false);assert.equal(await reserveFullBookingOperation(env,'inbound','late',()=>time),false);
 assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_full_booking_operations').get().n,0);
});
test('migration is idempotent on fresh schema and direct malformed operation cannot bypass trigger ceilings',async()=>{
 const env=await ready();env.DB.sqlite.exec(readFileSync(new URL('../migrations/050_whatsapp_full_booking.sql',import.meta.url),'utf8'));
 assert.throws(()=>env.DB.sqlite.prepare("INSERT INTO whatsapp_full_booking_operations (grant_id,kind,operation_key,reserved_micros,status,created_at) VALUES ('synthetic-grant','model','bad',1,'pending',?)").run(NOW),/refused/);
 assert.equal(env.DB.sqlite.prepare('SELECT spent_micros FROM whatsapp_full_booking_grants').get().spent_micros,0);
 assert.equal(await reserveFullBookingOperation(env,'inbound','held',NOW),true);
 assert.throws(()=>env.DB.sqlite.exec('DELETE FROM whatsapp_full_booking_operations'),/retained/);
 assert.throws(()=>env.DB.sqlite.exec('UPDATE whatsapp_full_booking_grants SET spent_micros=0'),/immutable/);
});
