import {prepareReviewSession} from './review-session-env.js';
import {REVIEW_R2_PREFLIGHT} from '../../src/whatsapp-continuation.js';
export async function prepareReviewR2Session(DB,now,{proof='matched',proofLifetimeMs=3600000,identity={},sourceSha256='a'.repeat(64)}={}) {
 const oldSource='9463b47cce9e4ff77e49cb3640f6ae67789187f4d1a30630d14862b7a9de835f';
 const e=await prepareReviewSession(DB,now-120000,{proof:'failed',identity,sourceSha256:oldSource});
 const created=now-60000;
 await DB.prepare('INSERT INTO whatsapp_review_r2_preflight(id,request_sha256,source_sha256,reserved_micros,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(REVIEW_R2_PREFLIGHT.id,REVIEW_R2_PREFLIGHT.requestHash,sourceSha256,56320,created,created+proofLifetimeMs).run();
 if(proof!=='pending')await DB.prepare('UPDATE whatsapp_review_r2_preflight SET status=?,finished_at=?,input_tokens=1000,cached_tokens=0,output_tokens=100,reasoning_tokens=0 WHERE id=?').bind(proof,created+100,REVIEW_R2_PREFLIGHT.id).run();
 return {...e,WHATSAPP_BOOKING_CONTINUATION_VERSION:'7',WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-7',WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+900000).toISOString(),WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256:sourceSha256,WHATSAPP_BOOKING_REVIEW_AUTHORIZATION:'release-smoke-030624-v2'};
}
