// Provider-neutral synthetic preparation. No credentials/network in this module.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BOOKING_MODEL_INSTRUCTIONS, BOOKING_PROPOSAL_SCHEMA, BOOKING_FACTS,
  validateBookingProposal } from '../src/whatsapp-booking-model.js';
import { bookingModelEnvelope } from '../src/whatsapp-booking-openai.js';

export const EVAL_CLOCK = Date.parse('2026-10-08T08:00:00Z');
const freeze = value => { Object.values(value).forEach(v => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(value); };
export const REASONING_CASES = freeze([
  { id:'route-and-morning', phase:'collect', collected:[],
    text:'אני צריך לשלוח מפתחות מבני מושה 16 תל אביב לקרינצקי 111 רמת גן מחר בבוקר לנועה',
    fields:[['size','מפתחות'],['notes','מפתחות'],['pickup','בני מושה 16 תל אביב'],['dropoff','קרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה']],
    expected:[['size','small'],['notes','מפתחות'],['pickup','בני מושה 16 תל אביב'],['dropoff','קרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה']] },
  { id:'scoped-correction', phase:'review', collected:['size','notes','pickup','dropoff','schedule','dropoff_detail','name','email','pickup_detail'],
    text:'טעיתי, האיסוף לא מבני משה 16 תל אביב אלא מהרצל 12 תל אביב',
    fields:[['pickup','הרצל 12 תל אביב']], expected:[['pickup','הרצל 12 תל אביב']] },
]);
export const REASONING_LIMITS = freeze({ model:'gpt-6.1-sol', efforts:['low','medium'],
  inputTokens:16384, outputTokens:3072, requestBytes:8192, responseBytes:32768,
  countAllowanceTokens:0, timeoutMs:30000, generations:4, countingCalls:0,
  originalRemainingMicros:1000100, modelRemainingMicros:140000,
  // Model-page standard tariffs: input2, cache-write2.5, cached0.1, output10 USD/M.
  // Reserve all input at cache-write tariff plus 10% contingency; no cache credit.
  inputMicrosPerToken:2.5, outputMicrosPerToken:10, contingency:1.1,
});
export const handwrittenProposal = item => ({version:2,intent:'update',topic:null,clarify_field:null,
  fields:item.fields.map(([field,quote])=>({field,quote}))});
const fields = BOOKING_PROPOSAL_SCHEMA.properties.fields.items.properties.field.enum;
export function reasoningRequest(item, effort, limits = REASONING_LIMITS) {
  if (!REASONING_CASES.includes(item) || !REASONING_LIMITS.efforts.includes(effort)) throw new Error('Frozen synthetic case/config required');
  const request = {model:REASONING_LIMITS.model,store:false,service_tier:'default',reasoning:{effort},
    max_output_tokens:limits.outputTokens,instructions:BOOKING_MODEL_INSTRUCTIONS,
    input:[{role:'user',content:JSON.stringify({customer_message:item.text,approved_facts:BOOKING_FACTS,
      context:{phase:item.phase,language:'he',collected_fields:item.collected,
        missing_fields:fields.filter(f=>!item.collected.includes(f)),local_time:'2026-10-08 11:00',timezone:'Asia/Jerusalem'}})}],
    text:{format:{type:'json_schema',name:'booking_proposal',strict:true,schema:BOOKING_PROPOSAL_SCHEMA}}};
  if (Buffer.byteLength(JSON.stringify(request))>limits.requestBytes) throw new Error('Request size bound');
  return request;
}
export function reasoningPlan() {
  const l=REASONING_LIMITS;
  const generationReserveMicros=Math.ceil((l.inputTokens*5+l.outputTokens*20)*11/20);
  // No remote counting calls. Reserve at most one text token per payload UTF-8
  // byte, plus another full 8192 tokens for provider framing/schema overhead.
  // This is an engineering upper allowance, not a provider-enforced input limit.
  const countingAllowanceMicros=Math.ceil(l.countAllowanceTokens*55/20);
  const proposedReserveMicros=(generationReserveMicros+countingAllowanceMicros)*l.generations;
  const requests=l.efforts.flatMap(effort=>REASONING_CASES.map(item=>({id:item.id,effort,
    requestSha256:createHash('sha256').update(JSON.stringify(reasoningRequest(item,effort))).digest('hex')})));
  const sourceFiles=['../src/whatsapp-booking-model.js','../src/whatsapp-booking-diagnostics.js','../src/whatsapp-booking.js',
    '../src/whatsapp-booking-slots.js','../src/whatsapp-booking-text.js','../src/whatsapp-booking-route-evidence.js','../src/validate.js','./evaluate-booking-reasoning.mjs','./run-booking-reasoning.mjs'];
  const sourceHashes=sourceFiles.map(path=>({path,sha256:createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex')}));
  return {mode:'offline-preparation',model:l.model,efforts:l.efforts,requests,sourceHashes,
    generationCalls:l.generations,countingCalls:l.countingCalls,retries:0,inputTokens:l.inputTokens,outputTokens:l.outputTokens,
    totalGenerationInputTokens:l.inputTokens*l.generations,totalGeneratedTokensIncludingReasoning:l.outputTokens*l.generations,
    countingAllowanceTokens:l.countAllowanceTokens*l.countingCalls,generationReserveMicros,countingAllowanceMicros,
    proposedReserveMicros,originalRemainingMicros:l.originalRemainingMicros,modelRemainingMicros:l.modelRemainingMicros,
    modelShortfallMicros:Math.max(0,proposedReserveMicros-l.modelRemainingMicros),liveReady:false,networkCallsMade:0,
    blockers:['secure_key_handoff'],approvedCeilingMicros:320000,
    inputAccounting:'8192 payload bytes plus 8192 framing/schema token allowance; returned usage verified; not an exact tokenizer count',
    guardrails:['no tools','no store','default tier','no live grants','no retries','stop on incomplete/timeout/unknown usage','no partial JSON','no unapproved transcript']};
}
// Fresh proposal only. The stopped batch/manifest/ledger is never amended.
// Execution needs a separately recorded explicit post-stop approval and key.
export function reasoningRetestPlan() {
  const base=reasoningPlan();
  return {...base,mode:'post-stop-proposal',batch:'edenmish-sol-reasoning-20261009-b',
    requests:base.requests.filter(request=>request.id==='route-and-morning'),
    generationCalls:2,totalGenerationInputTokens:base.inputTokens*2,
    totalGeneratedTokensIncludingReasoning:base.outputTokens*2,
    proposedReserveMicros:base.generationReserveMicros*2,approvedCeilingMicros:null,
    priorTotalMicros:1078748,priorModelMicros:438848,originalRemainingMicros:921252,
    unusedComparisonAllocationMicros:241152,modelRemainingMicros:241152,modelShortfallMicros:0,
    blockers:['explicit_post_stop_batch_approval','new_ephemeral_key_handoff'],
    typicalReplyTargetMs:3000,whatsappLatencyMeasured:false,qualityApproved:false};
}
export const DESCRIPTION_RETEST_LIMITS = freeze({...REASONING_LIMITS,
  requestBytes:5000,inputTokens:10000,outputTokens:1024,generations:2});
export function descriptionRetestPlan() {
  const base=reasoningRetestPlan(), l=DESCRIPTION_RETEST_LIMITS;
  const generationReserveMicros=Math.ceil((l.inputTokens*5+l.outputTokens*20)*11/20);
  return {...base,batch:'edenmish-sol-description-20261010-c',
    requests:l.efforts.map(effort=>({id:REASONING_CASES[0].id,effort,
      requestSha256:createHash('sha256').update(JSON.stringify(reasoningRequest(REASONING_CASES[0],effort,l))).digest('hex')})),
    inputTokens:l.inputTokens,outputTokens:l.outputTokens,requestBytes:l.requestBytes,
    totalGenerationInputTokens:l.inputTokens*2,totalGeneratedTokensIncludingReasoning:l.outputTokens*2,
    generationReserveMicros,proposedReserveMicros:generationReserveMicros*2,
    priorTotalMicros:1157596,priorModelMicros:517696,originalRemainingMicros:842404,
    modelRemainingMicros:78848,unusedComparisonAllocationMicros:78848,
    inputAccounting:'5000 maximum payload bytes plus 5000 framing/schema token allowance; engineering allowance, not provider-enforced input limit',
    blockers:['ephemeral_key_handoff']};
}
export function reasoningUsage(usage, limits = REASONING_LIMITS) {
  const n=usage?.input_tokens,o=usage?.output_tokens,c=usage?.input_tokens_details?.cached_tokens,r=usage?.output_tokens_details?.reasoning_tokens;
  if (![n,o,c,r].every(Number.isSafeInteger)||n<0||o<0||c<0||r<0||c>n||r>o||n>limits.inputTokens||o>limits.outputTokens||usage.total_tokens!==n+o) return null;
  return {inputTokens:n,cachedTokens:c,outputTokens:o,reasoningTokens:r,
    // Includes reasoning in output exactly once. Cache writes cannot be inferred
    // from cached_tokens alone, so report a conservative cost, not invoice cost.
    upperCostMicros:Math.ceil((n*5+o*20)*11/20)};
}
const comparable=entries=>JSON.stringify([...entries].sort(([a],[b])=>a.localeCompare(b)));
// Fixed synthetic corpus only: retain bounded field/span metadata, never model
// output text, reasoning, arbitrary keys or invented quotes. This lets a reviewer
// reconstruct a rejected literal quote from the public synthetic fixture.
export function syntheticProposalEvidence(item,raw) {
  if(!REASONING_CASES.includes(item))return null;
  return {shapeValid:!!raw&&typeof raw==='object'&&!Array.isArray(raw),
    fieldCount:Array.isArray(raw?.fields)?Math.min(raw.fields.length,10):null,
    fields:Array.isArray(raw?.fields)?raw.fields.slice(0,9).map(entry=>{
      const field=fields.includes(entry?.field)?entry.field:null;
      const quote=entry?.quote;
      const start=typeof quote==='string'&&quote.length<=300?item.text.indexOf(quote):-1;
      return {field,sourceStart:start>=0?start:null,sourceLength:start>=0?quote.length:null};
    }):[]};
}
export function gradeReasoningResponse(item, result, countedInput, limits = REASONING_LIMITS) {
  const usage=reasoningUsage(result?.usage, limits);
  if (!usage||countedInput!=null&&usage.inputTokens!==countedInput||result.model!==REASONING_LIMITS.model||result.service_tier!=='default') return {outcome:'usage_unverified',stop:true};
  if (result.status==='incomplete') return {outcome:'incomplete',stop:true,usage};
  let raw;
  try { raw=JSON.parse(bookingModelEnvelope(result)); } catch { return {outcome:'response_envelope',stop:true,usage}; }
  let rejection=null;
  const proposal=validateBookingProposal(raw,item.text,EVAL_CLOCK,reason=>{rejection=reason;});
  if (!proposal) return {outcome:'proposal_rejected',rejection,stop:true,usage,evidence:syntheticProposalEvidence(item,raw)};
  const exact=proposal.intent==='update'&&proposal.topic===null&&proposal.clarifyField===null&&comparable(proposal.entries)===comparable(item.expected);
  const correctFields=proposal.entries.filter(([k,v])=>item.expected.some(([ek,ev])=>k===ek&&v===ev)).length;
  return {outcome:exact?'match':'semantic_mismatch',stop:!exact,usage,correctFields,expectedFields:item.expected.length,
    ...(!exact?{evidence:syntheticProposalEvidence(item,raw)}:{})};
}
// Mock execution never opens a connection. The separate runner owns approval,
// exclusive ledger reservations and ephemeral credential handling.
export async function runReasoningMock({responses,counts=Array(4).fill(1000)}={}) {
  const plan=reasoningPlan(),results=[];let index=0,stopped=false;
  for (const effort of REASONING_LIMITS.efforts) for (const item of REASONING_CASES) {
    if (stopped) break;
    reasoningRequest(item,effort);
    const count=counts[index],result=responses?.[index++];
    const graded=!Number.isSafeInteger(count)||count<1||count>REASONING_LIMITS.inputTokens
      ?{outcome:'input_limit',stop:true}:Buffer.byteLength(JSON.stringify(result??null))>REASONING_LIMITS.responseBytes
      ?{outcome:'response_limit',stop:true}:gradeReasoningResponse(item,result,count);
    results.push({id:item.id,effort,...graded,latencyMs:null});stopped=graded.stop;
  }
  const metrics=REASONING_LIMITS.efforts.map(effort=>{
    const rows=results.filter(r=>r.effort===effort),success=rows.length===2&&rows.every(r=>r.outcome==='match');
    const upperCostMicros=rows.reduce((n,r)=>n+(r.usage?.upperCostMicros??plan.generationReserveMicros),0);
    return {effort,cases:rows.length,matched:rows.filter(r=>r.outcome==='match').length,
      suppliedFields:rows.reduce((n,r)=>n+(r.correctFields||0),0),expectedFields:7,
      extractionScenarioSuccess:success,costPerSuccessfulScenarioMicros:success?upperCostMicros:null,
      clarificationQuality:'not_measured_by_two_turn_smoke',wholeConversationSuccess:null};
  });
  return {mode:'mock',networkCalls:0,results,metrics,stopped,qualityApproved:false};
}
export function reasoningMain(args,log=console.log) {
  if (args.length&&!(args.length===1&&args[0]==='--plan')) throw new Error('Offline plan only; paid execution unavailable');
  log(JSON.stringify(reasoningPlan(),null,2));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) reasoningMain(process.argv.slice(2));
