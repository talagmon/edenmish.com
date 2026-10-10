import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {Miniflare} from 'miniflare';
const code=`
import worker from './src/index.js';import {makeSession} from './src/integrations.js';
import {prepareReviewSession} from './tests/fixtures/review-session-env.js';
import {voiceProfileEnvironment} from './src/whatsapp-booking-voice-profile.js';
import {issueContinuationGrant,continuationCanProceed,reserveContinuation,finishContinuation,stopContinuation,failureNoticeText,claimContinuationFailureNotice,continuationFailureNoticeCanSend,finishContinuationFailureNotice} from './src/whatsapp-continuation.js';
export default {async fetch(req,{DB}){
 let now=Date.now()+100;const originalNow=Date.now;Date.now=()=>now;
 try{
 const e=await prepareReviewSession(DB,now),mode=new URL(req.url).pathname;
 const tables=['whatsapp_pilot_budgets','whatsapp_pilot_model_attempts','whatsapp_continuation_grants','whatsapp_continuation_operations','whatsapp_continuation_followon_grants','whatsapp_continuation_followon_operations','whatsapp_continuation_retry_grants','whatsapp_continuation_retry_operations','whatsapp_continuation_sol_grants','whatsapp_continuation_sol_operations','whatsapp_continuation_voice_grants','whatsapp_continuation_voice_operations','whatsapp_voice_grants','whatsapp_voice_attempts'];
 const history=async()=>JSON.stringify(await Promise.all(tables.map(async t=>(await DB.prepare('SELECT * FROM '+t+' ORDER BY 1').all()).results)));
 const before=await history();const token=await makeSession(e);
 const request=()=>new Request('https://ops-staging.edenmish.com/api/ops/whatsapp/pilot/continuation/grant',{method:'POST',headers:{'X-Ops':token,'Content-Type':'application/json'},body:JSON.stringify({grant_id:e.WHATSAPP_BOOKING_CONTINUATION_ID,version:6})});
 const issued=(await worker.fetch(request(),e,{})).status,duplicate=(await worker.fetch(request(),e,{})).status;
 Object.assign(e,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});const env=voiceProfileEnvironment(e);
 const active=await continuationCanProceed(env,now),result={issued,duplicate,active,voice:env.WHATSAPP_BOOKING_VOICE_ENABLED,multilingual:env.WHATSAPP_BOOKING_MULTILINGUAL_ENABLED};
 if(mode==='/race'){
  const models=await Promise.all(['first','second','first'].map(k=>reserveContinuation(env,'model',k,now)));result.modelWinners=models.filter(Boolean).length;
  const key=models[0]?'first':'second';await finishContinuation(env,'model',key,{ok:true,usage:{input_tokens:1000,output_tokens:100,total_tokens:1100,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}},now);
  const inbound=await Promise.all(Array.from({length:20},(_,i)=>reserveContinuation(env,'inbound','in'+i,now)));result.inboundWinners=inbound.filter(Boolean).length;
  for(let i=0;i<7;i++){await reserveContinuation(env,'outbound','out'+i,now);await finishContinuation(env,'outbound','out'+i,{ok:true},now);}
  const outbound=await Promise.all(['last','last','excess'].map(k=>reserveContinuation(env,'outbound',k,now)));result.outboundWinners=outbound.filter(Boolean).length;
  result.grant=await DB.prepare('SELECT * FROM whatsapp_continuation_review_grants').first();
 }else if(mode==='/rollback'){
  await DB.prepare("CREATE TRIGGER fail_test BEFORE INSERT ON whatsapp_continuation_review_operations BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END").run();
  try{await reserveContinuation(env,'model','blocked',now);}catch{result.failed=true;}
  result.grant=await DB.prepare('SELECT * FROM whatsapp_continuation_review_grants').first();
 }else{
  const key='a'.repeat(64),reply=key+':0';await reserveContinuation(env,'model',key,now);await finishContinuation(env,'model',key,{ok:false},now);
  await DB.prepare("INSERT INTO whatsapp_booking_conversations(id,sender_key,provider,recipient,state_json,phase,order_token,created_at,updated_at) VALUES('test','test','twilio',?,?,'handoff','test',?,?)").bind(env.TWILIO_RECIPIENT_ALLOWLIST,JSON.stringify({language:'en',continuation_id:env.WHATSAPP_BOOKING_CONTINUATION_ID,conversation_only:true}),now,now).run();
  await DB.prepare("INSERT INTO whatsapp_booking_replies(id,conversation_id,body,state,kind,created_at) VALUES(?,'test',?,'sending','model_failure_notice',?)").bind(reply,failureNoticeText('en'),now).run();
  result.translationRejected=!await claimContinuationFailureNotice(env,reply,now);
  await DB.prepare('UPDATE whatsapp_booking_replies SET body=? WHERE id=?').bind(failureNoticeText('en',env),reply).run();
  const claims=await Promise.all([claimContinuationFailureNotice(env,reply,now),claimContinuationFailureNotice(env,reply,now)]);result.noticeWinners=claims.filter(Boolean).length;
  result.canSend=await continuationFailureNoticeCanSend(env,reply,now+14999);result.late=await continuationFailureNoticeCanSend(env,reply,now+15000);
  await stopContinuation(env,'operator_stop');result.stopped=await continuationFailureNoticeCanSend(env,reply,now);
  await finishContinuationFailureNotice(env,reply,true,now);result.notice=await DB.prepare("SELECT status FROM whatsapp_continuation_review_operations WHERE kind='outbound'").first();
 }
 result.historyUnchanged=before===await history();result.orders=(await DB.prepare('SELECT COUNT(*) n FROM orders').first()).n;return Response.json(result);
 }finally{Date.now=originalNow;}
}};`;
for(const mode of ['race','rollback','notice'])test('actual Worker entry + D1 v6 '+mode,async t=>{
 const bundle=await build({stdin:{contents:code,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:()=>{throw Error('no network');}});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));const r=await(await mf.dispatchFetch('http://localhost/'+mode)).json();
 assert.equal(r.issued,201);assert.equal(r.duplicate,409);assert.equal(r.active,true);assert.equal(r.voice,'off');assert.equal(r.multilingual,'on');assert.equal(r.historyUnchanged,true);assert.equal(r.orders,0);
 if(mode==='race'){assert.equal(r.modelWinners,1);assert.equal(r.inboundWinners,8);assert.equal(r.outboundWinners,1);assert.equal(r.grant.model,1);assert.equal(r.grant.outbound,8);}else if(mode==='rollback'){assert.equal(r.failed,true);assert.equal(r.grant.spent_micros,0);assert.equal(r.grant.model,0);assert.equal(r.grant.lock_id,null);}else{assert.equal(r.translationRejected,true);assert.equal(r.noticeWinners,1);assert.equal(r.canSend,true);assert.equal(r.late,false);assert.equal(r.stopped,false);assert.equal(r.notice.status,'uncertain');}
});
