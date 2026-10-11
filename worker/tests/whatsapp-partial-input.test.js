// Synthetic text/transcript contracts, not an LLM or transcription quality test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceBooking,newBooking,parseAddress} from '../src/whatsapp-booking.js';
import {createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
const now=Date.parse('2026-10-11T12:00:00Z');
const first='אני רוצה לשלוח מעטפה עם מסמכים מבני משה 16 תל אביב';
const second='לקריניצי 111 רמת גן בבוקר';
const update=fields=>({version:4,intent:'update',fields:fields.map(([field,quote])=>({field,quote})),topic:null,clarify_field:null,reply_language:'he',reply_style:'friendly'});
function service(){
 const requests=[];
 return {requests,multilingual:true,conversationModel:createOfflineBookingModel(request=>{
  requests.push(request);
  if(request.customer_message===first)return update([['size','מעטפה עם מסמכים'],['pickup','מבני משה 16 תל אביב']]);
  if(request.customer_message===second)return update([['dropoff','לקריניצי 111 רמת גן'],['schedule','בבוקר']]);
  throw Error('Unexpected synthetic interpretation');
 }),resolveAddress:async text=>({address:text.replace(/^ל(?=קריניצי)/u,''),city:parseAddress(text).delivery_city,lat:32.08,lng:34.78}),quote:async()=>assert.fail('No quote before missing details'),order:()=>assert.fail('No order'),create:()=>assert.fail('No creation')};
}
for(const inputKind of ['text','voice'])test(`partial ${inputKind==='voice'?'mock audio transcript':'free text'} retains details and asks only missing day/name`,async()=>{
 const services=service();const opts={now,phone:'+972500000001',conversationOnly:true};
 let r=await advanceBooking(newBooking(),'היי',services,opts);r=await advanceBooking(r.state,'1',services,opts);
 r=await advanceBooking(r.state,first,services,{...opts,inputKind});
 assert.equal(r.state.data.size,'small');assert.equal(r.state.data.notes,'מסמכים');assert.equal(r.state.data.pickup,'בני משה 16 תל אביב');
 assert.equal(r.state.data.dropoff,undefined);assert.match(r.reply,/לאן/);
 r=await advanceBooking(r.state,second,services,{...opts,inputKind});
 assert.equal(r.state.data.dropoff,'קריניצי 111 רמת גן');assert.equal(r.state.data.when_date,undefined);assert.equal(r.state.menu.kind,'schedule_day');
 const context=services.requests.at(-1).context;assert.ok(context.collected_fields.includes('pickup'));assert.ok(!context.missing_fields.includes('pickup'));
 // Date and time still selected explicitly in text; no day silently assumed.
 r=await advanceBooking(r.state,'2',services,opts);assert.equal(r.state.menu.kind,'schedule');
 const slot=r.state.menu.slots[0];r=await advanceBooking(r.state,'1',services,opts);
 assert.equal(r.state.data.schedule,slot);assert.equal(r.state.data.size,'small');assert.equal(r.state.data.notes,'מסמכים');
 assert.match(r.reply,/שם/);assert.equal(r.state.data.name,undefined);assert.equal(r.state.data.email,undefined);assert.equal(r.create,undefined);
 assert.equal(services.requests.length,2);
});
for(const inputKind of ['text','voice'])test(`no ${inputKind} interpretation before explicit consent`,async()=>{
 const services=service();const r=await advanceBooking(newBooking(),first,services,{now,phone:'+972500000001',conversationOnly:true,inputKind});
 assert.equal(r.state.phase,'consent');assert.equal(services.requests.length,0);assert.equal(r.state.data.pickup,undefined);
});
test('operator handoff pauses subsequent partial messages',async()=>{
 const services=service();const opts={now,phone:'+972500000001',conversationOnly:true};
 let r=await advanceBooking(newBooking(),'היי',services,opts);r=await advanceBooking(r.state,'1',services,opts);
 r=await advanceBooking(r.state,first,services,opts);const saved=structuredClone(r.state.data);
 r=await advanceBooking(r.state,'נציג',services,opts);assert.equal(r.state.phase,'handoff');
 r=await advanceBooking(r.state,second,services,opts);assert.equal(r.reply,null);assert.deepEqual(r.state.data,saved);assert.equal(services.requests.length,1);
});
