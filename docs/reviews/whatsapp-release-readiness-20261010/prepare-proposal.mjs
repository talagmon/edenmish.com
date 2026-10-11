// Offline only: captures the runtime request builder using handwritten synthetic
// proposals. Does not accept credentials, send requests or reopen any grant.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createBookingModel,proposeBookingTurn,validateBookingProposal} from '../../../worker/src/whatsapp-booking-model.js';
import {newBooking} from '../../../worker/src/whatsapp-booking.js';
import {SOL_SESSION} from '../../../worker/src/whatsapp-continuation.js';
const now=Date.parse('2026-10-12T07:00:00Z');
const cases=[
 {id:'synthetic-complete-context-route-morning',text:'אני צריך לשלוח מעטפה קטנה עם מסמכים מבני מושה 16 תל אביב לקרינצקי 111 רמת גן מחר בבוקר לנועה. שמי יעל כהן, yael@example.com. באיסוף אצל השומר.',data:{},fields:[['size','מעטפה קטנה'],['notes','מסמכים'],['pickup','מבני מושה 16 תל אביב'],['dropoff','לקרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה'],['name','יעל כהן'],['email','yael@example.com'],['pickup_detail','אצל השומר']],expected:[['size','small'],['notes','מסמכים'],['pickup','בני מושה 16 תל אביב'],['dropoff','קרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה'],['name','יעל כהן'],['email','yael@example.com'],['pickup_detail','אצל השומר']]},
];
const requests=[];
for(const item of cases){
 let request;
 const state={...newBooking(),phase:'collect',consent_at:now,multilingual:true,language:'he',data:item.data};
 const adapter=createBookingModel(r=>{request=r;return {version:4,reply_style:'friendly',reply_language:'he',intent:'update',fields:item.fields.map(([field,quote])=>({field,quote})),topic:null,clarify_field:null};});
 let why;validateBookingProposal({version:4,reply_style:'friendly',reply_language:'he',intent:'update',fields:item.fields.map(([field,quote])=>({field,quote})),topic:null,clarify_field:null},item.text,now,r=>why=r,state.data);if(why)console.log('synthetic-rejection',why);
 const parsed=await proposeBookingTurn(adapter,state,item.text,now);
 assert.deepEqual(parsed?.entries,item.expected,item.id);
 const payload={model:'gpt-6.1-sol',store:false,service_tier:'default',reasoning:{effort:'low'},max_output_tokens:SOL_SESSION.outputTokens,instructions:request.instructions,input:[{role:'user',content:JSON.stringify({customer_message:request.customer_message,context:request.context,approved_facts:request.approved_facts})}],text:{format:{type:'json_schema',name:'booking_proposal',strict:true,schema:request.schema}}};
 const body=JSON.stringify(payload);assert.ok(Buffer.byteLength(body)<=SOL_SESSION.requestBytes);
 requests.push({id:item.id,syntheticState:state,expectedEntries:item.expected,payload,bodyBytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});
}
const proposal={status:'offline-proposal-not-approved',networkCalls:0,grantIssuable:false,now,requests,limits:{generations:1,retries:0,counting:0,inputAllowancePerCall:SOL_SESSION.inputTokens,outputIncludingReasoningPerCall:SOL_SESSION.outputTokens,requestBytes:SOL_SESSION.requestBytes,reserveMicros:SOL_SESSION.modelMicros},blockers:['new_explicit_approval','fresh_tariff_check','secure_ephemeral_key']};
writeFileSync(new URL('./provider-proposal.json',import.meta.url),JSON.stringify(proposal,null,2)+'\n');
console.log(JSON.stringify({syntheticCasesPassed:requests.length,requests:requests.map(({id,bodyBytes,sha256})=>({id,bodyBytes,sha256})),networkCalls:0}));
