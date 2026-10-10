import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {reasoningPlan,REASONING_CASES,handwrittenProposal} from '../scripts/evaluate-booking-reasoning.mjs';
import {runReasoningBatch,checkReasoningApproval} from '../scripts/run-booking-reasoning.mjs';
const now=Date.parse('2026-10-09T19:00:00Z');
const approve=()=>({batch:'edenmish-sol-reasoning-20261009-a',authorization:'human-proceed-2026-10-09',ceilingMicros:320000,
  manifestHash:createHash('sha256').update(JSON.stringify(reasoningPlan())).digest('hex')});
const result=(item,extra={})=>new Response(JSON.stringify({model:'gpt-6.1-sol',service_tier:'default',status:'completed',
  usage:{input_tokens:1000,output_tokens:300,total_tokens:1300,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:200}},
  output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(handwrittenProposal(item))}]}],...extra}));
async function setup(run){const dir=mkdtempSync(join(tmpdir(),'sol-eval-'));try{await run(join(dir,'ledger.jsonl'));}finally{rmSync(dir,{recursive:true,force:true});}}
const options=ledgerPath=>({approval:approve(),key:'sk-synthetic-mock-only',ledgerPath,clock:()=>now});
test('counting-free fixed batch reserves durably before every call, retains all holds and cannot replay',async()=>{
 await setup(async ledger=>{let calls=0;const opts=options(ledger);opts.fetchImpl=async(url,req)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(req.redirect,'manual');
  const entries=readFileSync(ledger,'utf8').trim().split('\n').map(JSON.parse);assert.equal(entries.at(-1).type,'reserve');assert.equal(entries.at(-1).micros,78848);
  const body=JSON.parse(req.body);assert.equal(body.max_output_tokens,3072);assert.equal(body.reasoning.effort,calls<2?'low':'medium');assert.ok(Buffer.byteLength(req.body)<=8192);
  return result(REASONING_CASES[calls++%2]);
 };
 const report=await runReasoningBatch(opts);assert.equal(calls,4);assert.equal(report.heldMicros,315392);assert.equal(report.remainingOriginalMicros,684708);assert.equal(report.stopped,null);
 assert.equal(report.handsetReady,false);assert.equal(report.countingCalls,0);assert.equal(report.qualityApproved,false);
 await assert.rejects(runReasoningBatch(opts),/EEXIST/);assert.equal(calls,4);
 assert.doesNotMatch(readFileSync(ledger,'utf8'),/sk-|Bearer|מפתחות|customer_message|summary/);
 });
});
test('expired approval, manifest change or insufficient ceiling does not touch network/ledger',async()=>{
 for(const approval of [{...approve(),ceilingMicros:319999},{...approve(),manifestHash:'changed'},{...approve(),authorization:'old'}]){
  await setup(async ledger=>{let calls=0;await assert.rejects(runReasoningBatch({...options(ledger),approval,fetchImpl:async()=>{calls++;}}));assert.equal(calls,0);});
 }
 assert.throws(()=>checkReasoningApproval(approve(),Date.parse('2026-10-10T00:00:00Z')));
});
test('provider refusal/incomplete/HTTP/usage/transport failure stops with one retained hold, no retry',async()=>{
 for(const factory of [()=>new Response('private body',{status:429}),()=>{throw new Error('private exception');},
  ()=>result(REASONING_CASES[0],{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),
  ()=>result(REASONING_CASES[0],{usage:null}),()=>result(REASONING_CASES[0],{service_tier:'priority'}),
  ()=>result(REASONING_CASES[0],{output:[{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'private refusal'}]}]}),
  ()=>new Response('x'.repeat(32769)),
 ])await setup(async ledger=>{let calls=0;const report=await runReasoningBatch({...options(ledger),fetchImpl:async()=>{calls++;return factory();}});
  assert.equal(calls,1);assert.equal(report.heldMicros,78848);assert.ok(report.stopped);assert.equal(report.results.length,1);assert.doesNotMatch(readFileSync(ledger,'utf8'),/private/);
 });
});
test('whole-response deadline stops even a mock transport that ignores abort',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});await setup(async ledger=>{let start;const started=new Promise(r=>start=r);let calls=0;
 const pending=runReasoningBatch({...options(ledger),fetchImpl:async()=>{calls++;start();return new Promise(()=>{});}});
 await started;t.mock.timers.tick(30000);const report=await pending;assert.equal(calls,1);assert.equal(report.stopped,'timeout');assert.equal(report.heldMicros,78848);
 });
});

test('fresh two-call proposal needs distinct post-stop approval and carries all historical holds',async()=>{
 const {reasoningRetestPlan}=await import('../scripts/evaluate-booking-reasoning.mjs');
 const plan=reasoningRetestPlan();assert.equal(plan.proposedReserveMicros,157696);assert.equal(plan.approvedCeilingMicros,null);
 const approval={batch:plan.batch,authorization:'human-explicit-retest-20261010-b',ceilingMicros:157696,
  manifestHash:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
 assert.throws(()=>checkReasoningApproval({...approval,authorization:'human-proceed-2026-10-09'},Date.parse('2026-10-10T09:00:00Z')));
 assert.throws(()=>checkReasoningApproval(approval,now));
 assert.throws(()=>checkReasoningApproval(approval,Date.parse('2026-10-11T00:00:00Z')));
 await setup(async ledger=>{const efforts=[];const report=await runReasoningBatch({...options(ledger),approval,clock:()=>Date.parse('2026-10-10T09:00:00Z'),fetchImpl:async(_url,request)=>{
  const body=JSON.parse(request.body);efforts.push(body.reasoning.effort);return result(REASONING_CASES[0]);
 }});
 assert.deepEqual(efforts,['low','medium']);assert.equal(report.heldMicros,157696);assert.equal(report.remainingOriginalMicros,763556);
 assert.equal(report.results.length,2);assert.ok(report.results.every(row=>Number.isInteger(row.modelRoundTripMs)&&Number.isInteger(row.validationMs)));
 const start=JSON.parse(readFileSync(ledger,'utf8').split('\n')[0]);assert.equal(start.priorTotalMicros,1078748);assert.equal(start.priorModelMicros,438848);
 });
});

test('description retest fits remaining cap, requests low then medium and rejects excess usage',async()=>{
 const {descriptionRetestPlan}=await import('../scripts/evaluate-booking-reasoning.mjs');
 const plan=descriptionRetestPlan();assert.equal(plan.proposedReserveMicros,77528);
 const approval={batch:plan.batch,authorization:'human-explicit-description-retest-20261010-c',ceilingMicros:78848,
  manifestHash:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
 const clock=()=>Date.parse('2026-10-10T09:00:00Z');
 assert.throws(()=>checkReasoningApproval({...approval,ceilingMicros:78849},clock()));
 assert.throws(()=>checkReasoningApproval(approval,now));
 await setup(async ledger=>{const efforts=[];const opts={...options(ledger),approval,clock,fetchImpl:async(_url,request)=>{
  const body=JSON.parse(request.body);efforts.push(body.reasoning.effort);assert.equal(body.max_output_tokens,1024);assert.ok(Buffer.byteLength(request.body)<=5000);
  return result(REASONING_CASES[0]);
 }};const report=await runReasoningBatch(opts);
 assert.deepEqual(efforts,['low','medium']);assert.equal(report.heldMicros,77528);assert.equal(report.remainingOriginalMicros,764876);
 await assert.rejects(runReasoningBatch(opts),/EEXIST/);
 });
 for(const extra of [{status:'incomplete'},{usage:{input_tokens:10001,output_tokens:300,total_tokens:10301,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}])
 await setup(async ledger=>{let calls=0;const report=await runReasoningBatch({...options(ledger),approval,clock,fetchImpl:async()=>{calls++;return result(REASONING_CASES[0],extra);}});
 assert.equal(calls,1);assert.equal(report.heldMicros,38764);assert.ok(report.stopped);
 });
});
