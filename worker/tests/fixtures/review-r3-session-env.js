import {prepareReviewR2Session} from './review-r2-session-env.js';
import {REVIEW_R3_PREFLIGHT} from '../../src/whatsapp-continuation.js';
export async function prepareReviewR3Session(DB,now,{proof='matched',proofLifetimeMs=3600000,identity={},sourceSha256='a'.repeat(64)}={}) {
 const oldSource='531f995ae64dd7f64f61fcebf864cfa68f2cf9b31f3e08a92c3a28a3a821682d';
 const e=await prepareReviewR2Session(DB,now-120000,{proof:'failed',identity,sourceSha256:oldSource});
 const created=now-60000;
 await DB.prepare('INSERT INTO whatsapp_review_r3_preflight(id,request_sha256,source_sha256,reserved_micros,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(REVIEW_R3_PREFLIGHT.id,REVIEW_R3_PREFLIGHT.requestHash,sourceSha256,56320,created,created+proofLifetimeMs).run();
 if(proof!=='pending')await DB.prepare('UPDATE whatsapp_review_r3_preflight SET status=?,finished_at=?,input_tokens=1000,cached_tokens=0,output_tokens=100,reasoning_tokens=0 WHERE id=?').bind(proof,created+100,REVIEW_R3_PREFLIGHT.id).run();
 return {...e,WHATSAPP_BOOKING_CONTINUATION_VERSION:'8',WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-8',WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+900000).toISOString(),WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256:sourceSha256,WHATSAPP_BOOKING_REVIEW_AUTHORIZATION:'release-smoke-022064-v3'};
}
