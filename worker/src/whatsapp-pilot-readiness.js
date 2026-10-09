import { createOpenAIBookingModel } from './whatsapp-booking-openai.js';
import { proposeBookingTurn } from './whatsapp-booking-model.js';
import { lunaPilotCanRun } from './whatsapp-pilot-budget.js';

// Fixed fictional/public examples only. No caller-supplied prompt, credentials,
// history or customer data. Every probe uses the SAME forthcoming pilot budget.
const CASES = {
  small_item: { text: 'I need to send my keys', check: p => p.intent === 'update'
    && p.entries.some(([field,value]) => field === 'size' && value === 'small')
    && p.entries.every(([field]) => ['size','notes'].includes(field)) },
  relative_time: { text: 'Please collect tomorrow morning', check: p => p.intent === 'update'
    && p.entries.length === 1 && p.entries[0][0] === 'schedule' && p.entries[0][1] === 'tomorrow morning' },
  public_route: { text: 'from tel aviv bni mosh 16 to ramat gan kernitzy 111 to Eden', check: p => p.intent === 'update'
    && p.entries.some(([k,v])=>k==='pickup' && v==='tel aviv bni mosh 16')
    && p.entries.some(([k,v])=>k==='dropoff' && v==='ramat gan kernitzy 111')
    && p.entries.some(([k,v])=>k==='dropoff_detail' && v==='Eden')
    && p.entries.every(([k])=>['pickup','dropoff','dropoff_detail'].includes(k)) },
  off_topic: { text: 'Who won the election?', check: p => p.intent === 'off_topic' },
};
export const LUNA_READINESS_CASES = Object.freeze(Object.keys(CASES));
const resultFor = row => ({ status: row.status === 'pending' ? 409 : 200,
  report: { case_id:row.readiness_case, passed:row.outcome==='valid_proposal',
    outcome:row.outcome || 'pending', elapsed_ms:row.elapsed_ms, http_status:row.http_status, replay:true } });
export async function runLunaPilotReadiness(env, caseId, { fetchImpl=globalThis.fetch, clock=Date.now } = {}) {
  if (caseId !== env.WHATSAPP_BOOKING_READINESS_CASE || !Object.hasOwn(CASES,caseId) || !lunaPilotCanRun(env,clock(),true)) return { status:404,report:{error:'disabled_or_unknown_case'} };
  const id=`${env.WHATSAPP_BOOKING_PILOT_ID}:readiness:${caseId}`;
  const prior=await env.DB.prepare('SELECT * FROM whatsapp_pilot_model_attempts WHERE id=?').bind(id).first();
  if(prior)return resultFor(prior);
  const item=CASES[caseId];
  let diagnostic;
  const adapter=createOpenAIBookingModel(env,{fetchImpl,clock,readiness:true,readinessCase:caseId,acceptProposal:item.check,onDiagnostic:d=>{diagnostic=d;}});
  if(!adapter)return {status:503,report:{error:'model_not_configured'}};
  await proposeBookingTurn(adapter,{phase:'collect',consent_at:clock(),language:'en',data:{}},item.text,clock());
  const completed=await env.DB.prepare('SELECT * FROM whatsapp_pilot_model_attempts WHERE id=?').bind(id).first();
  if(!completed)return {status:409,report:{error:'budget_busy_stopped_or_exhausted'}};
  return {...resultFor(completed),report:{...resultFor(completed).report,replay:false,diagnostic}};
}
