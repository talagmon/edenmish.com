// v6 orchestration: pure policy + injected IO. No IO at import and no retries.
import {createHash} from 'node:crypto';
import {bookingModelEnvelope} from '../src/whatsapp-booking-openai.js';
import {validateBookingProposal} from '../src/whatsapp-booking-model.js';
import {solUsageUpperMicros,REVIEW_PREFLIGHT} from '../src/whatsapp-continuation.js';
export const CONTRACT=Object.freeze({id:REVIEW_PREFLIGHT.id,grantId:'edenmish-luna-pilot-20261009-a:quote-v2-handset-6',worker:'edenmish-ops-staging',database:'e1fcce7f-a232-4258-b181-f1ab17b25639',sender:'+97233826779'});
export const sha256=v=>createHash('sha256').update(v).digest('hex');
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const fail=reason=>{throw Object.assign(new Error(reason),{reason});};
export function verifyApproval(a,sourceHash,now,{window=false,cleanup=false}={}){
 if(!a||a.id!==CONTRACT.id||a.authorization!=='release-smoke-035-v1'||a.approved!==true
  ||a.sourceSha256!==sourceHash||!/^[a-f0-9]{64}$/.test(sourceHash)||a.originalCapMicros!==2000000||a.allocationMicros!==350000
  ||a.retainedMicros!==1636244||a.worker!==CONTRACT.worker||a.database!==CONTRACT.database||a.sender!==CONTRACT.sender
  ||!/^\+972\d{9}$/.test(a.recipient||'')||a.recipient===a.sender||a.recipient==='+972534058498'
  ||!integer(a.approvedAt,1,now)||!integer(a.approvalExpiresAt,a.approvedAt+1,a.approvedAt+86400000)
  ||(!cleanup&&now>=a.approvalExpiresAt)||a.feesBounded!==true||!integer(a.maxAdditionalMandatoryFeeMicros,0,780000)
  ||typeof a.feeEvidence!=='string'||!a.feeEvidence.trim()||a.feeEvidence.length>300)fail('approval_or_fees_unverified');
 if(window&&(!integer(a.startsAt,a.approvedAt,a.approvalExpiresAt)||a.endsAt!==a.startsAt+900000||a.endsAt>a.approvalExpiresAt))fail('window_unverified');
 return true;
}
export function verifyRequest(proposal){
 const request=proposal?.requests?.[0],body=JSON.stringify(request?.payload),p=request?.payload;
 if(proposal.requests?.length!==1||sha256(body)!==REVIEW_PREFLIGHT.requestHash||request.sha256!==REVIEW_PREFLIGHT.requestHash
  ||Buffer.byteLength(body)>8192||p.model!=='gpt-6.1-sol'||p.reasoning?.effort!=='low'||p.max_output_tokens!==1024
  ||p.service_tier!=='default'||p.store!==false||p.tools||p.previous_response_id)fail('request_unverified');
 return {request,body};
}
async function boundedJson(response){
 if(!response.ok){await response.body?.cancel();fail('http_error');}
 if(!response.body||Number(response.headers.get('content-length'))>32768){await response.body?.cancel();fail('response_size');}
 const reader=response.body.getReader();let size=0;const parts=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel();fail('response_size');}parts.push(value);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('response_json');}
 }finally{reader.releaseLock();}
}
// reserve is an exclusive durable INSERT. Unknown reservation/write stops forever.
export async function runPreflight({approval,sourceHash,proposal,key,io,clock=Date.now}){
 verifyApproval(approval,sourceHash,clock());const {request,body}=verifyRequest(proposal);
 if(!/^sk-[A-Za-z0-9_-]{12,}$/.test(key||''))fail('key_unverified');
 await io.assertOff(approval,sourceHash);
 const created=clock(),expires=Math.min(created+3600000,approval.approvalExpiresAt);
 if(expires-created<900000)fail('setup_window_short');
 const proof={id:CONTRACT.id,request_sha256:REVIEW_PREFLIGHT.requestHash,source_sha256:sourceHash,reserved_micros:56320,created_at:created,expires_at:expires};
 if(!await io.reserve(proof))fail('reservation_uncertain_no_retry');
 let status='failed',reason='transport_failure',usage=null,providerMs=null;const controller=new AbortController();
 const start=clock();let timer;
 try{
  await io.assertOff(approval,sourceHash);verifyApproval(approval,sourceHash,clock());
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('timeout'),{reason:'timeout'}));},10000);});
  const operation=(async()=>{const response=await io.fetch('https://api.openai.com/v1/responses',{method:'POST',redirect:'manual',signal:controller.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body});return boundedJson(response);})();
  const result=await Promise.race([operation,timeout]);providerMs=clock()-start;
  if(controller.signal.aborted||providerMs>=10000||clock()>=expires)fail('timeout');
  if(result.model!=='gpt-6.1-sol'||result.service_tier!=='default'||solUsageUpperMicros(result.usage)===null)fail('usage_unverified');
  usage=result.usage;let raw;try{raw=JSON.parse(bookingModelEnvelope(result));}catch(e){fail(e.category||'proposal_json');}
  let rejection;const text=JSON.parse(request.payload.input[0].content).customer_message;
  const accepted=validateBookingProposal(raw,text,proposal.now,r=>{rejection=r;},request.syntheticState.data);
  if(!accepted)fail(rejection?'proposal_rejected:'+rejection:'proposal_schema');
  const sort=rows=>JSON.stringify([...rows].sort(([a],[b])=>a.localeCompare(b)));
  if(raw.version!==4||!accepted.replyStyle||accepted.intent!=='update'||sort(accepted.entries)!==sort(request.expectedEntries)||accepted.replyLanguage!=='he')fail('semantic_mismatch');
  await io.assertOff(approval,sourceHash);status='matched';reason='all_expected_fields';
 }catch(e){reason=e.reason||e.category||'transport_failure';}
 finally{clearTimeout(timer);controller.abort();key=null;}
 const finished=clock(),record={status,finished_at:finished,input_tokens:usage?.input_tokens??null,cached_tokens:usage?.input_tokens_details?.cached_tokens??null,output_tokens:usage?.output_tokens??null,reasoning_tokens:usage?.output_tokens_details?.reasoning_tokens??null};
 if(finished>=expires){status='failed';reason='expired';record.status='failed';record.finished_at=null;}
 try{if(!await io.finish(record))fail('finish_unverified');}catch{status='pending';reason='finish_unverified_no_retry';}
 return {status,reason,providerLatencyMs:providerMs,endToEndMs:clock()-start,reservedMicros:56320,usage:record.input_tokens===null?null:{input:record.input_tokens,cached:record.cached_tokens,output:record.output_tokens,reasoning:record.reasoning_tokens},secretPersisted:false};
}
export function supervisionDecision(snapshot,now,window){
 const stop=reason=>({action:'stop',reason,deadline:window.endsAt});
 if(now>=window.endsAt)return stop('expired');
 if(!snapshot||snapshot.sourceVerified!==true||snapshot.configVerified!==true||snapshot.historyVerified!==true)return stop('verification_uncertain');
 const g=snapshot.grant,ops=snapshot.operations||[],replies=snapshot.replies||[];
 if(!g)return now<window.startsAt?{action:'wait',reason:'await_grant',deadline:window.startsAt}:stop('grant_missing');
 if(g.id!==CONTRACT.grantId||g.version!==6||g.starts_at!==window.startsAt||g.expires_at!==window.endsAt||g.historical_micros!==912564||g.historical_model_micros!==707864||g.fee_cushion_micros!==780000)return stop('binding_or_history_changed');
 const quotas={inbound:8,outbound:8,address:2,model:1},costs={inbound:10300,outbound:11300,address:32000,model:56320};
 if(!integer(g.spent_micros,0,293120)||!integer(g.model_micros,0,56320)||Object.entries(quotas).some(([k,max])=>!integer(g[k],0,max)))return stop('budget_invalid');
 if(ops.some(o=>o.grant_id!==g.id||!Object.hasOwn(costs,o.kind)||o.reserved_micros!==costs[o.kind]||!['settled','pending','uncertain'].includes(o.status)||!integer(o.created_at,g.starts_at,now))||new Set(ops.map(o=>o.id)).size!==ops.length||ops.reduce((n,o)=>n+o.reserved_micros,0)!==g.spent_micros||Object.keys(quotas).some(k=>ops.filter(o=>o.kind===k).length!==g[k])||g.model_micros!==g.model*56320)return stop('operation_accounting_invalid');
 if(g.stopped_reason){
  if(g.stopped_reason!=='model_uncertain')return stop('grant_stopped');
  const failed=ops.filter(o=>o.kind==='model'&&o.status==='uncertain');
  if(failed.length!==1||!integer(failed[0].finished_at,g.starts_at,now))return stop('failure_unverified');
  const end=Math.min(window.endsAt,failed[0].finished_at+30000),notice=ops.find(o=>o.id===g.id+':outbound:failure-notice');
  if(now>=end)return stop('notice_deadline');
  if(notice){if(notice.status!=='pending')return stop('notice_finished');
   if(g.lock_id!==notice.id||notice.outcome!=='notice_sending:'+failed[0].id.split(':model:')[1]+':0'||notice.created_at<failed[0].finished_at||notice.created_at>=failed[0].finished_at+15000||now>=notice.created_at+15000)return stop('notice_unverified');
  }else if(g.outbound>=8||g.spent_micros+11300>293120||g.lock_id!==null||now>=failed[0].finished_at+15000)return stop('notice_unavailable');
  return {action:'grace',reason:'fixed_notice_only',deadline:end};
 }
 if(now<window.startsAt)return {action:'wait',reason:'before_start',deadline:window.startsAt};
 if(ops.some(o=>o.status==='uncertain'))return stop('unexplained_uncertainty');
 const pending=ops.filter(o=>o.status==='pending');
 if(pending.length>1||pending.some(o=>g.lock_id!==o.id||now>=o.created_at+10000)||(!pending.length&&g.lock_id!==null))return stop('operation_timeout_or_lock');
 if(snapshot.handoff){
  const terminal=replies.filter(r=>r.kind==='handoff_ack');
  if(terminal.length!==1)return stop('handoff_without_reply');const r=terminal[0];
  if(['sent','failed','uncertain','cancelled'].includes(r.state))return stop('handoff_finished');
  if(!['pending','sending'].includes(r.state)||!integer(r.created_at,g.starts_at,now)||now>=r.created_at+10000)return stop('handoff_reply_deadline');
  if(r.state==='pending'&&g.outbound>=8)return stop('handoff_quota');
  return {action:'grace',reason:'existing_handoff_reply_only',deadline:Math.min(window.endsAt,r.created_at+10000)};
 }
 if(g.outbound>=8&&!pending.length)return stop('outbound_complete');
 return {action:'continue',reason:'active',deadline:window.endsAt};
}
export async function supervise({io,approval,sourceHash,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),watchdog=false}){
 verifyApproval(approval,sourceHash,clock(),{window:true,cleanup:true});let reason='read_uncertain';
 try{for(;;){const now=clock();await io.heartbeat({kind:watchdog?'watchdog':'primary',at:now,endsAt:approval.endsAt});
   if(now>=approval.endsAt){reason='expired';break;}
   if(watchdog){await sleep(Math.min(5000,approval.endsAt-now));continue;}
   const snapshot=await io.snapshot();
   const decision=supervisionDecision(snapshot,clock(),approval);
   if(decision.action==='stop'){reason=decision.reason;break;}
   await sleep(Math.max(0,Math.min(decision.action==='grace'?1000:5000,decision.deadline-clock())));
  }
 }catch{reason='read_or_heartbeat_uncertain';}
 const cleanup=await io.cleanup(reason);return {reason,...cleanup};
}
