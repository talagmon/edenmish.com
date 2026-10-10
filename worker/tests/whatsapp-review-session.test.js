import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {prepareReviewSession} from './fixtures/review-session-env.js';
import {issueContinuationGrant,continuationCanProceed,reserveContinuation,finishContinuation,stopContinuation,REVIEW_SESSION,REVIEW_PREFLIGHT} from '../src/whatsapp-continuation.js';
const NOW=Date.parse('2026-10-12T07:00:00Z');
function db(t){const s=new DatabaseSync(':memory:');t.after(()=>s.close());s.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));return {sqlite:s,prepare(sql){const stmt=s.prepare(sql);let args=[];return {bind(...a){args=a;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:stmt.run(...args).changes}};}};},async batch(stmts){s.exec('BEGIN');try{const rows=[];for(const stmt of stmts)rows.push(await stmt.run());s.exec('COMMIT');return rows;}catch(e){s.exec('ROLLBACK');throw e;}}};}
const on=e=>Object.assign(e,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
const usage={input_tokens:16384,output_tokens:1024,total_tokens:17408,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:1024}};
test('v6 reserves all retained holds; one grant, exact budgets, replay and deterministic replies after model quota',async t=>{
 const DB=db(t),e=await prepareReviewSession(DB,NOW);assert.equal(await issueContinuationGrant(e,NOW),true);assert.equal(await issueContinuationGrant(e,NOW),false);on(e);
 for(const kind of ['model','address','inbound','outbound']){
  for(let i=0;i<REVIEW_SESSION[kind];i++){const key=kind+i;assert.ok(await reserveContinuation(e,kind,key,NOW));assert.equal(await reserveContinuation(e,kind,key,NOW),null);if(kind!=='inbound')await finishContinuation(e,kind,key,{ok:true,usage:kind==='model'?usage:null},NOW);}
  assert.equal(await reserveContinuation(e,kind,kind+'excess',NOW),null);
 }
 const g=DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_review_grants').get();assert.equal(g.spent_micros,293120);assert.equal(g.model_micros,56320);assert.equal(g.historical_micros+g.fee_cushion_micros+g.spent_micros,1985684);assert.equal(g.stopped_reason,null);
 assert.equal(await continuationCanProceed(e,NOW),true,'exhausted model slot does not stop deterministic replies');assert.equal(await continuationCanProceed(e,NOW+900000),false);assert.equal(await continuationCanProceed(e,NOW-1),false);
});
for(const proof of ['pending','failed'])test('v6 refuses '+proof+' preflight without reset',async t=>{const DB=db(t),e=await prepareReviewSession(DB,NOW,{proof});assert.equal(await issueContinuationGrant(e,NOW),false);assert.throws(()=>DB.sqlite.prepare('DELETE FROM whatsapp_review_preflight').run());});
test('v6 requires exact scope, source, window and successful proof before grant',async t=>{
 const DB=db(t),e=await prepareReviewSession(DB,NOW);
 for(const patch of [{WHATSAPP_BOOKING_ENABLED:'on'},{WHATSAPP_BOOKING_VOICE_ENABLED:'on'},{WHATSAPP_BOOKING_VOICE_PROFILE:'other'},{WHATSAPP_BOOKING_MODE:'full'},{WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'off'},{WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256:'b'.repeat(64)},{WHATSAPP_BOOKING_REVIEW_AUTHORIZATION:'old-approval'},{WHATSAPP_BOOKING_CONTINUATION_END:new Date(NOW+900001).toISOString()}])assert.equal(await issueContinuationGrant({...e,...patch},NOW),false,JSON.stringify(patch));
 assert.equal(await issueContinuationGrant(e,NOW),true);on(e);assert.equal(await continuationCanProceed({...e,WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256:'b'.repeat(64)},NOW),false);
 await stopContinuation(e,'operator_stop');assert.equal(await continuationCanProceed(e,NOW),false);assert.equal(await reserveContinuation(e,'outbound','after-stop',NOW),null);
 assert.throws(()=>DB.sqlite.prepare('UPDATE whatsapp_continuation_review_grants SET stopped_reason=NULL').run());
});
test('v6 SQL retains proof, history, quotas, expiry and reserved operation identities',async t=>{
 const DB=db(t),e=await prepareReviewSession(DB,NOW);await issueContinuationGrant(e,NOW);on(e);await reserveContinuation(e,'outbound','one',NOW);
 for(const sql of ['DELETE FROM whatsapp_continuation_review_grants','UPDATE whatsapp_continuation_review_grants SET expires_at=expires_at+1','UPDATE whatsapp_continuation_review_grants SET outbound=0','UPDATE whatsapp_continuation_review_grants SET outbound=9','UPDATE whatsapp_continuation_review_grants SET model=2','UPDATE whatsapp_continuation_review_grants SET address=3','UPDATE whatsapp_continuation_review_grants SET spent_micros=293121','DELETE FROM whatsapp_continuation_review_operations','UPDATE whatsapp_continuation_review_operations SET reserved_micros=1','UPDATE whatsapp_continuation_voice_grants SET spent_micros=0','DELETE FROM whatsapp_voice_grants','UPDATE whatsapp_review_preflight SET status=\'pending\''])assert.throws(()=>DB.sqlite.prepare(sql).run(),sql);
 await finishContinuation(e,'outbound','one',{ok:false},NOW);assert.equal(await continuationCanProceed(e,NOW),false);
});
test('expiry after reservation retains failed hold and never revives grant on late success',async t=>{
 const DB=db(t),e=await prepareReviewSession(DB,NOW);await issueContinuationGrant(e,NOW);on(e);const end=NOW+900000;
 assert.ok(await reserveContinuation(e,'model','late',end-1));await finishContinuation(e,'model','late',{ok:true,usage},end);
 assert.equal(await continuationCanProceed(e,end-1),false);assert.equal(DB.sqlite.prepare('SELECT model_micros FROM whatsapp_continuation_review_grants').get().model_micros,56320);
});
test('proof expiry must cover the complete issued window',async t=>{const DB=db(t),e=await prepareReviewSession(DB,NOW,{proofLifetimeMs:120000});await assert.rejects(()=>issueContinuationGrant(e,NOW),/predecessor/);assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_review_grants').get().n,0);});
test('expired proof cannot issue and allowlist drift cannot proceed',async t=>{const DB=db(t),e=await prepareReviewSession(DB,NOW,{proofLifetimeMs:60000});assert.equal(await issueContinuationGrant(e,NOW),false);});
test('source, recipient and fixed window drift revoke active v6',async t=>{const DB=db(t),e=await prepareReviewSession(DB,NOW);assert.equal(await issueContinuationGrant(e,NOW),true);on(e);for(const patch of [{TWILIO_RECIPIENT_ALLOWLIST:'+972500000002'},{WHATSAPP_BOOKING_CONTINUATION_START:new Date(NOW-1).toISOString()},{WHATSAPP_BOOKING_CONTINUATION_END:new Date(NOW+899999).toISOString()}])assert.equal(await continuationCanProceed({...e,...patch},NOW),false);});
test('migration047 upgrades prior schema idempotently without issuing or resetting proof',t=>{const s=new DatabaseSync(':memory:');t.after(()=>s.close());const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8'),migration=readFileSync(new URL('../migrations/047_whatsapp_review_session.sql',import.meta.url),'utf8');s.exec(schema.slice(0,schema.indexOf('-- Fresh immutable text-only v6.')));s.exec(migration);assert.equal(s.prepare('SELECT COUNT(*) n FROM whatsapp_continuation_review_grants').get().n,0);s.prepare('INSERT INTO whatsapp_review_preflight(id,request_sha256,source_sha256,reserved_micros,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(REVIEW_PREFLIGHT.id,REVIEW_PREFLIGHT.requestHash,'a'.repeat(64),56320,NOW,NOW+3600000);s.exec(migration);assert.equal(s.prepare('SELECT COUNT(*) n FROM whatsapp_review_preflight').get().n,1);assert.throws(()=>s.prepare('DELETE FROM whatsapp_review_preflight').run());});
