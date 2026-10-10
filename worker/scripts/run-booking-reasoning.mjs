// One approved synthetic batch. Never imports Worker bindings or live grants.
import {openSync,closeSync,writeFileSync,readFileSync,fsyncSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {REASONING_CASES,REASONING_LIMITS,DESCRIPTION_RETEST_LIMITS,descriptionRetestPlan,reasoningPlan,reasoningRetestPlan,reasoningRequest,gradeReasoningResponse} from './evaluate-booking-reasoning.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function checkReasoningApproval(approval,now=Date.now()) {
  const description=approval?.batch==='edenmish-sol-description-20261010-c';
  if(description){
    const plan=descriptionRetestPlan();
    if(approval.authorization!=='human-explicit-description-retest-20261010-c'||approval.ceilingMicros!==78848
      ||approval.manifestHash!==hash(plan)||new Date(now).toISOString().slice(0,10)!=='2026-10-10'
      ||plan.proposedReserveMicros>approval.ceilingMicros||plan.proposedReserveMicros>plan.originalRemainingMicros)
      throw new Error('Approval or immutable manifest invalid');
    return plan;
  }
  const retry=approval?.batch==='edenmish-sol-reasoning-20261009-b';
  const plan=retry?reasoningRetestPlan():reasoningPlan();
  if((retry?approval.authorization!=='human-explicit-retest-20261010-b':approval?.batch!=='edenmish-sol-reasoning-20261009-a'||approval?.authorization!=='human-proceed-2026-10-09')
    ||approval.ceilingMicros!==(retry?157696:320000)||approval.manifestHash!==hash(plan)
    ||new Date(now).toISOString().slice(0,10)!==(retry?'2026-10-10':'2026-10-09')
    ||plan.proposedReserveMicros>approval.ceilingMicros||plan.proposedReserveMicros>plan.originalRemainingMicros)
    throw new Error('Approval or immutable manifest invalid');
  return plan;
}
async function responseJson(response,signal) {
  if(!response.ok||!response.body||signal.aborted) throw new Error('http_or_abort');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>REASONING_LIMITS.responseBytes||signal.aborted){await reader.cancel();throw new Error('response_limit');}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function runReasoningBatch({approval,key,ledgerPath,fetchImpl=globalThis.fetch,clock=Date.now}) {
  const plan=checkReasoningApproval(approval,clock());
  const limits=plan.batch==='edenmish-sol-description-20261010-c'?DESCRIPTION_RETEST_LIMITS:REASONING_LIMITS;
  if(!/^sk-[A-Za-z0-9_-]{12,}$/.test(key||''))throw new Error('Hidden credential required');
  const fd=openSync(ledgerPath,'wx',0o600);let held=0;const results=[];
  const record=entry=>{writeFileSync(fd,JSON.stringify(entry)+'\n');fsyncSync(fd);};
  let stopped=null;
  try{
    record({type:'start',batch:approval.batch,manifestHash:approval.manifestHash,ceilingMicros:approval.ceilingMicros,
      priorTotalMicros:plan.priorTotalMicros??999900,priorModelMicros:plan.priorModelMicros??360000,reservationPerCallMicros:plan.generationReserveMicros,countingCalls:0});
    const dir=openSync(dirname(ledgerPath),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
    outer:for(const {effort,id} of plan.requests){
      const item=REASONING_CASES.find(item=>item.id===id);
      checkReasoningApproval(approval,clock());
      const body=JSON.stringify(reasoningRequest(item,effort,limits));
      if(held+plan.generationReserveMicros>approval.ceilingMicros)throw new Error('Budget exhausted');
      const sequence=results.length+1;
      record({type:'reserve',sequence,effort,id:item.id,micros:plan.generationReserveMicros});held+=plan.generationReserveMicros;
      const controller=new AbortController();let timer,headersMs=null,bodyMs=null;const started=performance.now();
      try{
        const timed=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},REASONING_LIMITS.timeoutMs);});
        const request=(async()=>{const response=await fetchImpl('https://api.openai.com/v1/responses',{
          method:'POST',redirect:'manual',signal:controller.signal,
          headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body});
          headersMs=Math.round(performance.now()-started);
          const parsed=await responseJson(response,controller.signal);bodyMs=Math.round(performance.now()-started);return parsed;})();
        const response=await Promise.race([request,timed]);
        const grade=gradeReasoningResponse(item,response,null,limits);
        const row={id:item.id,effort,...grade,latencyMs:Math.round(performance.now()-started),
          responseHeadersMs:headersMs,modelRoundTripMs:bodyMs,validationMs:Math.max(0,Math.round(performance.now()-started)-bodyMs)};
        results.push(row);record({type:'result',sequence,...row});
        if(grade.stop){stopped=grade.outcome;break outer;}
      }catch{
        stopped=controller.signal.aborted?'timeout':'transport_or_response';
        const row={id:item.id,effort,outcome:stopped,stop:true,latencyMs:Math.round(performance.now()-started)};
        results.push(row);record({type:'result',sequence,...row});break outer;
      }finally{clearTimeout(timer);controller.abort();}
    }
    const report={batch:approval.batch,model:REASONING_LIMITS.model,results,stopped,heldMicros:held,
      remainingOriginalMicros:plan.originalRemainingMicros-held,networkGenerationCalls:results.length,countingCalls:0,
      qualityApproved:false,handsetReady:false};
    record({type:'end',heldMicros:held,stopped,qualityApproved:false});return report;
  }finally{key=null;closeSync(fd);}
}
// Hidden helper sends credential on stdin; never argv, environment or persisted config.
export async function reasoningBatchMain(args) {
  if(args.length!==3||args[0]!=='--approved-manifest')throw new Error('Fixed approval manifest and ledger required');
  const approval=JSON.parse(readFileSync(args[1],'utf8'));checkReasoningApproval(approval);
  let key=readFileSync(0,'utf8').trim();
  try{const report=await runReasoningBatch({approval,key,ledgerPath:args[2]});console.log(JSON.stringify(report));}
  finally{key=null;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  reasoningBatchMain(process.argv.slice(2)).catch(()=>{console.error('Stopped; inspect sanitized ledger. No retry.');process.exitCode=1;});
