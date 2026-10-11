import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {prepareReviewR2Session} from './fixtures/review-r2-session-env.js';
import {prepareReviewR3Session} from './fixtures/review-r3-session-env.js';
import {issueContinuationGrant,continuationCanProceed,reserveContinuation,finishContinuation,stopContinuation,REVIEW_R3_SESSION,REVIEW_R3_PREFLIGHT} from '../src/whatsapp-continuation.js';
const NOW=Date.parse('2026-10-12T07:00:00Z');
function db(t,{before049=false}={}){const s=new DatabaseSync(':memory:');t.after(()=>s.close());let schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');if(before049){const migration=readFileSync(new URL('../migrations/049_whatsapp_review_r3_session.sql',import.meta.url),'utf8');assert.ok(schema.includes(migration));schema=schema.slice(0,schema.indexOf(migration));}s.exec(schema);return {sqlite:s,prepare(sql){const stmt=s.prepare(sql);let args=[];return {bind(...a){args=a;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:stmt.run(...args).changes}};}};},async batch(stmts){s.exec('BEGIN');try{const rows=[];for(const stmt of stmts)rows.push(await stmt.run());s.exec('COMMIT');return rows;}catch(e){s.exec('ROLLBACK');throw e;}}};}
const on=e=>Object.assign(e,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
const usage={input_tokens:16384,output_tokens:1024,total_tokens:17408,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:1024}};
test('v8 reserves all retained holds; one grant, exact budgets, replay and deterministic replies after model quota',async t=>{
 const DB=db(t),e=await prepareReviewR3Session(DB,NOW);assert.equal(await issueContinuationGrant(e,NOW),true);assert.equal(await issueContinuationGrant(e,NOW),false);on(e);
 for(const kind of ['model','address','inbound','outbound']){
  for(let i=0;i<REVIEW_R3_SESSION[kind];i++){const key=kind+i;assert.ok(await reserveContinuation(e,kind,key,NOW));assert.equal(await reserveContinuation(e,kind,key,NOW),null);if(kind!=='inbound')await finishContinuation(e,kind,key,{ok:true,usage:kind==='model'?usage:null},NOW);}
  assert.equal(await reserveContinuation(e,kind,kind+'excess',NOW),null);
 }
 const g=DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_review_r3_grants').get();assert.equal(g.spent_micros,164320);assert.equal(g.model_micros,56320);assert.equal(g.historical_micros+g.fee_cushion_micros+g.spent_micros,1969524);assert.equal(g.stopped_reason,null);
 assert.equal(await continuationCanProceed(e,NOW),true,'exhausted model slot does not stop deterministic replies');assert.equal(await continuationCanProceed(e,NOW+900000),false);assert.equal(await continuationCanProceed(e,NOW-1),false);
});
for(const proof of ['pending','failed'])test('v8 refuses '+proof+' preflight without reset',async t=>{const DB=db(t),e=await prepareReviewR3Session(DB,NOW,{proof});assert.equal(await issueContinuationGrant(e,NOW),false);assert.throws(()=>DB.sqlite.prepare('DELETE FROM whatsapp_review_r3_preflight').run());});
test('v8 requires exact scope, source, window and successful proof before grant',async t=>{
 const DB=db(t),e=await prepareReviewR3Session(DB,NOW);
 for(const patch of [{WHATSAPP_BOOKING_ENABLED:'on'},{WHATSAPP_BOOKING_VOICE_ENABLED:'on'},{WHATSAPP_BOOKING_VOICE_PROFILE:'other'},{WHATSAPP_BOOKING_MODE:'full'},{WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'off'},{WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256:'b'.repeat(64)},{WHATSAPP_BOOKING_REVIEW_AUTHORIZATION:'old-approval'},{WHATSAPP_BOOKING_CONTINUATION_END:new Date(NOW+900001).toISOString()}])assert.equal(await issueContinuationGrant({...e,...patch},NOW),false,JSON.stringify(patch));
 assert.equal(await issueContinuationGrant(e,NOW),true);on(e);assert.equal(await continuationCanProceed({...e,WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256:'b'.repeat(64)},NOW),false);
 await stopContinuation(e,'operator_stop');assert.equal(await continuationCanProceed(e,NOW),false);assert.equal(await reserveContinuation(e,'outbound','after-stop',NOW),null);
 assert.throws(()=>DB.sqlite.prepare('UPDATE whatsapp_continuation_review_r3_grants SET stopped_reason=NULL').run());
});
test('v8 SQL retains proof, history, quotas, expiry and reserved operation identities',async t=>{
 const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);await reserveContinuation(e,'outbound','one',NOW);
 for(const sql of ['DELETE FROM whatsapp_continuation_review_r3_grants','UPDATE whatsapp_continuation_review_r3_grants SET expires_at=expires_at+1','UPDATE whatsapp_continuation_review_r3_grants SET outbound=0','UPDATE whatsapp_continuation_review_r3_grants SET outbound=7','UPDATE whatsapp_continuation_review_r3_grants SET model=2','UPDATE whatsapp_continuation_review_r3_grants SET address=1','UPDATE whatsapp_continuation_review_r3_grants SET spent_micros=164321','DELETE FROM whatsapp_continuation_review_r3_operations','UPDATE whatsapp_continuation_review_r3_operations SET reserved_micros=1','UPDATE whatsapp_continuation_voice_grants SET spent_micros=0','DELETE FROM whatsapp_voice_grants','UPDATE whatsapp_review_r3_preflight SET status=\'pending\''])assert.throws(()=>DB.sqlite.prepare(sql).run(),sql);
 await finishContinuation(e,'outbound','one',{ok:false},NOW);assert.equal(await continuationCanProceed(e,NOW),false);
});
test('expiry after reservation retains failed hold and never revives grant on late success',async t=>{
 const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);const end=NOW+900000;
 assert.ok(await reserveContinuation(e,'model','late',end-1));await finishContinuation(e,'model','late',{ok:true,usage},end);
 assert.equal(await continuationCanProceed(e,end-1),false);assert.equal(DB.sqlite.prepare('SELECT model_micros FROM whatsapp_continuation_review_r3_grants').get().model_micros,56320);
});
test('proof expiry must cover the complete issued window',async t=>{const DB=db(t),e=await prepareReviewR3Session(DB,NOW,{proofLifetimeMs:120000});assert.equal(await issueContinuationGrant(e,NOW),false);assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_review_r3_grants').get().n,0);});
test('expired proof cannot issue and allowlist drift cannot proceed',async t=>{const DB=db(t),e=await prepareReviewR3Session(DB,NOW,{proofLifetimeMs:60000});assert.equal(await issueContinuationGrant(e,NOW),false);});
test('source, recipient and fixed window drift revoke active v8',async t=>{const DB=db(t),e=await prepareReviewR3Session(DB,NOW);assert.equal(await issueContinuationGrant(e,NOW),true);on(e);for(const patch of [{TWILIO_RECIPIENT_ALLOWLIST:'+972500000002'},{WHATSAPP_BOOKING_CONTINUATION_START:new Date(NOW-1).toISOString()},{WHATSAPP_BOOKING_CONTINUATION_END:new Date(NOW+899999).toISOString()}])assert.equal(await continuationCanProceed({...e,...patch},NOW),false);});

const oldSource='531f995ae64dd7f64f61fcebf864cfa68f2cf9b31f3e08a92c3a28a3a821682d';
function reserveProof(DB){return DB.sqlite.prepare('INSERT INTO whatsapp_review_r3_preflight(id,request_sha256,source_sha256,reserved_micros,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(REVIEW_R3_PREFLIGHT.id,REVIEW_R3_PREFLIGHT.requestHash,'a'.repeat(64),56320,NOW,NOW+3600000);}
for(const prior of ['missing','pending','matched','wrong_source'])test(`r3 cannot spend against ${prior} predecessor`,async t=>{
 const DB=db(t);
 if(prior!=='missing')await prepareReviewR2Session(DB,NOW-120000,{proof:prior==='wrong_source'?'failed':prior,sourceSha256:prior==='wrong_source'?'b'.repeat(64):oldSource});
 assert.throws(()=>reserveProof(DB),/failed r1/);assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_review_r3_preflight').get().n,0);
});
test('r3 reservation freezes r2/v7 and previous history before any new handset grant',async t=>{
 const DB=db(t);await prepareReviewR2Session(DB,NOW-120000,{proof:'failed',sourceSha256:oldSource});
 const old=JSON.stringify(DB.sqlite.prepare('SELECT * FROM whatsapp_review_r2_preflight').all());reserveProof(DB);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_review_r3_grants').get().n,0);
 for(const sql of [
  "UPDATE whatsapp_review_r2_preflight SET status='pending'","DELETE FROM whatsapp_review_r2_preflight",
  "INSERT INTO whatsapp_continuation_review_r2_grants DEFAULT VALUES",
  "INSERT INTO whatsapp_continuation_review_r2_operations(id,grant_id,kind,status,reserved_micros,created_at) VALUES('x','x','inbound','settled',10300,1)",
  'UPDATE whatsapp_continuation_voice_grants SET spent_micros=spent_micros',
  'DELETE FROM whatsapp_voice_grants',
 ])assert.throws(()=>DB.sqlite.exec(sql),/history retained|r2 and unused v7 allocation retained/,sql);
 assert.throws(()=>reserveProof(DB));assert.throws(()=>DB.sqlite.exec('DELETE FROM whatsapp_review_r3_preflight'));
 DB.sqlite.prepare("UPDATE whatsapp_review_r3_preflight SET status='failed',finished_at=? WHERE id=?").run(NOW+10,REVIEW_R3_PREFLIGHT.id);
 for(const sql of ["INSERT INTO whatsapp_continuation_review_r2_grants DEFAULT VALUES","INSERT INTO whatsapp_continuation_review_r2_operations(id,grant_id,kind,status,reserved_micros,created_at) VALUES('x','x','inbound','settled',10300,1)"])assert.throws(()=>DB.sqlite.exec(sql),/r2 and unused v7 allocation retained/);
 assert.throws(()=>reserveProof(DB));assert.equal(JSON.stringify(DB.sqlite.prepare('SELECT * FROM whatsapp_review_r2_preflight').all()),old);
});
test('any orphan v7 operation blocks reuse of its purported unused allocation',async t=>{
 const DB=db(t);await prepareReviewR2Session(DB,NOW-120000,{proof:'failed',sourceSha256:oldSource});
 DB.sqlite.exec("PRAGMA foreign_keys=OFF"); // Synthetic corrupt import: restore enforcement before testing reservation.
 DB.sqlite.exec("INSERT INTO whatsapp_continuation_review_r2_operations(id,grant_id,kind,status,reserved_micros,created_at) VALUES('orphan','missing','inbound','settled',10300,1)");
 DB.sqlite.exec("PRAGMA foreign_keys=ON");
 assert.throws(()=>reserveProof(DB),/unused v6\/v7/);
});
test('migration049 is additive and replay preserves failed r2 and pending r3',async t=>{
 const DB=db(t,{before049:true});await prepareReviewR2Session(DB,NOW-120000,{proof:'failed',sourceSha256:oldSource});
 const old=JSON.stringify(DB.sqlite.prepare('SELECT * FROM whatsapp_review_r2_preflight').all());
 const sql=readFileSync(new URL('../migrations/049_whatsapp_review_r3_session.sql',import.meta.url),'utf8');DB.sqlite.exec(sql);reserveProof(DB);DB.sqlite.exec(sql);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_review_r3_preflight').get().n,1);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_review_r3_grants').get().n,0);
 assert.equal(JSON.stringify(DB.sqlite.prepare('SELECT * FROM whatsapp_review_r2_preflight').all()),old);
});
