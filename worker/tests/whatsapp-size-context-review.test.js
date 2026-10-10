import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateBookingProposal,createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {advanceBooking,newBooking} from '../src/whatsapp-booking.js';
const cases=JSON.parse(readFileSync(new URL('./fixtures/whatsapp-size-context-review.json',import.meta.url)));
const now=Date.parse('2026-10-10T12:00:00Z');
const proposal=c=>({version:4,reply_style:'friendly',reply_language:c.language,intent:'update',fields:[{field:'size',quote:c.quote}],topic:null,clarify_field:null});
for(const c of cases){
 test(`review context ${c.id}: ${c.accept?'accept':'reject'} grounded quote`,()=>{
  const r=validateBookingProposal(proposal(c),c.text,now);
  if(c.accept){assert.ok(r);assert.deepEqual(r.entries.find(([k])=>k==='size'),['size',c.quote==='קטנה'?'קטנה':'small']);}
  else assert.equal(r,null);
 });
 test(`review context ${c.id}: typed draft is ${c.accept?'advanced':'unchanged'}`,async()=>{
  const services={multilingual:true,order:()=>assert.fail('no order'),conversationModel:createOfflineBookingModel(()=>proposal(c))};
  const options={now,phone:'+972541234567',conversationOnly:true};
  let r=await advanceBooking(newBooking(),'hello',services,options);r=await advanceBooking(r.state,'1',services,options);
  const previous=structuredClone(r.state.data);
  r=await advanceBooking(r.state,c.text,services,options);
  if(c.accept)assert.equal(r.state.data.size,'small');
  else assert.deepEqual(r.state.data,previous);
  assert.equal(r.create,undefined);
 });
}
