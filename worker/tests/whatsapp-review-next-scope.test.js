// Offline rehearsal for a proposed scope only. No live grant/config is created.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {advanceBooking,newBooking} from '../src/whatsapp-booking.js';
import {splitBookingReply} from '../src/whatsapp-booking-store.js';
import {createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
test('five exchanges retain partial details, choose a morning slot, ask missing address and hand off without Maps',async()=>{
 const text='אני צריך לשלוח מעטפה קטנה עם מסמכים מחר בבוקר.';let models=0;const replies=[];
 const services={multilingual:true,conversationModel:createOfflineBookingModel(request=>{
  models++;assert.equal(request.customer_message,text);return {version:4,intent:'update',fields:[{field:'size',quote:'מעטפה קטנה עם מסמכים'},{field:'schedule',quote:'מחר בבוקר'}],topic:null,clarify_field:null,reply_language:'he',reply_style:'brief'};
 }),resolveAddress:()=>assert.fail('No Maps in this proposed scope'),quote:()=>assert.fail('No quote'),order:()=>assert.fail('No order'),create:()=>assert.fail('No order')};
 const options={now:Date.parse('2026-10-12T07:00:00Z'),phone:'+972500000001',conversationOnly:true};let state=newBooking();
 async function turn(message){const r=await advanceBooking(state,message,services,options);state=r.state;assert.equal(r.create,undefined);replies.push(r.reply);return r;}
 await turn('היי');await turn('1');await turn(text);
 assert.equal(state.data.size,'small');assert.equal(state.data.notes,'מסמכים');assert.equal(state.data.pickup,undefined);assert.equal(state.menu.kind,'schedule');const slot=state.menu.slots[0];
 const choice=await turn('1');assert.equal(state.data.schedule,slot);assert.equal(state.data.when_date,'2026-10-13');assert.ok(state.data.when_hour<12);assert.match(choice.reply,/מאיפה.*לאסוף.*לאן.*למסור/u);assert.equal(state.data.pickup,undefined);
 await turn('נציג');assert.equal(state.phase,'handoff');assert.equal(models,1);assert.equal(replies.length,5);assert.equal(replies.reduce((n,r)=>n+splitBookingReply(r).length,0),5);
});
test('proposed fresh budget retains both failures and all cushions within original cap',()=>{
 const historical=1636244,failedR1=56320,failedR2=56320,retained=historical+failedR1+failedR2;
 const preflight=56320,model=56320,inbound=5*10300,outbound=5*11300,maps=0;
 const handset=model+inbound+outbound+maps,newAllocation=preflight+handset;
 assert.equal(retained,1748884);assert.equal(handset,164320);assert.equal(newAllocation,220640);assert.equal(retained+newAllocation,1969524);
 assert.equal(249920-newAllocation,29280);assert.equal(2000000-retained-newAllocation,29280+1196);
 assert.equal(retained+56320+249920-2000000,55124,'previous six-exchange/two-Maps trial no longer fits after another preflight');
});
