import {createHash} from 'node:crypto';

export const SHUTDOWN_TARGET = Object.freeze({accountId:'00000000000000000000000000000000',
  worker:'synthetic-rehearsal-worker',databaseId:'00000000-0000-4000-8000-000000000000',
  queueId:'00000000000000000000000000000001',queueName:'synthetic-booking-queue',
  origin:'https://rehearsal.invalid'});
const MODEL_KEY='WHATSAPP_BOOKING_FULL_OPENAI_API_KEY';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw new Error(code)};
export const shutdownPlanHash=plan=>sha(plan);

// No CLI, environment/secret reads, global-fetch fallback, or automatic execution.
// A separately approved user-run loader must inject transport and existing authority.
export function createShutdownAdapters(plan,{fetcher,credentials,approvedPlanHash,executionApproved=false,clock=Date.now}={}) {
  if(!executionApproved||approvedPlanHash!==sha(plan)||typeof fetcher!=='function')fail('execution_not_bound_to_approval');
  if(!plan||plan.version!==1||Object.entries(SHUTDOWN_TARGET).some(([k,v])=>plan[k]!==v)
    ||!/^[a-z0-9-]{8,64}$/.test(plan.runId||'')||!/^[a-z0-9-]{8,64}$/.test(plan.grantId||'')
    ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(plan.activeVersionId||'')
    ||![plan.sourceSha256,plan.grantBindingSha256].every(x=>/^[a-f0-9]{64}$/.test(x||'')))fail('invalid_or_wrong_target');
  // Clone caller metadata; later mutation cannot redirect this closed request graph.
  plan=JSON.parse(JSON.stringify(plan));
  const cf=`https://api.cloudflare.com/client/v4/accounts/${plan.accountId}`;
  const script=`/workers/scripts/${plan.worker}`,d1=`/d1/database/${plan.databaseId}/query`,queue=`/queues/${plan.queueId}`;
  const entries=[],attempted=new Set();let writes=0,calls=0,verified=false;
  const record=(action,ok)=>entries.push({action,ok});
  async function request(action,method,path,body,{write=false,ops=false}={}) {
    // Reserve before I/O; an uncertain mutation cannot be silently replayed.
    if(calls>=20 || (write&&writes>=6))fail('shutdown_action_cap');
    if(write&&attempted.has(action))fail('mutation_already_attempted');
    if(write){attempted.add(action);writes++;}
    calls++;const index=entries.length;entries.push({action,ok:false});
    const authority=ops?credentials?.opsSession:credentials?.cloudflareToken;
    if(typeof authority!=='string'||!authority)fail('user_controlled_authority_missing');
    const headers=ops?{'X-Ops':authority,Origin:plan.origin}:{Authorization:`Bearer ${authority}`};
    headers.Accept='application/json';if(body!==undefined)headers['Content-Type']='application/json';
    try {
      const response=await fetcher((ops?plan.origin:cf)+path,{method,headers,redirect:'error',
        ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
      if(!response.ok)fail('shutdown_http_unconfirmed');
      const reader=response.body?.getReader();if(!reader)fail('shutdown_response_missing');
      let size=0,parts=[];for(;;){const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>65536){await reader.cancel();fail('shutdown_response_limit');}parts.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
      const data=JSON.parse(new TextDecoder().decode(bytes));
      if(!ops&&(data.success!==true||data.errors?.length))fail('shutdown_provider_unconfirmed');
      entries[index].ok=true;return ops?data:data.result;
    } catch {fail('shutdown_action_unconfirmed');}
  }
  async function query(action,sql,params,write=false) {
    const result=await request(action,'POST',d1,{sql,params},{write});
    if(!Array.isArray(result)||result.length!==1||result[0].success!==true)fail('d1_response_unconfirmed');
    return result[0].results||[];
  }
  async function ledger() {
    const rows=await query('read_stop_ledger',`SELECT
      (SELECT COUNT(*) FROM payment_rehearsal_runs WHERE id=?) AS run_exists,
      (SELECT stopped_at FROM payment_rehearsal_runs WHERE id=?) AS run_stopped,
      (SELECT COUNT(*) FROM whatsapp_full_booking_grants WHERE id=? AND binding_hash=?) AS grant_exists,
      (SELECT stopped_at FROM whatsapp_full_booking_grants WHERE id=? AND binding_hash=?) AS grant_stopped,
      (SELECT COUNT(*) FROM orders WHERE rehearsal_run_id=? AND shopify_draft_order_id IS NOT NULL AND payment_status NOT IN ('paid','refunded')) AS unpaid_invoice,
      (SELECT COUNT(*) FROM orders WHERE rehearsal_run_id=? AND rehearsal_closed_at IS NULL) AS archive_pending,
      (SELECT COUNT(*) FROM payment_rehearsal_runs WHERE id=? AND charge_attempt_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM orders WHERE rehearsal_run_id=? AND shopify_draft_order_id IS NOT NULL)) AS uncertain_checkout`,
      [plan.runId,plan.runId,plan.grantId,plan.grantBindingSha256,plan.grantId,plan.grantBindingSha256,
        plan.runId,plan.runId,plan.runId,plan.runId]);
    if(rows.length!==1||rows[0].run_exists!==1||rows[0].grant_exists!==1)fail('run_ledger_mismatch');
    const row=rows[0];
    if(!['unpaid_invoice','archive_pending','uncertain_checkout'].every(k=>Number.isSafeInteger(row[k])&&row[k]>=0)
      || !['run_stopped','grant_stopped'].every(k=>row[k]===null||(Number.isSafeInteger(row[k])&&row[k]>0)))fail('ledger_fields_missing');
    return row;
  }
  async function bindRuntime() {
    const settings=await request('read_runtime_bindings','GET',script+'/settings');
    const bindings=new Map((settings?.bindings||[]).map(b=>[b.name,b]));
    let run,full;try {
      run=JSON.parse(bindings.get('PAYMENT_REHEARSAL_CONFIG')?.text);
      full=JSON.parse(bindings.get('WHATSAPP_BOOKING_FULL_CONFIG')?.text);
    } catch {fail('runtime_binding_mismatch');}
    if(run.run_id!==plan.runId||full.grant_id!==plan.grantId||full.source_sha256!==plan.sourceSha256
      ||bindings.get('DB')?.id!==plan.databaseId||bindings.get('WHATSAPP_BOOKING_QUEUE')?.queue_name!==plan.queueName)
      fail('runtime_binding_mismatch');
    const deployment=await request('read_runtime_deployment','GET',script+'/deployments');
    const active=Array.isArray(deployment)?deployment[0]:deployment?.deployments?.[0];
    if(active?.versions?.length!==1||active.versions[0].version_id!==plan.activeVersionId
      ||active.versions[0].percentage!==100)fail('runtime_version_mismatch');
  }
  async function preflight() {await bindRuntime();await ledger();verified=true;}
  async function pauseQueue() {
    if(!verified)fail('preflight_required');
    const current=await request('read_queue','GET',queue);
    if(current?.queue_id!==plan.queueId||current.queue_name!==plan.queueName)fail('queue_identity_mismatch');
    if(current.settings?.delivery_paused!==true)
      await request('pause_queue','PUT',queue,{queue_name:plan.queueName,settings:{...current.settings,delivery_paused:true}},{write:true});
    const paused=await request('verify_queue_pause','GET',queue);
    if(paused?.queue_id!==plan.queueId||paused.queue_name!==plan.queueName||paused.settings?.delivery_paused!==true)fail('queue_pause_unconfirmed');
    return true;
  }
  async function stop(kind) {
    let authorityStopped=false;
    if(kind==='primary') {
      // Worker verifies these identifiers before any stop mutation. This path
      // does not depend on the Cloudflare control plane or its credentials.
      const scope={version:1,run_id:plan.runId,grant_id:plan.grantId,source_sha256:plan.sourceSha256,grant_binding_sha256:plan.grantBindingSha256};
      try {await request('ops_stop','POST','/api/ops/payment-rehearsal/stop',scope,{write:true,ops:true});}
      catch {record('stop_transport_uncertain',false);}
      try {
        const proof=await request('ops_stop_readback','GET','/api/ops/payment-rehearsal/stop-status?'+new URLSearchParams(scope),undefined,{ops:true});
        authorityStopped=proof.authority_stopped===true&&proof.run_id===plan.runId
          &&proof.grant_id===plan.grantId&&proof.source_sha256===plan.sourceSha256
          &&proof.grant_binding_sha256===plan.grantBindingSha256;
      } catch {record('ops_stop_readback_failed',false);}
      try {await preflight();}catch {record('cloudflare_queue_preflight_failed',false);}
    } else {
      await preflight();
      const now=clock();if(!Number.isSafeInteger(now)||now<=0)fail('invalid_clock');
      // Attempt each distinct stop once, even if the first response is lost.
      const updates=[['d1_stop_run','UPDATE payment_rehearsal_runs SET stopped_at=? WHERE id=? AND stopped_at IS NULL',[now,plan.runId]],
        ['d1_stop_full_grant',"UPDATE whatsapp_full_booking_grants SET stopped_reason='operator_stop',stopped_at=? WHERE id=? AND binding_hash=? AND stopped_reason IS NULL",[now,plan.grantId,plan.grantBindingSha256]]];
      for(const [action,sql,params] of updates)try {await query(action,sql,params,true);}catch {record(action+'_uncertain',false);}
      try {const row=await ledger();authorityStopped=Number(row.run_stopped)>0&&Number(row.grant_stopped)>0;}catch {record('stop_readback_failed',false);}
    }
    let queuePaused=false;try {queuePaused=await pauseQueue();}catch {record('queue_pause_failed',false);}
    return {authorityStopped,queuePaused,callbackVerified:false,flagsOffVerified:false,
      financialReconciliationRetained:true,complete:false,entries:entries.map(e=>({...e})),calls,writes};
  }
  async function removeTemporaryModelKey() {
    if(!verified)fail('preflight_required');
    await bindRuntime();const row=await ledger();
    if(!(Number(row.run_stopped)>0&&Number(row.grant_stopped)>0))fail('stop_not_verified');
    const names=await request('read_binding_names','GET',script+'/secrets');
    if(!Array.isArray(names))fail('secret_metadata_unconfirmed');
    if(names.some(n=>n.name===MODEL_KEY))await request('delete_temporary_model_binding','DELETE',script+'/secrets/'+MODEL_KEY,undefined,{write:true});
    const remaining=await request('verify_model_binding_removed','GET',script+'/secrets');
    if(!Array.isArray(remaining)||remaining.some(n=>n.name===MODEL_KEY))fail('model_binding_removal_unconfirmed');
    return {temporaryModelKeyRemoved:true,retainedSigningBindings:true};
  }
  async function closeExposure({browserCallbackReceipt,subscriptionRemovalReceipt,appReadbackReceipt}={}) {
    if(!verified)fail('preflight_required');
    await bindRuntime();const row=await ledger();
    if(!(Number(row.run_stopped)>0&&Number(row.grant_stopped)>0))fail('stop_not_verified');
    if(row.unpaid_invoice||row.uncertain_checkout||row.archive_pending)
      return {disabled:false,financialReconciliationRetained:true,reason:'financial_or_archive_work_pending'};
    // Browser coordinator owns Twilio callback save/reload; no assumed sender API.
    if(browserCallbackReceipt?.runId!==plan.runId||browserCallbackReceipt?.sender!=='whatsapp:+15550000001'
      ||browserCallbackReceipt.accountSid!=='AC00000000000000000000000000000000'
      ||browserCallbackReceipt.blankAfterReload!==true
      ||!plan.newSubscriptionId||subscriptionRemovalReceipt?.subscriptionId!==plan.newSubscriptionId
      ||subscriptionRemovalReceipt?.shopId!=='100000000001'
      ||subscriptionRemovalReceipt?.callbackUrl!==plan.origin+'/webhooks/shopify/rehearsal'
      ||subscriptionRemovalReceipt?.removedAfterReadback!==true
      ||appReadbackReceipt?.runId!==plan.runId||appReadbackReceipt?.archived!==true||appReadbackReceipt?.paymentVerified!==true)
      fail('external_cleanup_evidence_required');
    await request('disable_private_exposure','POST',script+'/subdomain',{enabled:false,previews_enabled:false},{write:true});
    const state=await request('verify_exposure_disabled','GET',script+'/subdomain');
    if(state?.enabled!==false||state?.previews_enabled!==false)fail('exposure_shutdown_unconfirmed');
    return {disabled:true,financialReconciliationRetained:false,financialRecordsDeleted:false};
  }
  return Object.freeze({stopPrimary:()=>stop('primary'),stopBackstop:()=>stop('backstop'),
    removeTemporaryModelKey,closeExposure,receipt:()=>({entries:entries.map(e=>({...e})),calls,writes})});
}
