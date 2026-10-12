import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {prepareReviewR2Session} from './fixtures/review-r2-session-env.js';
import {prepareReviewR3Session} from './fixtures/review-r3-session-env.js';
import {issueContinuationGrant,continuationCanProceed,reserveContinuation,finishContinuation,stopContinuation,REVIEW_R3_SESSION,REVIEW_R3_PREFLIGHT} from '../src/whatsapp-continuation.js';
const NOW=Date.parse('2026-10-12T07:00:00Z');
function db(t,{before049=false}={}){const s=new DatabaseSync(':memory:');t.after(()=>s.close());let schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');if(before049){const migration=readFileSync(new URL('../migrations/049_whatsapp_review_r3_session.sql',import.meta.url),'utf8');assert.ok(schema.includes(migration));schema=schema.slice(0,schema.indexOf(migration));}s.exec(schema);return {sqlite:s,prepare(sql){const stmt=s.prepare(sql);let args=[];return {bind(...a){args=a;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return /^SELECT/.test(sql)?{success:true,results:stmt.all(...args)}:{meta:{changes:stmt.run(...args).changes}};}};},async batch(stmts){s.exec('BEGIN');try{const rows=[];for(const stmt of stmts)rows.push(await stmt.run());s.exec('COMMIT');return rows;}catch(e){s.exec('ROLLBACK');throw e;}}};}
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
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);const end=NOW+900000;
 assert.ok(await reserveContinuation(e,'model','late',end-1000));await finishContinuation(e,'model','late',{ok:true,usage},end);
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

// Prototype regressions: every guard takes a fresh historical transaction and
// reads mutable stop/budget state last. Issuance still uses the original walk.
function traceReads(DB,{afterHistory=()=>{},afterGrant=()=>{},beforeWrite=()=>{},corrupt=null}={}){
 const counts={singleReads:0,readBatches:0,readStatements:0,writeBatches:0};
 return {counts,prepare(sql){const stmt=DB.prepare(sql);if(/^SELECT/.test(sql)){
  const first=stmt.first,all=stmt.all;
  stmt.first=async()=>{counts.singleReads++;counts.readStatements++;const row=await first();if(sql==='SELECT * FROM whatsapp_continuation_review_r3_grants WHERE id=?')await afterGrant();return row;};
  stmt.all=async()=>{counts.singleReads++;counts.readStatements++;return all();};
 }return stmt;},async batch(stmts){if(stmts.length===20){counts.readBatches++;counts.readStatements+=20;const rows=await DB.batch(stmts);if(corrupt)corrupt(rows);await afterHistory();return rows;}counts.writeBatches++;await beforeWrite();return DB.batch(stmts);}};
}
test('v8 history hash matches original issuance; 21 statements now use one read batch and one fresh grant read',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);
 const expected=DB.sqlite.prepare('SELECT history_hash FROM whatsapp_continuation_review_r3_grants').get().history_hash;
 const traced=traceReads(DB);e.DB=traced;assert.equal(await continuationCanProceed(e,NOW),true);
 assert.deepEqual(traced.counts,{singleReads:1,readBatches:1,readStatements:21,writeBatches:0});
 assert.ok(await reserveContinuation(e,'model','counts',NOW));await finishContinuation(e,'model','counts',{ok:true,usage},NOW);
 assert.deepEqual(traced.counts,{singleReads:3,readBatches:3,readStatements:63,writeBatches:2});
 assert.equal(DB.sqlite.prepare('SELECT history_hash FROM whatsapp_continuation_review_r3_grants').get().history_hash,expected);
});
for(let i=0;i<20;i++)test('v8 failed history result '+i+' rejects without grant read or fallback',async t=>{
 const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);
 const traced=traceReads(DB,{corrupt:rows=>{rows[i]={success:false,results:[]};}});e.DB=traced;
 assert.equal(await continuationCanProceed(e,NOW),false);assert.equal(traced.counts.singleReads,0);assert.equal(traced.counts.readBatches,1);
});
for(const phase of ['history','grant'])for(const change of ['stop','expiry'])test('fresh '+change+' after awaited '+phase+' prevents reservation',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);
 const mutate=async()=>{if(change==='stop')await stopContinuation({...e,DB},'operator_stop');else t.mock.timers.setTime(NOW+900000);};
 const traced=traceReads(DB,{[phase==='history'?'afterHistory':'afterGrant']:mutate});e.DB=traced;
 assert.equal(await reserveContinuation(e,'model','race',NOW),null);assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_review_r3_operations').get().n,0);
});
test('operator stop after guard before atomic reservation rejects without spending',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);
 e.DB=traceReads(DB,{beforeWrite:()=>stopContinuation({...e,DB},'operator_stop')});
 assert.equal(await reserveContinuation(e,'model','cas-stop',NOW),null);assert.equal(DB.sqlite.prepare('SELECT spent_micros FROM whatsapp_continuation_review_r3_grants').get().spent_micros,0);
});
test('fresh CAS timestamp includes elapsed read time; subsequent guard closes delayed returned reservation',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);
 e.DB=traceReads(DB,{afterHistory:()=>t.mock.timers.setTime(NOW+500)});
 assert.ok(await reserveContinuation(e,'model','fresh-time',NOW));
 assert.equal(DB.sqlite.prepare('SELECT created_at FROM whatsapp_continuation_review_r3_operations').get().created_at,NOW+500);
 t.mock.timers.setTime(NOW+900000);assert.equal(await continuationCanProceed(e,Date.now()),false);
 assert.equal(DB.sqlite.prepare('SELECT model_micros FROM whatsapp_continuation_review_r3_grants').get().model_micros,56320);
});

import {createOpenAIBookingModel} from '../src/whatsapp-booking-openai.js';
import {proposeBookingTurn} from '../src/whatsapp-booking-model.js';
for(const outcome of ['success','invalid-evidence','stop-after-provider','stop-before-provider'])test('v8 model stages, verified usage and guard order '+outcome,async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);
 let calls=0,diagnostic=null;const traced=traceReads(DB);e.DB=traced;
 if(outcome==='stop-before-provider'){
  const batch=traced.batch;traced.batch=async stmts=>{const r=await batch(stmts);if(stmts.length===2)await stopContinuation({...e,DB},'operator_stop');return r;};
 }
 const model=createOpenAIBookingModel(e,{eventId:'a'.repeat(64),clock:Date.now,onDiagnostic:d=>diagnostic=d,fetchImpl:async()=>{
  calls++;if(outcome==='stop-after-provider')await stopContinuation({...e,DB},'operator_stop');
  return Response.json({model:'gpt-6.1-sol',service_tier:'default',status:'completed',usage,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({version:2,intent:'update',fields:[{field:'size',quote:outcome==='invalid-evidence'?'invented':'קטנה'}],topic:null,clarify_field:null})}]}]});
 }});
 const proposal=await proposeBookingTurn(model,{phase:'collect',consent_at:NOW,data:{}},'יש לי חבילה קטנה',NOW);
 assert.equal(!!proposal,outcome==='success');assert.equal(calls,outcome==='stop-before-provider'?0:1);
 assert.equal(diagnostic.verifiedUsage?.input??null,calls?16384:null);
 assert.equal(diagnostic.stageTimings.model_reservation.calls,1);assert.equal(diagnostic.stageTimings.presend_guard.calls,1);
 const op=DB.sqlite.prepare("SELECT * FROM whatsapp_continuation_review_r3_operations WHERE kind='model'").get();assert.equal(op.reserved_micros,56320);assert.equal(op.status,outcome==='success'?'settled':'uncertain');
 if(outcome==='success')assert.deepEqual(traced.counts,{singleReads:5,readBatches:5,readStatements:105,writeBatches:2});
 assert.ok(!JSON.stringify(diagnostic).includes('invented'));assert.ok(!JSON.stringify(diagnostic).includes('sk-'));
});

test('backwards wall clock cannot undo elapsed time observed by guard before CAS',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});const DB=db(t),e=await prepareReviewR3Session(DB,NOW);await issueContinuationGrant(e,NOW);on(e);
 e.DB=traceReads(DB,{afterHistory:()=>t.mock.timers.setTime(NOW+500),afterGrant:()=>t.mock.timers.setTime(NOW-500)});
 assert.ok(await reserveContinuation(e,'model','backwards',NOW));assert.equal(DB.sqlite.prepare('SELECT created_at FROM whatsapp_continuation_review_r3_operations').get().created_at,NOW+500);
});
