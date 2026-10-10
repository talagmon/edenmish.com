import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {Miniflare} from 'miniflare';
test('voice session quotas, concurrent duplicate, immutable history and exact expiry',async t=>{
const bundle=await build({stdin:{contents:`
import {prepareSolSession} from './tests/fixtures/sol-session-env.js';
import {issueContinuationGrant,continuationCanProceed,reserveContinuation,finishContinuation,VOICE_SESSION} from './src/whatsapp-continuation.js';
import {voiceBinding,voiceCanProceed} from './src/whatsapp-booking-audio.js';
export default {async fetch(req,{DB}){
const now=Date.parse('2026-10-10T12:00:00Z'),e=await prepareSolSession(DB,now-1800000);
if(!await issueContinuationGrant(e,now-1800000))throw Error('fourth');
Object.assign(e,{WHATSAPP_BOOKING_CONTINUATION_VERSION:'5',WHATSAPP_BOOKING_CONTINUATION_ID:e.WHATSAPP_BOOKING_PILOT_ID+':quote-v2-handset-5',WHATSAPP_BOOKING_CONTINUATION_VOICE_SCHEMA_READY:'on',WHATSAPP_BOOKING_CONTINUATION_START:new Date(now).toISOString(),WHATSAPP_BOOKING_CONTINUATION_END:new Date(now+900000).toISOString(),WHATSAPP_BOOKING_VOICE_ENABLED:'on',WHATSAPP_BOOKING_VOICE_APPROVED:'on',WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:'on',WHATSAPP_BOOKING_VOICE_GRANT_ID:'voice-session-20261010'});
const issued=await issueContinuationGrant(e,now),duplicate=await issueContinuationGrant(e,now);let frozen=false;try{await DB.prepare('UPDATE whatsapp_continuation_sol_grants SET inbound=1').run();}catch{frozen=true;}
await DB.prepare('INSERT INTO whatsapp_voice_grants(id,binding_hash,starts_at,expires_at,max_calls,approved_micros) VALUES(?,?,?,?,6,30000)').bind(e.WHATSAPP_BOOKING_VOICE_GRANT_ID,await voiceBinding(e),now,now+900000).run();
Object.assign(e,{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_SEND_ENABLED:'on',WHATSAPP_BOOKING_MODEL_ENABLED:'on'});
const ready=await continuationCanProceed(e,now),audioReady=await voiceCanProceed(e,now);
const usage={input_tokens:16384,output_tokens:1024,total_tokens:17408,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}};
const dup=await Promise.all([reserveContinuation(e,'inbound','same',now),reserveContinuation(e,'inbound','same',now)]),counts={inbound:dup.filter(Boolean).length};
for(const kind of ['inbound','outbound','address','model']){counts[kind]??=0;for(let i=counts[kind];i<VOICE_SESSION[kind]+2;i++){if(await reserveContinuation(e,kind,kind+i,now)){counts[kind]++;if(kind!=='inbound')await finishContinuation(e,kind,kind+i,{ok:true,usage:kind==='model'?usage:null},now);}}}
let audioCalls=0;for(let i=0;i<8;i++)try{await DB.prepare('INSERT INTO whatsapp_voice_attempts(event_key,grant_id,created_at) VALUES(?,?,?)').bind('event'+i,e.WHATSAPP_BOOKING_VOICE_GRANT_ID,now).run();audioCalls++;}catch{}
const grant=await DB.prepare('SELECT * FROM whatsapp_continuation_voice_grants').first();
return Response.json({issued,duplicate,frozen,ready,audioReady,counts,audioCalls,grant,expired:await continuationCanProceed(e,now+900000),audioExpired:await voiceCanProceed(e,now+900000),total:grant.spent_micros+280000});}};`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
const mf=new Miniflare({modules:true,compatibilityDate:'2024-11-01',script:bundle.outputFiles[0].text,d1Databases:['DB'],outboundService:()=>{throw Error('No paid requests');}});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
const r=await(await mf.dispatchFetch('http://localhost/check')).json();assert.equal(r.issued,true);assert.equal(r.duplicate,false);assert.equal(r.frozen,true);assert.equal(r.ready,true);assert.equal(r.audioReady,true);assert.deepEqual(r.counts,{inbound:24,outbound:24,address:4,model:12});assert.equal(r.audioCalls,6);assert.equal(r.expired,false);assert.equal(r.audioExpired,false);assert.equal(r.total,1602240);assert.ok(r.total<=1650000);assert.equal(r.grant.historical_micros,735124);
});
