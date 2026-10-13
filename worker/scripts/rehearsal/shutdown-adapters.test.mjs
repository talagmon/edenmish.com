import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createShutdownAdapters,SHUTDOWN_TARGET,shutdownPlanHash} from './shutdown-adapters.mjs';
const plan={version:1,...SHUTDOWN_TARGET,runId:'synthetic-shutdown-run',grantId:'synthetic-full-grant',
  sourceSha256:'a'.repeat(64),grantBindingSha256:'b'.repeat(64),newSubscriptionId:'gid://shopify/WebhookSubscription/123456',activeVersionId:'11111111-1111-4111-8111-111111111111'};
function fixture(options={}) {
  const calls=[];const state={run_exists:1,grant_exists:1,run_stopped:null,grant_stopped:null,
    unpaid_invoice:1,archive_pending:1,uncertain_checkout:0,queuePaused:false,modelPresent:true,exposure:true,...options.state};
  const fetcher=async(url,req)=>{
    const path=new URL(url).pathname,body=req.body?JSON.parse(req.body):null;
    calls.push({url,method:req.method,body});
    if(options.failAction?.(path,req,body))throw Error('synthetic sensitive provider exception');
    const ok=result=>Response.json({success:true,errors:[],result});
    if(path.endsWith('/settings'))return ok({bindings:[{name:'DB',id:plan.databaseId},{name:'WHATSAPP_BOOKING_QUEUE',queue_name:plan.queueName},
      {name:'PAYMENT_REHEARSAL_CONFIG',text:JSON.stringify({run_id:options.otherRun?'another-run':plan.runId})},
      {name:'WHATSAPP_BOOKING_FULL_CONFIG',text:JSON.stringify({grant_id:plan.grantId,source_sha256:plan.sourceSha256})}]});
    if(path.endsWith('/deployments'))return ok({deployments:[{versions:[{version_id:plan.activeVersionId,percentage:100}]}]});
    if(options.otherRun&&path.includes('/payment-rehearsal/stop'))return Response.json({error:'stop_scope_mismatch'},{status:409});
    if(path.endsWith('/payment-rehearsal/stop-status'))return Response.json({authority_stopped:!!(state.run_stopped&&state.grant_stopped),run_id:plan.runId,grant_id:plan.grantId,source_sha256:plan.sourceSha256,grant_binding_sha256:options.wrongBindingProof?'c'.repeat(64):plan.grantBindingSha256});
    if(path.endsWith('/payment-rehearsal/stop')){
      state.run_stopped=1;state.grant_stopped=1;
      if(options.uncertainOps)throw Error('synthetic response lost after accepted mutation');
      return Response.json({ok:true});
    }
    if(path.endsWith('/query')){
      if(body.sql.startsWith('UPDATE payment')){state.run_stopped=1;if(options.uncertainD1)throw Error('synthetic accepted D1 response lost');}
      if(body.sql.startsWith('UPDATE whatsapp'))state.grant_stopped=1;
      return ok([{success:true,results:body.sql.startsWith('SELECT')?[{...state}]:[]}]);
    }
    if(path.endsWith('/queues/'+plan.queueId)){
      if(req.method==='PUT'){assert.equal(body.settings.message_retention_period,300);assert.equal(body.settings.delivery_delay,5);state.queuePaused=true;}
      return ok({queue_id:plan.queueId,queue_name:options.otherQueue?'wrong-queue':plan.queueName,
        settings:{delivery_paused:state.queuePaused,message_retention_period:300,delivery_delay:5}});
    }
    if(path.endsWith('/secrets/WHATSAPP_BOOKING_FULL_OPENAI_API_KEY')){assert.equal(req.method,'DELETE');state.modelPresent=false;return ok(null);}
    if(path.endsWith('/secrets'))return ok([
      ...(state.modelPresent?[{name:'WHATSAPP_BOOKING_FULL_OPENAI_API_KEY',type:'secret_text'}]:[]),
      {name:'SHOPIFY_WEBHOOK_SECRET',type:'secret_text'},{name:'SESSION_SECRET',type:'secret_text'}]);
    if(path.endsWith('/subdomain')){
      if(req.method==='POST'){assert.deepEqual(body,{enabled:false,previews_enabled:false});state.exposure=false;}
      return ok({enabled:state.exposure,previews_enabled:state.exposure});
    }
    assert.fail('Unexpected API surface: '+path);
  };
  const adapter=createShutdownAdapters(plan,{fetcher,credentials:{cloudflareToken:'synthetic-cf',opsSession:'synthetic-ops'},
    executionApproved:true,approvedPlanHash:shutdownPlanHash(plan),clock:()=>1791788400000});
  return {adapter,state,calls};
}
test('unapproved or changed-account plans cannot send requests',()=>{
 assert.throws(()=>createShutdownAdapters(plan),/approval/);
 const wrong={...plan,accountId:'11111111111111111111111111111111'};
 assert.throws(()=>createShutdownAdapters(wrong,{fetcher:()=>assert.fail(),executionApproved:true,approvedPlanHash:shutdownPlanHash(wrong)}),/wrong_target/);
});
test('runtime mismatch performs no mutation',async()=>{
 const f=fixture({otherRun:true});const r=await f.adapter.stopPrimary();assert.equal(r.authorityStopped,false);
 assert.equal(f.state.run_stopped,null);assert.equal(f.state.grant_stopped,null);
 assert.equal(f.calls.some(c=>c.method==='PUT'||c.body?.sql?.startsWith('UPDATE')),false);
});
test('primary stop uses authenticated Ops, verifies ledgers and pauses only dedicated queue',async()=>{
 const f=fixture();const r=await f.adapter.stopPrimary();assert.equal(r.authorityStopped,true);assert.equal(r.queuePaused,true);
 assert.equal(r.complete,false);assert.equal(r.callbackVerified,false);assert.equal(r.flagsOffVerified,false);
 assert.equal(f.calls.filter(c=>new URL(c.url).host===new URL(plan.origin).host).length,2);
 assert.equal(f.calls.some(c=>/twilio|shopify|openai/.test(new URL(c.url).host)),false);
});
test('backstop uses only scoped D1 stops and queue pause, independently of Ops',async()=>{
 const f=fixture();const r=await f.adapter.stopBackstop();assert.equal(r.authorityStopped,true);assert.equal(r.queuePaused,true);
 assert.ok(f.calls.every(c=>new URL(c.url).host==='api.cloudflare.com'));
 const writes=f.calls.filter(c=>c.body?.sql?.startsWith('UPDATE'));assert.equal(writes.length,2);
 assert.ok(writes.every(c=>!/(budget|accounting|orders|price|paid)/i.test(c.body.sql)));
 assert.equal(writes[1].body.params.at(-1),plan.grantBindingSha256);
});
test('uncertain accepted Ops response is read back and never blindly retried',async()=>{
 const f=fixture({uncertainOps:true});const r=await f.adapter.stopPrimary();assert.equal(r.authorityStopped,true);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/stop')).length,1);
 const second=await f.adapter.stopPrimary();assert.equal(second.authorityStopped,true);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/stop')).length,1);
});
test('failed stop still attempts independent queue pause and reports incomplete authority',async()=>{
 const f=fixture({failAction:path=>path.endsWith('/stop')});const r=await f.adapter.stopPrimary();assert.equal(r.authorityStopped,false);assert.equal(r.queuePaused,true);
});
test('wrong queue identity cannot be mutated or reported paused',async()=>{
 const f=fixture({otherQueue:true});const r=await f.adapter.stopPrimary();assert.equal(r.queuePaused,false);
 assert.equal(f.calls.some(c=>c.method==='PUT'),false);
});
test('cleanup removes only temporary model binding and preserves signing/financial bindings',async()=>{
 const f=fixture();await f.adapter.stopPrimary();assert.equal((await f.adapter.removeTemporaryModelKey()).temporaryModelKeyRemoved,true);
 const deletes=f.calls.filter(c=>c.method==='DELETE');assert.equal(deletes.length,1);assert.match(deletes[0].url,/WHATSAPP_BOOKING_FULL_OPENAI_API_KEY$/);
 assert.equal(JSON.stringify(f.adapter.receipt()).includes('synthetic-cf'),false);
 assert.equal(JSON.stringify(f.adapter.receipt()).includes('synthetic-ops'),false);
});
test('unpaid, uncertain or unarchived checkout keeps financial callback exposure',async()=>{
 for(const state of [{unpaid_invoice:1,archive_pending:0},{unpaid_invoice:0,archive_pending:0,uncertain_checkout:1},{unpaid_invoice:0,archive_pending:1}]){
  const f=fixture({state});await f.adapter.stopPrimary();const r=await f.adapter.closeExposure();assert.equal(r.disabled,false);assert.equal(r.financialReconciliationRetained,true);
  assert.equal(f.calls.some(c=>c.url.endsWith('/subdomain')),false);
 }
});
test('resolved archive needs independent browser callback and app readback evidence before exposure closes',async()=>{
 const f=fixture({state:{unpaid_invoice:0,archive_pending:0}});await f.adapter.stopPrimary();
 await assert.rejects(f.adapter.closeExposure(),/evidence_required/);
 const r=await f.adapter.closeExposure({browserCallbackReceipt:{runId:plan.runId,sender:'whatsapp:+15550000001',blankAfterReload:true,accountSid:'AC00000000000000000000000000000000'},subscriptionRemovalReceipt:{subscriptionId:plan.newSubscriptionId,shopId:'100000000001',callbackUrl:plan.origin+'/webhooks/shopify/rehearsal',removedAfterReadback:true},appReadbackReceipt:{runId:plan.runId,archived:true,paymentVerified:true}});
 assert.equal(r.disabled,true);assert.equal(r.financialRecordsDeleted,false);
});

test('Ops authority stops even when Cloudflare control plane is unavailable',async()=>{
 const f=fixture({failAction:path=>path.endsWith('/settings')});const r=await f.adapter.stopPrimary();
 assert.equal(r.authorityStopped,true);assert.equal(r.queuePaused,false);
 assert.equal(f.calls.filter(c=>new URL(c.url).host===new URL(plan.origin).host).length,2);
});
test('backstop attempts both separate D1 stops even when first response is uncertain',async()=>{
 const f=fixture({uncertainD1:true});const r=await f.adapter.stopBackstop();
 assert.equal(f.calls.filter(c=>c.body?.sql?.startsWith('UPDATE payment')).length,1);
 assert.equal(f.calls.filter(c=>c.body?.sql?.startsWith('UPDATE whatsapp')).length,1);
 assert.equal(r.authorityStopped,true);assert.equal(r.queuePaused,true);
});
test('missing financial fields never permit exposure cleanup',async()=>{
 const f=fixture();await f.adapter.stopPrimary();delete f.state.unpaid_invoice;
 await assert.rejects(f.adapter.closeExposure(),/ledger_fields_missing/);
 assert.equal(f.calls.some(c=>c.url.endsWith('/subdomain')),false);
});

test('primary never certifies a different frozen grant binding when CF is unavailable',async()=>{
 const f=fixture({wrongBindingProof:true,failAction:path=>path.endsWith('/settings')});const r=await f.adapter.stopPrimary();
 assert.equal(r.authorityStopped,false);assert.equal(r.complete,false);
});
