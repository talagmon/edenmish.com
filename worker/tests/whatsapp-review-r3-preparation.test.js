import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {prepare} from '../scripts/whatsapp-review-r3-prepare.mjs';
import {configSafe,sourceFingerprint,verifyDeploymentSurface} from '../scripts/whatsapp-review-r3-cli.mjs';
import {REVIEW_R3_PROFILE_NAME as REVIEW_PROFILE_NAME,REVIEW_PROFILE_VALUES,reviewProfileEnvironment} from '../src/whatsapp-booking-review-profile.js';
import {CONTRACT} from '../scripts/whatsapp-review-r3-runner.mjs';
import {voiceProfileEnvironment} from '../src/whatsapp-booking-voice-profile.js';
import {lunaPilotCanRun} from '../src/whatsapp-pilot-budget.js';
import {bookingEnabled} from '../src/whatsapp-booking.js';
import {continuationIssuable,continuationReady,issueContinuationGrant,continuationCanProceed,stopContinuation} from '../src/whatsapp-continuation.js';
import {prepareReviewR3Session} from './fixtures/review-r3-session-env.js';
const NOW=Date.parse('2026-10-12T07:00:00Z');
const base=()=>JSON.parse(readFileSync(process.env.WHATSAPP_REVIEW_OFF_CONFIG||new URL('./fixtures/review-off-config.json',import.meta.url)));
const plan={recipient:'+972500000001',startsAt:NOW,endsAt:NOW+900000};
function directory(t){const p=mkdtempSync(join(tmpdir(),'review-preparation-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
function artifacts(t){const directoryPath=directory(t);const result=prepare({base:base(),plan,directory:directoryPath});const read=n=>JSON.parse(readFileSync(join(directoryPath,n+'.json')));return {result,off:read('off'),active:read('active'),cleanup:read('cleanup'),approval:read('approval')};}
function database(t){
 const s=new DatabaseSync(':memory:');t.after(()=>s.close());
 const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
 s.exec(schema.slice(0,schema.indexOf('-- Fresh immutable text-only v6.')));
 const migration=readFileSync(new URL('../migrations/047_whatsapp_review_session.sql',import.meta.url),'utf8');s.exec(migration);s.exec(migration);s.exec(readFileSync(new URL('../migrations/048_whatsapp_review_r2_session.sql',import.meta.url),'utf8'));s.exec(readFileSync(new URL('../migrations/049_whatsapp_review_r3_session.sql',import.meta.url),'utf8'));
 return {sqlite:s,prepare(sql){const stmt=s.prepare(sql);let args=[];return {bind(...a){args=a;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:stmt.run(...args).changes}};}};},async batch(stmts){s.exec('BEGIN');try{const rows=[];for(const stmt of stmts)rows.push(await stmt.run());s.exec('COMMIT');return rows;}catch(e){s.exec('ROLLBACK');throw e;}}};
}
const runtime=(config,DB)=>voiceProfileEnvironment({...config.vars,DB,WHATSAPP_BOOKING_OPENAI_API_KEY:'sk-synthetic-test-only',SESSION_SECRET:'synthetic-only-session'});
test('RC3 OFF base generates complete v8 artifacts with isolation, explicit empty crons and unapproved manifest',t=>{
 const {result,off,active,cleanup,approval}=artifacts(t);
 assert.deepEqual(result,{prepared:true,approved:false,sourceSha256:sourceFingerprint(),networkCalls:0});
 assert.equal(approval.approved,false);assert.equal(approval.feesBounded,false);
 assert.equal(Object.keys(off.vars).length,52);
 assert.equal(Object.keys(off.vars).length+10+1,63,'all ten existing secrets plus the temporary key fit even Free');
 for(const config of [off,active,cleanup]){
  configSafe(config,approval);assert.deepEqual(config.triggers,{crons:[]});
  for(const k of ['AUTO_DRIVER_DISPATCH','ROUTE_OPTIMIZATION_PROVIDER','EMAIL_RECIPIENT_POLICY','EMAIL_RECIPIENT_ALLOWLIST','WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE','WHATSAPP_OPS_PAYMENT_TEMPLATE','WHATSAPP_BOOKING_VOICE_ENABLED','WHATSAPP_BOOKING_VOICE_APPROVED','WHATSAPP_BOOKING_VOICE_PROFILE'])assert.equal(config.vars[k],base().vars[k],k);
  for(const [k,v] of Object.entries(base().vars).filter(([k])=>!k.startsWith('WHATSAPP_BOOKING_')&&!['TWILIO_BOOKING_FROM','TWILIO_RECIPIENT_ALLOWLIST'].includes(k)))assert.equal(config.vars[k],v,k);
  assert.deepEqual(config.secrets,base().secrets);assert.deepEqual(config.ai,base().ai);
 }
 assert.equal(continuationIssuable({...off.vars},NOW),false,'real key is absent');
 assert.equal(continuationIssuable(runtime(off),NOW),true);
 assert.equal(bookingEnabled(runtime(off),NOW),false);
 assert.equal(continuationReady(runtime(active),NOW),true);
 assert.equal(bookingEnabled(runtime(active),NOW),true);
 assert.equal(bookingEnabled(runtime(active),NOW-1),false);
 assert.equal(bookingEnabled(runtime(active),plan.endsAt),false);
 assert.equal(continuationIssuable(runtime(cleanup),NOW),false);
 assert.equal(bookingEnabled(runtime(cleanup),NOW),false);
 assert.equal(approval.allocationMicros,220640);assert.equal(approval.retainedMicros,1748884);assert.equal(approval.transferredUnusedMicros,220640);assert.equal(approval.additionalUnallocatedMicros,0);assert.equal(approval.failedPreflightReservedMicros,112640);assert.equal(approval.endsAt-approval.startsAt,900000);assert.equal(off.vars.WHATSAPP_BOOKING_CONTINUATION_ID,CONTRACT.grantId);
});
test('generated config, exact migration047 and closed history issue one immutable v8 then stop without touching history',async t=>{
 const {off,active,cleanup,approval}=artifacts(t),DB=database(t);
 const keys=['WHATSAPP_BOOKING_PILOT_ID','TWILIO_ACCOUNT_SID','TWILIO_BOOKING_FROM','TWILIO_RECIPIENT_ALLOWLIST'];
 await prepareReviewR3Session(DB,NOW,{identity:Object.fromEntries(keys.map(k=>[k,runtime(off)[k]])),sourceSha256:approval.sourceSha256});
 const history=()=>JSON.stringify(['whatsapp_pilot_budgets','whatsapp_continuation_grants','whatsapp_continuation_followon_grants','whatsapp_continuation_retry_grants','whatsapp_continuation_sol_grants','whatsapp_continuation_voice_grants','whatsapp_voice_grants'].map(t=>DB.sqlite.prepare('SELECT * FROM '+t+' ORDER BY 1').all()));
 const before=history();
 // Deliberately use only generated vars plus fake secrets/DB: never merge fixture env.
 assert.equal(await issueContinuationGrant(runtime(off,DB),NOW),true);
 assert.equal(await issueContinuationGrant(runtime(off,DB),NOW),false);
 assert.equal(await continuationCanProceed(runtime(active,DB),NOW),true);
 assert.equal(await continuationCanProceed(runtime(active,DB),plan.endsAt),false);
 await stopContinuation(runtime(active,DB),'operator_stop');
 assert.equal(await continuationCanProceed(runtime(active,DB),NOW),false);
 assert.equal(await continuationCanProceed(runtime(cleanup,DB),NOW),false);
 assert.equal(history(),before);
 const g=DB.sqlite.prepare('SELECT * FROM whatsapp_continuation_review_r3_grants').get();
 assert.equal(g.id,CONTRACT.grantId);assert.equal(g.historical_micros,1025204);assert.equal(g.fee_cushion_micros,780000);assert.equal(g.spent_micros,0);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
});
test('missing booking prerequisites fail closed independently of preparation and runtime fixture defaults',t=>{
 const {off,active,approval}=artifacts(t);
 for(const k of ['WHATSAPP_BOOKING_REVIEW_PROFILE','WHATSAPP_BOOKING_STORAGE_READY']){
  const c=structuredClone(active);delete c.vars[k];assert.throws(()=>configSafe(c,approval),/booking_profile/);
  assert.equal(bookingEnabled(runtime({...active,vars:c.vars}),NOW),false,k);
 }
 for(const k of Object.keys(REVIEW_PROFILE_VALUES)){
  const c=structuredClone(active);c.vars[k]='off';assert.throws(()=>configSafe(c,approval),/booking_profile/);
  assert.equal(bookingEnabled(runtime(c),NOW),false,k);
 }
 for(const patch of [{WHATSAPP_BOOKING_REVIEW_PROFILE:'unknown'},{WHATSAPP_BOOKING_CONTINUATION_VERSION:'5'},{WHATSAPP_BOOKING_MODE:'full'},{WHATSAPP_BOOKING_VOICE_PROFILE:'v5-20261010'}]){
  const e=runtime({...active,vars:{...active.vars,...patch}});assert.equal(e.WHATSAPP_BOOKING_ENABLED,'off');assert.equal(bookingEnabled(e,NOW),false);
 }
 const legacy={WHATSAPP_BOOKING_ENABLED:'off'};assert.equal(reviewProfileEnvironment(legacy),legacy);
 assert.equal(off.vars.WHATSAPP_BOOKING_REVIEW_PROFILE,REVIEW_PROFILE_NAME);
});
test('cron schedules, email, dispatch, templates and voice cannot be inherited or enabled in any artifact',t=>{
 const b=base();verifyDeploymentSurface(b);
 for(const triggers of [undefined,{crons:['*/5 * * * *','17 2 * * *']},{crons:[],other:true}])assert.throws(()=>verifyDeploymentSurface({...b,triggers}),/surface/);
 for(const [k,v] of Object.entries({AUTO_DRIVER_DISPATCH:'on',ROUTE_OPTIMIZATION_PROVIDER:'google',EMAIL_RECIPIENT_POLICY:'all',EMAIL_RECIPIENT_ALLOWLIST:'test@example.test',WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE:'template',WHATSAPP_OPS_PAYMENT_TEMPLATE:'template',WHATSAPP_BOOKING_VOICE_ENABLED:'on',WHATSAPP_BOOKING_VOICE_APPROVED:'on',WHATSAPP_BOOKING_VOICE_PROFILE:'v5-20261010'})){
  const directoryPath=directory(t);assert.throws(()=>prepare({base:{...b,vars:{...b.vars,[k]:v}},plan,directory:directoryPath}),/isolation/);assert.deepEqual(readdirSync(directoryPath),[]);
 }
});
test('generated variable overflow and missing account metadata are refused before writing artifacts',t=>{
 for(const patch of [Object.fromEntries(Array.from({length:13},(_,i)=>['EXTRA_'+i,'x'])),{TWILIO_ACCOUNT_SID:''},{BOOKING_URL:'https://edenmish.com'}]){
  const directoryPath=directory(t);assert.throws(()=>prepare({base:{...base(),vars:{...base().vars,...patch}},plan,directory:directoryPath}));assert.deepEqual(readdirSync(directoryPath),[]);
 }
});

test('invalid compact profile also closes legacy paid readiness while no-profile legacy behavior is unchanged',t=>{
 const {off}=artifacts(t),legacy={...runtime(off),WHATSAPP_BOOKING_MODEL:'gpt-6-luna',WHATSAPP_BOOKING_READINESS_APPROVED:'on',WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED:'on',WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED:'on',WHATSAPP_BOOKING_READINESS_EXPIRES_AT:new Date(NOW+60000).toISOString()};
 delete legacy.WHATSAPP_BOOKING_REVIEW_PROFILE;
 assert.equal(lunaPilotCanRun(reviewProfileEnvironment(legacy),NOW,true),true);
 for(const patch of [{WHATSAPP_BOOKING_REVIEW_PROFILE:'unknown'},{WHATSAPP_BOOKING_REVIEW_PROFILE:REVIEW_PROFILE_NAME,WHATSAPP_BOOKING_CONTINUATION_VERSION:'5'},{WHATSAPP_BOOKING_REVIEW_PROFILE:REVIEW_PROFILE_NAME,WHATSAPP_BOOKING_PROVIDER:'meta'}]){
  const e=voiceProfileEnvironment({...legacy,...patch});
  assert.equal(lunaPilotCanRun(e,NOW,true),false);
  for(const k of ['WHATSAPP_BOOKING_READINESS_APPROVED','WHATSAPP_BOOKING_READINESS_ADDITIONAL_APPROVED','WHATSAPP_BOOKING_READINESS_QUOTE_V2_APPROVED','WHATSAPP_BOOKING_MODEL_EVAL_APPROVED','WHATSAPP_BOOKING_CONTINUATION_APPROVED'])assert.equal(e[k],'off',k);
 }
});
