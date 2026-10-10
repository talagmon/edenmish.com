import {prepareContinuation} from './continuation-env.js';
import {issueContinuationGrant,reserveContinuation,finishContinuation} from '../../src/whatsapp-continuation.js';
export async function prepareSolSession(DB,now){
 const e=await prepareContinuation(DB,now-10800000);
 if(!await issueContinuationGrant(e,now-10800000))throw new Error('fixture first');
 for(const [version,at,ins] of [[2,now-7200000,4],[3,now-3600000,3]]){
  Object.assign(e,{WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',WHATSAPP_BOOKING_CONTINUATION_VERSION:String(version),WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-'+version,
   WHATSAPP_BOOKING_CONTINUATION_FOLLOWON_SCHEMA_READY:'on',WHATSAPP_BOOKING_CONTINUATION_RETRY_SCHEMA_READY:'on',WHATSAPP_BOOKING_FAILURE_NOTICE_POLICY:version===3?'one-shot-v1':'off',WHATSAPP_BOOKING_CONTINUATION_START:new Date(at).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(at+1800000).toISOString()});
  if(!await issueContinuationGrant(e,at))throw new Error('fixture grant');
  Object.assign(e,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
  for(let i=0;i<ins;i++)await reserveContinuation(e,'inbound','in'+i,at);
  for(let i=0;i<3;i++){await reserveContinuation(e,'outbound','out'+i,at);await finishContinuation(e,'outbound','out'+i,{ok:true},at);}
  await reserveContinuation(e,'model','model',at);await finishContinuation(e,'model','model',{ok:false},at);
 }
 return {...e,WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',WHATSAPP_BOOKING_MODEL:'gpt-6.1-sol',WHATSAPP_BOOKING_REASONING_EFFORT:'low',WHATSAPP_BOOKING_CONTINUATION_VERSION:'4',WHATSAPP_BOOKING_CONTINUATION_SOL_SCHEMA_READY:'on',
  WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-4',WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+900000).toISOString()};
}
