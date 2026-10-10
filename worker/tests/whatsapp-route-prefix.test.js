import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBookingProposal,createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {newBooking,advanceBooking} from '../src/whatsapp-booking.js';
import {REASONING_CASES,handwrittenProposal,reasoningRequest,reasoningUsage} from '../scripts/evaluate-booking-reasoning.mjs';
const now=Date.parse('2026-10-08T08:00:00Z'),item=REASONING_CASES[0];
function variant(pickup,dropoff,swap=false){const p=handwrittenProposal(item);for(const f of p.fields){if(f.field==='pickup'&&pickup)f.quote='מ'+f.quote;if(f.field==='dropoff'&&dropoff)f.quote='ל'+f.quote;}if(swap)for(const f of p.fields){if(f.field==='pickup')f.field='dropoff';else if(f.field==='dropoff')f.field='pickup';}return p;}
for(const [pickup,dropoff] of [[false,false],[true,false],[false,true],[true,true]]){
 test(`literal route prefixes included pickup=${pickup} destination=${dropoff} preserve raw evidence and normalize equally`,()=>{
  const raw=variant(pickup,dropoff),before=JSON.stringify(raw);let reason;
  const result=validateBookingProposal(raw,item.text,now,r=>reason=r);
  assert.deepEqual(result?.entries,item.expected);assert.equal(reason,undefined);assert.equal(JSON.stringify(raw),before);
 });
 test(`swapped route prefixes pickup=${pickup} destination=${dropoff} still rejected`,()=>{
  let reason;assert.equal(validateBookingProposal(variant(pickup,dropoff,true),item.text,now,r=>reason=r),null);assert.equal(reason,'route_role');
 });
}
const raw=fields=>({version:2,intent:'update',topic:null,clarify_field:null,fields:fields.map(([field,quote])=>({field,quote}))});
test('actual street-name letters are not stripped and bare pairs are not assigned roles by field names',()=>{
 const labelled='איסוף: משה שרת 10 תל אביב; מסירה: לביא 2 רמת גן';
 const fields=[['pickup','משה שרת 10 תל אביב'],['dropoff','לביא 2 רמת גן']];
 assert.deepEqual(validateBookingProposal(raw(fields),labelled,now)?.entries,fields);
 for(const text of ['משה שרת 10 תל אביב לביא 2 רמת גן','משה שרת 10 תל אביב; לביא 2 רמת גן']){
  let reason;assert.equal(validateBookingProposal(raw(fields),text,now,r=>reason=r),null);assert.equal(reason,'route_unmarked');
 }
});
test('separate English markers within exact quotes normalize but invented quotes/roles do not',()=>{
 const text='from Dizengoff 10 Tel Aviv to Bialik 2 Ramat Gan';
 assert.deepEqual(validateBookingProposal(raw([['pickup','from Dizengoff 10 Tel Aviv'],['dropoff','to Bialik 2 Ramat Gan']]),text,now)?.entries,[['pickup','Dizengoff 10 Tel Aviv'],['dropoff','Bialik 2 Ramat Gan']]);
 let reason;assert.equal(validateBookingProposal(raw([['pickup','from Bialik 2 Ramat Gan']]),text,now,r=>reason=r),null);assert.equal(reason,'quote_missing');
});
test('negation and alternatives keep their scope with prefix-inclusive quotes',()=>{
 for(const [text,fields,expected] of [
  ['not from Dizengoff 10 Tel Aviv but from Herzl 12 Tel Aviv',[['pickup','from Dizengoff 10 Tel Aviv']],'quote_negated'],
  ['from Dizengoff 10 Tel Aviv, or from Herzl 12 Tel Aviv',[['pickup','from Dizengoff 10 Tel Aviv']],'route_ambiguous'],
 ]){let reason;assert.equal(validateBookingProposal(raw(fields),text,now,r=>reason=r),null);assert.equal(reason,expected);}
 assert.deepEqual(validateBookingProposal(raw([['pickup','from Herzl 12 Tel Aviv']]),'not from Dizengoff 10 Tel Aviv but from Herzl 12 Tel Aviv',now)?.entries,[['pickup','Herzl 12 Tel Aviv']]);
});
test('prefixed proposal reaches canonical resolver as same proposed route; never skips choices or confirmation',async()=>{
 const lookups=[];const services={conversationModel:createOfflineBookingModel(async()=>variant(true,true)),
  resolveAddress:async value=>{lookups.push(value);return {error:'ambiguous',candidates:[{address:value.startsWith('בני')?'בני משה 16 תל אביב':'קריניצי 111 רמת גן',city:value.startsWith('בני')?'תל אביב':'רמת גן',lat:32.08,lng:34.78}]};},quote:async()=>({price:50,currency:'ILS',review:false})};
 const opts={now,phone:'+972541234567'};let state=(await advanceBooking(newBooking(),'start',services,opts)).state;
 let result=await advanceBooking(state,item.text,services,opts);state=result.state;
 assert.equal(state.phase,'address_choice');assert.equal(state.data.pickup,undefined);assert.equal(result.create,undefined);
 state=(await advanceBooking(state,'1',services,opts)).state;assert.equal(state.data.dropoff,undefined);
 state=(await advanceBooking(state,'1',services,opts)).state;
 assert.deepEqual(lookups,['בני מושה 16 תל אביב','קרינצקי 111 רמת גן']);assert.equal(state.address_confirmed,false);assert.equal(state.menu.kind,'schedule');assert.equal(state.data.when_hour,undefined);
});
test('low effort is serialized; zero reasoning usage stays zero while missing usage fails closed',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(reasoningRequest(item,'low'))).reasoning,{effort:'low'});
 const usage={input_tokens:871,output_tokens:98,total_tokens:969,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}};
 assert.equal(reasoningUsage(usage).reasoningTokens,0);assert.equal(reasoningUsage(usage).upperCostMicros,3474);
 assert.equal(reasoningUsage({...usage,output_tokens_details:{}}),null);
});

test('rejection evidence stores only bounded synthetic source spans, enabling precise offline reconstruction',async()=>{
 const {syntheticProposalEvidence,gradeReasoningResponse}=await import('../scripts/evaluate-booking-reasoning.mjs');
 const proposal=variant(true,true,true),data=syntheticProposalEvidence(item,proposal);
 for(const [i,field] of data.fields.entries())assert.equal(item.text.slice(field.sourceStart,field.sourceStart+field.sourceLength),proposal.fields[i].quote);
 assert.equal(syntheticProposalEvidence({...item,text:'private text'},proposal),null);
 const bad=syntheticProposalEvidence(item,{fields:[{field:'secret-invented-field',quote:'secret-invented-quote'}]});
 assert.deepEqual(bad.fields,[{field:null,sourceStart:null,sourceLength:null}]);assert.doesNotMatch(JSON.stringify(bad),/secret/);
 const response={model:'gpt-6.1-sol',service_tier:'default',status:'completed',usage:{input_tokens:871,output_tokens:98,total_tokens:969,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(proposal)}]}]};
 const grade=gradeReasoningResponse(item,response,null);assert.equal(grade.rejection,'route_role');assert.deepEqual(grade.evidence,data);assert.doesNotMatch(JSON.stringify(grade),/מפתחות|מבני|secret|quote/);
});

test('prefix-inclusive scoped replacements normalize without accepting the negated old address',()=>{
 const correction=REASONING_CASES[1],proposal=handwrittenProposal(correction);proposal.fields[0].quote='מ'+proposal.fields[0].quote;
 const before=JSON.stringify(proposal);assert.deepEqual(validateBookingProposal(proposal,correction.text,now)?.entries,correction.expected);assert.equal(JSON.stringify(proposal),before);
 let reason;assert.equal(validateBookingProposal(raw([['pickup','מבני משה 16 תל אביב']]),correction.text,now,r=>reason=r),null);assert.equal(reason,'quote_negated');
 const delivery='המסירה לא לביאליק 2 רמת גן אלא להרצל 12 תל אביב';
 assert.deepEqual(validateBookingProposal(raw([['dropoff','להרצל 12 תל אביב']]),delivery,now)?.entries,[['dropoff','הרצל 12 תל אביב']]);
});
