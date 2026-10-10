import {prepareSolSession} from './sol-session-env.js';
import {issueContinuationGrant,reserveContinuation,finishContinuation,REVIEW_PREFLIGHT} from '../../src/whatsapp-continuation.js';
export async function prepareReviewSession(DB,now,{proof='matched',proofLifetimeMs=3600000}={}) {
 const fourthAt=now-3600000,fifthAt=now-1800000;
 const e=await prepareSolSession(DB,fourthAt);
 if(!await issueContinuationGrant(e,fourthAt))throw Error('fixture fourth');
 Object.assign(e,{WHATSAPP_BOOKING_CONTINUATION_VERSION:'5',WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-5',WHATSAPP_BOOKING_CONTINUATION_VOICE_SCHEMA_READY:'on',WHATSAPP_BOOKING_CONTINUATION_START:new Date(fifthAt).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(fifthAt+900000).toISOString()});
 if(!await issueContinuationGrant(e,fifthAt))throw Error('fixture fifth');
 Object.assign(e,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
 for(let i=0;i<3;i++)await reserveContinuation(e,'inbound','in'+i,fifthAt);
 for(let i=0;i<3;i++){await reserveContinuation(e,'outbound','out'+i,fifthAt);await finishContinuation(e,'outbound','out'+i,{ok:true},fifthAt);}
 await reserveContinuation(e,'model','model',fifthAt);await finishContinuation(e,'model','model',{ok:false},fifthAt);
 await DB.prepare('INSERT INTO whatsapp_voice_grants(id,binding_hash,starts_at,expires_at,max_calls,approved_micros) VALUES(?,?,?,?,6,30000)').bind('synthetic-closed-audio','a'.repeat(64),fifthAt,fifthAt+900000).run();
 const created=now-60000;
 await DB.prepare('INSERT INTO whatsapp_review_preflight(id,request_sha256,source_sha256,reserved_micros,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(REVIEW_PREFLIGHT.id,REVIEW_PREFLIGHT.requestHash,'a'.repeat(64),56320,created,created+proofLifetimeMs).run();
 if(proof!=='pending')await DB.prepare('UPDATE whatsapp_review_preflight SET status=?,finished_at=?,input_tokens=1000,cached_tokens=0,output_tokens=100,reasoning_tokens=0 WHERE id=?').bind(proof,created+100,REVIEW_PREFLIGHT.id).run();
 return {...e,WHATSAPP_BOOKING_ENABLED:'off',WHATSAPP_BOOKING_SEND_ENABLED:'off',WHATSAPP_BOOKING_MODEL_ENABLED:'off',
  WHATSAPP_BOOKING_CONTINUATION_VERSION:'6',WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-6',WHATSAPP_BOOKING_CONTINUATION_REVIEW_SCHEMA_READY:'on',
  WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+900000).toISOString(),
  WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_VOICE_ENABLED:'off',WHATSAPP_BOOKING_VOICE_PROFILE:'off',WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256:'a'.repeat(64),WHATSAPP_BOOKING_REVIEW_AUTHORIZATION:'release-smoke-035-v1'};
}
