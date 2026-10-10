import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateBookingProposal,createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {advanceBooking,newBooking} from '../src/whatsapp-booking.js';
const cases=JSON.parse(readFileSync(new URL('./fixtures/whatsapp-size-context.json',import.meta.url)));
const now=Date.parse('2026-10-10T12:00:00Z');
const proposal=quote=>({version:4,reply_style:'friendly',reply_language:'he',intent:'update',fields:[{field:'size',quote}],topic:null,clarify_field:null});
for(const c of cases){
 for(const quote of ['מעטפה קטנה','קטנה'])test(`Claude ${c.id}: omitted context rejects ${quote}`,()=>{
  const reasons=[];
  assert.equal(validateBookingProposal(proposal(quote),c.text,now,r=>reasons.push(r)),null);
  assert.deepEqual(reasons,[c.reason]);
 });
 test(`Claude ${c.id}: typed turn never writes omitted size or item notes`,async()=>{
  const services={multilingual:true,order:()=>assert.fail('no order'),conversationModel:createOfflineBookingModel(()=>proposal('מעטפה קטנה'))};
  const options={now,phone:'+972541234567',conversationOnly:true};
  let r=await advanceBooking(newBooking(),'hello',services,options);r=await advanceBooking(r.state,'1',services,options);
  const previous=structuredClone(r.state.data);
  r=await advanceBooking(r.state,c.text,services,options);
  assert.deepEqual(r.state.data,previous);assert.equal(r.create,undefined);assert.notEqual(r.interpretation,'model_proposal');
 });
}
for(const text of ['מעטפה קטנה, או חבילה בינונית','מעטפה קטנה. במשקל 10.5 ק״ג','במשקל 10 קג מעטפה קטנה','מעטפה קטנה 10ק״ג','מעטפה קטנה — וכבדה','אין לי בכלל מעטפה קטנה','זו לא ממש מעטפה קטנה','מעטפה קטנה אין לי','מעטפה קטנה אלא חבילה בינונית'])test(`size context rejects qualifier: ${text}`,()=>{
 assert.equal(validateBookingProposal(proposal('מעטפה קטנה'),text,now),null);
});
for(const [text,quote] of [
 ['אפשר בעברית? אני רוצה לשלוח מעטפה קטנה.','מעטפה קטנה'],
 ['אין מעלית. אני רוצה לשלוח מעטפה קטנה.','מעטפה קטנה'],
 ['מעטפה קטנה. אין מעלית בכתובת האיסוף.','מעטפה קטנה'],
 ['לא מעטפה גדולה אלא מעטפה קטנה','מעטפה קטנה'],
 ['מעטפה קטנה לאיסוף מדיזנגוף 10 תל אביב','מעטפה קטנה'],
 ['מפתחות מדיזנגוף 10 תל אביב לביאליק 2 רמת גן','מפתחות'],
])test(`affirmative size context remains accepted: ${text}`,()=>{
 const r=validateBookingProposal(proposal(quote),text,now);assert.ok(r);assert.ok(r.entries.some(([key])=>key==='size'));assert.deepEqual(r.entries.find(([key])=>key==='notes'),['notes',quote]);
});
test('a bad size invalidates the entire proposal, including explicitly proposed notes',()=>{
 const raw=proposal('מעטפה קטנה');raw.fields.push({field:'notes',quote:'מעטפה קטנה'});
 assert.equal(validateBookingProposal(raw,'מעטפה קטנה במשקל 10 ק״ג',now),null);
});
